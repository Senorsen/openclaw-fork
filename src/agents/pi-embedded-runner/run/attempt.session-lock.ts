import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import {
  currentOwnedSessionFileGeneration,
  getOwnedSessionFileWrite,
  recordOwnedSessionFileWrite,
  sameOwnedSessionFileFingerprint,
} from "../../session-file-owned-writes.js";
import { isSessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type SessionEventProcessor = {
  _processAgentEvent?: (event: unknown) => Promise<void>;
  _extensionRunner?: {
    hasHandlers?: (eventType: string) => boolean;
  };
  __openclawSessionEventWriteLockInstalled?: boolean;
};

type SessionEventQueueOwner = {
  _agentEventQueue?: PromiseLike<unknown>;
};

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type SessionWithExternalHooks = SessionEventProcessor & {
  compact?: LockableFunction;
  agent?: {
    beforeToolCall?: LockableFunction;
    afterToolCall?: LockableFunction;
    onPayload?: LockableFunction;
    onResponse?: LockableFunction;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

type LockableFunction = ((...args: unknown[]) => unknown) & {
  __openclawSessionWriteLockInstalled?: boolean;
};

function sessionHasExtensionHandlers(session: SessionEventProcessor, eventType: string): boolean {
  const hasHandlers = session._extensionRunner?.hasHandlers;
  if (typeof hasHandlers !== "function") {
    return false;
  }
  try {
    return hasHandlers.call(session._extensionRunner, eventType);
  } catch {
    return true;
  }
}

function eventMayReachTranscriptWriters(session: SessionEventProcessor, event: unknown): boolean {
  const type = (event as { type?: unknown } | null)?.type;
  if (type === "message_update" || type === "message_end" || type === "agent_end") {
    return true;
  }
  if (typeof type !== "string") {
    return false;
  }
  return sessionHasExtensionHandlers(session, type);
}

function installLockableFunction(params: {
  owner: Record<string, unknown>;
  key: string;
  shouldLock: () => boolean;
  waitBeforeLock?: () => Promise<void>;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const current = params.owner[params.key] as LockableFunction | undefined;
  if (typeof current !== "function" || current.__openclawSessionWriteLockInstalled === true) {
    return;
  }
  const wrapped: LockableFunction = async function lockedExternalHook(
    this: unknown,
    ...args: unknown[]
  ) {
    if (!params.shouldLock()) {
      return await current.apply(this, args);
    }
    await params.waitBeforeLock?.();
    return await params.withSessionWriteLock(async () => await current.apply(this, args));
  };
  wrapped.__openclawSessionWriteLockInstalled = true;
  params.owner[params.key] = wrapped;
}

type SessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    };

function sameSessionFileFingerprint(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  if (!left || left.exists !== right.exists) {
    return false;
  }
  if (!left.exists || !right.exists) {
    return true;
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readSessionFileFingerprint(sessionFile: string): Promise<SessionFileFingerprint> {
  try {
    const stat = await fs.stat(sessionFile, { bigint: true });
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

/**
 * Upper bound for draining queued Pi session events. The drain only orders
 * transcript writes; it must never be able to hold a run (and its session
 * lane) forever. A queued event that is itself waiting on the caller would
 * otherwise deadlock the session until the process restarts.
 */
export const SESSION_EVENT_QUEUE_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Hard cap while the queue is busy with a live compaction. Compaction can
 * legitimately run for minutes on large transcripts, so the normal drain
 * timeout extends while Pi reports it is compacting, but never past this.
 */
export const SESSION_EVENT_QUEUE_COMPACTION_DRAIN_MAX_MS = 15 * 60_000;

export type SessionEventQueueWaitOptions = {
  timeoutMs?: number;
  maxCompactionWaitMs?: number;
  signal?: AbortSignal;
  onTimeout?: (info: { waitedMs: number; compacting: boolean }) => void;
};

async function waitForQueueBounded(
  queue: PromiseLike<unknown>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<"settled" | "timeout" | "aborted"> {
  if (signal?.aborted) {
    return "aborted";
  }
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve(queue).then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remainingMs);
        timer.unref?.();
      }),
      ...(signal
        ? [
            new Promise<"aborted">((resolve) => {
              onAbort = () => resolve("aborted");
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function waitForSessionEventQueue(
  session: unknown,
  options?: SessionEventQueueWaitOptions,
): Promise<void> {
  const owner = session as SessionEventQueueOwner;
  const startedAt = Date.now();
  const timeoutMs = Math.max(0, options?.timeoutMs ?? SESSION_EVENT_QUEUE_DRAIN_TIMEOUT_MS);
  const hardDeadlineMs =
    startedAt +
    Math.max(timeoutMs, options?.maxCompactionWaitMs ?? SESSION_EVENT_QUEUE_COMPACTION_DRAIN_MAX_MS);
  let deadlineMs = startedAt + timeoutMs;
  for (let attempts = 0; attempts < 6; ) {
    const queue = owner?._agentEventQueue;
    if (!queue || typeof queue.then !== "function") {
      return;
    }
    const outcome = await waitForQueueBounded(queue, deadlineMs, options?.signal);
    if (outcome === "aborted") {
      return;
    }
    if (outcome === "timeout") {
      const compacting = isSessionCompacting(session);
      if (compacting && Date.now() < hardDeadlineMs) {
        // A live compaction is still making progress inside the queue; keep
        // waiting in bounded slices so stop/abort can still interrupt us.
        deadlineMs = Math.min(hardDeadlineMs, Date.now() + timeoutMs);
        continue;
      }
      options?.onTimeout?.({ waitedMs: Date.now() - startedAt, compacting });
      return;
    }
    if (owner?._agentEventQueue === queue) {
      return;
    }
    attempts += 1;
  }
}

/**
 * True while Pi is running compaction (auto, manual, or branch summary). The
 * summarization request goes through `agent.streamFn`, but it is part of the
 * current turn's bookkeeping rather than a new model turn: auto-compaction is
 * started from inside the queued `agent_end` event, so draining that queue from
 * the stream wrapper would wait on itself.
 */
function isSessionCompacting(session: unknown): boolean {
  try {
    return (session as { isCompacting?: unknown } | null)?.isCompacting === true;
  } catch {
    return false;
  }
}

function resolveStreamAbortSignal(args: unknown[]): AbortSignal | undefined {
  const options = args[2] as { signal?: unknown } | null | undefined;
  const signal = options?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionFile: string) {
    super(`session file changed while embedded prompt lock was released: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export function installSessionEventWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionEventProcessor;
  const original = session._processAgentEvent;
  if (typeof original !== "function" || session.__openclawSessionEventWriteLockInstalled === true) {
    return;
  }
  session.__openclawSessionEventWriteLockInstalled = true;
  session._processAgentEvent = async function lockedProcessAgentEvent(
    this: unknown,
    event: unknown,
  ) {
    if (!eventMayReachTranscriptWriters(session, event)) {
      return await original.call(this, event);
    }
    return await params.withSessionWriteLock(async () => await original.call(this, event));
  };
}

export function installSessionExternalHookWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionWithExternalHooks;
  const agent = session.agent;
  if (agent) {
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "beforeToolCall",
      shouldLock: () => true,
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "afterToolCall",
      shouldLock: () => sessionHasExtensionHandlers(session, "tool_result"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onPayload",
      shouldLock: () => sessionHasExtensionHandlers(session, "before_provider_request"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onResponse",
      shouldLock: () => sessionHasExtensionHandlers(session, "after_provider_response"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
  }
  installLockableFunction({
    owner: session as Record<string, unknown>,
    key: "compact",
    shouldLock: () => true,
    waitBeforeLock: () => waitForSessionEventQueue(session),
    withSessionWriteLock: params.withSessionWriteLock,
  });
}

export type EmbeddedAttemptSessionLockController = {
  releaseForPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown, options?: SessionEventQueueWaitOptions): Promise<void>;
  withSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
  /**
   * Release the eagerly-held attempt lock if it is still held. Idempotent and
   * safe after cleanup took ownership; used from the attempt's outer finally so
   * an exception between prompt and cleanup cannot leak the session lock.
   */
  dispose(): Promise<void>;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  acquireSessionWriteLock: AcquireSessionWriteLock;
  lockOptions: LockOptions;
  /** Run abort signal; interrupts queued-event drains so stop never hangs. */
  abortSignal?: AbortSignal;
  onDrainTimeout?: (info: { waitedMs: number; compacting: boolean }) => void;
}): Promise<EmbeddedAttemptSessionLockController> {
  const acquireLock = async (): Promise<SessionLock> =>
    await params.acquireSessionWriteLock({
      sessionFile: params.lockOptions.sessionFile,
      timeoutMs: params.lockOptions.timeoutMs,
      staleMs: params.lockOptions.staleMs,
      maxHoldMs: params.lockOptions.maxHoldMs,
    });

  let heldLock: SessionLock | undefined = await acquireLock();
  const activeWriteLock = new AsyncLocalStorage<SessionLock>();
  let fenceFingerprint: SessionFileFingerprint | undefined;
  let fenceGeneration = 0;
  let fenceActive = false;
  let takeoverDetected = false;

  async function acquireWriteLock(): Promise<{ lock: SessionLock; owned: boolean }> {
    if (heldLock) {
      return { lock: heldLock, owned: false };
    }
    try {
      return { lock: await acquireLock(), owned: true };
    } catch (err) {
      if (isSessionWriteLockTimeoutError(err)) {
        takeoverDetected = true;
      }
      throw err;
    }
  }

  async function assertSessionFileFence(): Promise<void> {
    if (!fenceActive) {
      return;
    }
    const current = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(fenceFingerprint, current)) {
      return;
    }
    // Tolerate writes this process made under the session lock after the
    // fence was set (delivery mirrors, compaction notices). Only an unowned
    // change is a real takeover.
    const owned = getOwnedSessionFileWrite(params.lockOptions.sessionFile);
    if (
      owned &&
      owned.generation > fenceGeneration &&
      sameOwnedSessionFileFingerprint(owned.fingerprint, current)
    ) {
      fenceFingerprint = current;
      fenceGeneration = owned.generation;
      return;
    }
    takeoverDetected = true;
    throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
  }

  async function refreshSessionFileFence(): Promise<void> {
    if (takeoverDetected) {
      return;
    }
    const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    // Our own locked write: publish it so other in-process fences accept it.
    const generation = recordOwnedSessionFileWrite(params.lockOptions.sessionFile, fingerprint);
    if (fenceActive) {
      fenceFingerprint = fingerprint;
      fenceGeneration = generation;
    }
  }

  const noopLock: SessionLock = { release: async () => {} };

  return {
    async releaseForPrompt(): Promise<void> {
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      fenceGeneration = currentOwnedSessionFileGeneration();
      fenceFingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
      fenceActive = true;
      await lock.release();
    },
    waitForSessionEvents: async (session, options) =>
      await waitForSessionEventQueue(session, {
        ...options,
        signal: options?.signal ?? params.abortSignal,
        onTimeout: options?.onTimeout ?? params.onDrainTimeout,
      }),
    async withSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T> {
      if (takeoverDetected) {
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      if (activeWriteLock.getStore()) {
        return await run();
      }
      const { lock, owned } = await acquireWriteLock();
      try {
        await assertSessionFileFence();
        const runWithLock = async () => {
          const result = await run();
          await refreshSessionFileFence();
          return result;
        };
        if (owned) {
          return await activeWriteLock.run(lock, runWithLock);
        }
        return await runWithLock();
      } finally {
        if (owned) {
          await lock.release();
        }
      }
    },
    async acquireForCleanup(cleanupParams?: { session?: unknown }): Promise<SessionLock> {
      if (cleanupParams?.session) {
        await waitForSessionEventQueue(cleanupParams.session, {
          signal: params.abortSignal,
          onTimeout: params.onDrainTimeout,
        });
      }
      if (takeoverDetected) {
        return noopLock;
      }
      try {
        heldLock ??= await acquireLock();
      } catch (err) {
        if (isSessionWriteLockTimeoutError(err)) {
          takeoverDetected = true;
          return noopLock;
        }
        throw err;
      }
      const cleanupLock = heldLock;
      heldLock = undefined;
      try {
        await assertSessionFileFence();
      } catch (err) {
        await cleanupLock.release();
        if (err instanceof EmbeddedAttemptSessionTakeoverError) {
          return noopLock;
        }
        throw err;
      }
      return cleanupLock;
    },
    hasSessionTakeover(): boolean {
      return takeoverDetected;
    },
    async dispose(): Promise<void> {
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      await lock.release();
    },
  };
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (
    session: unknown,
    options?: SessionEventQueueWaitOptions,
  ) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
  onDrainTimeout?: (info: { waitedMs: number; compacting: boolean }) => void;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn.__openclawSessionLockPromptReleaseInstalled === true) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    if (isSessionCompacting(params.session)) {
      // Compaction summaries reuse agent.streamFn. Auto-compaction runs inside
      // the queued agent_end event (often under that event's write lock), so
      // draining the queue here would wait on ourselves, and releasing the
      // coarse lock would let the compaction entry land outside the fence.
      // Keep whatever lock the caller holds and submit directly.
      return await originalStreamFn(...args);
    }
    await params.waitForSessionEvents(params.session, {
      signal: resolveStreamAbortSignal(args),
      onTimeout: params.onDrainTimeout,
    });
    await params.releaseForPrompt();
    return await originalStreamFn(...args);
  };
  wrappedStreamFn.__openclawSessionLockPromptReleaseInstalled = true;
  agent.streamFn = wrappedStreamFn;
}
