/**
 * In-process signal to suppress compaction for a single upcoming agent run that
 * was started by a subagent *steer* restart.
 *
 * Background (custom 5.18 fix):
 * When the main agent steers a subagent via `subagents(action="steer")`, the
 * framework aborts the subagent's active run and starts a *fresh* run carrying
 * the short steer message. Aborting the previous run marks the session's cached
 * token total as stale (`totalTokensFresh = false`), which forces the fresh
 * run's compaction gates onto a transcript-fallback estimate. That estimate can
 * over-count and trigger a full compaction even when real context usage is far
 * below the threshold (e.g. 100k / 600k), needlessly discarding context.
 *
 * A steer only injects a tiny message, so it must never be the thing that
 * triggers compaction. Because the steer call and the resulting agent run both
 * execute inside the same gateway process (in-process `callGateway` loopback),
 * we flag the target session here right before the steered run starts and have
 * the preflight-compaction and memory-flush gates honor the flag.
 *
 * Semantics: the flag is time-boxed (single steered turn). The steered run's
 * context-management phase always runs immediately after the steer (well within
 * the TTL), and both compaction gates within that turn check the flag. After the
 * TTL elapses the flag is inert, so it can never leak into a later,
 * organically-large turn on the same session.
 */

const STEER_SKIP_TTL_MS = 60_000;

/** sessionKey -> epoch ms after which the skip flag is no longer honored. */
const pendingSteerCompactionSkip = new Map<string, number>();

function normalizeKey(key: string | undefined | null): string | undefined {
  if (typeof key !== "string") {
    return undefined;
  }
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pruneExpired(now: number): void {
  if (pendingSteerCompactionSkip.size === 0) {
    return;
  }
  for (const [key, expiresAt] of pendingSteerCompactionSkip) {
    if (expiresAt <= now) {
      pendingSteerCompactionSkip.delete(key);
    }
  }
}

/**
 * Mark that compaction for the next steered turn on this session key should be
 * skipped. Called by the subagent steer path immediately before it starts the
 * fresh steered run.
 */
export function markSteerSkipPreflightCompaction(sessionKey: string | undefined | null): void {
  const key = normalizeKey(sessionKey);
  if (!key) {
    return;
  }
  const now = Date.now();
  pruneExpired(now);
  pendingSteerCompactionSkip.set(key, now + STEER_SKIP_TTL_MS);
}

/**
 * Non-consuming check: is the (unexpired) skip flag set for this session key?
 * Used by gates that run before the flag is finally cleared within the same
 * steered turn (e.g. the preflight-compaction gate, which runs just before the
 * memory-flush gate). Both gates read the same flag so a single steer suppresses
 * both compaction paths for that one turn.
 */
export function peekSteerSkipPreflightCompaction(sessionKey: string | undefined | null): boolean {
  const key = normalizeKey(sessionKey);
  if (!key) {
    return false;
  }
  const expiresAt = pendingSteerCompactionSkip.get(key);
  if (typeof expiresAt !== "number") {
    return false;
  }
  if (expiresAt <= Date.now()) {
    pendingSteerCompactionSkip.delete(key);
    return false;
  }
  return true;
}

/**
 * Check the skip flag and clear it. Returns true when the (unexpired) flag was
 * set. Called by the last compaction gate in the steered turn (memory flush) so
 * the flag does not linger past the turn it was meant for.
 */
export function consumeSteerSkipPreflightCompaction(
  sessionKey: string | undefined | null,
): boolean {
  const key = normalizeKey(sessionKey);
  if (!key) {
    return false;
  }
  const expiresAt = pendingSteerCompactionSkip.get(key);
  pendingSteerCompactionSkip.delete(key);
  return typeof expiresAt === "number" && expiresAt > Date.now();
}

/**
 * Drop a pending skip flag outright. Used to avoid leaking a flag when a steered
 * run fails to start.
 */
export function clearSteerSkipPreflightCompaction(sessionKey: string | undefined | null): void {
  const key = normalizeKey(sessionKey);
  if (!key) {
    return;
  }
  pendingSteerCompactionSkip.delete(key);
}
