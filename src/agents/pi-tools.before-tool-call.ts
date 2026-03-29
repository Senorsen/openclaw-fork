import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionToolConstraints } from "../config/sessions/types.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  loopDetection?: ToolLoopDetectionConfig;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
let beforeToolCallRuntimePromise: Promise<
  typeof import("./pi-tools.before-tool-call.runtime.js")
> | null = null;

/**
 * Cache of tool constraints per session key.
 * Populated lazily from the session store on first access; TTL-based expiry
 * keeps it from growing unbounded or going stale.
 */
const toolConstraintsCache = new Map<
  string,
  { constraints: SessionToolConstraints | undefined; loadedAt: number }
>();
const TOOL_CONSTRAINTS_CACHE_TTL_MS = 30_000;
const MAX_TOOL_CONSTRAINTS_CACHE_SIZE = 128;

function loadToolConstraintsForSession(
  sessionKey: string | undefined,
): SessionToolConstraints | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const now = Date.now();
  const cached = toolConstraintsCache.get(sessionKey);
  if (cached && now - cached.loadedAt < TOOL_CONSTRAINTS_CACHE_TTL_MS) {
    return cached.constraints;
  }
  let constraints: SessionToolConstraints | undefined;
  try {
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    constraints = entry?.toolConstraints ?? undefined;
  } catch {
    constraints = undefined;
  }
  // Evict oldest if cache is at capacity.
  if (toolConstraintsCache.size >= MAX_TOOL_CONSTRAINTS_CACHE_SIZE) {
    const oldest = toolConstraintsCache.keys().next().value;
    if (oldest) {
      toolConstraintsCache.delete(oldest);
    }
  }
  toolConstraintsCache.set(sessionKey, { constraints, loadedAt: now });
  return constraints;
}

/**
 * Enforce tool-level constraints (allowedTools / deniedTools / browserProfile).
 * Returns a HookOutcome if the call should be blocked or params adjusted;
 * `null` means no constraint applies and the call should proceed as-is.
 */
function enforceToolConstraints(
  toolName: string,
  params: unknown,
  sessionKey: string | undefined,
): HookOutcome | null {
  const constraints = loadToolConstraintsForSession(sessionKey);
  if (!constraints) {
    return null;
  }
  const normalizedName = normalizeToolName(toolName);

  // --- allowedTools / deniedTools ---
  if (constraints.allowedTools && constraints.allowedTools.length > 0) {
    const allowed = new Set(constraints.allowedTools.map((t) => normalizeToolName(t)));
    if (!allowed.has(normalizedName)) {
      return {
        blocked: true,
        reason: `Tool "${toolName}" is not in the allowed tools list for this session. Allowed: ${constraints.allowedTools.join(", ")}`,
      };
    }
  }
  if (constraints.deniedTools && constraints.deniedTools.length > 0) {
    const denied = new Set(constraints.deniedTools.map((t) => normalizeToolName(t)));
    if (denied.has(normalizedName)) {
      return {
        blocked: true,
        reason: `Tool "${toolName}" is denied for this session.`,
      };
    }
  }

  // --- browserProfile enforcement ---
  if (constraints.browserProfile && normalizedName === "browser") {
    if (isPlainObject(params)) {
      const p = params as Record<string, unknown>;
      // Block target=node — force use of the specified profile instead.
      if (p.target === "node") {
        return {
          blocked: true,
          reason: `Browser target "node" (node browser proxy) is not allowed for this session. Use profile="${constraints.browserProfile}" instead.`,
        };
      }
      // Override/inject the profile parameter.
      return {
        blocked: false,
        params: { ...p, profile: constraints.browserProfile },
      };
    }
  }

  // --- allowedNodes / deniedNodes enforcement ---
  if (constraints.allowedNodes?.length || constraints.deniedNodes?.length) {
    if (isPlainObject(params)) {
      const p = params as Record<string, unknown>;
      // Extract the node identifier from tool params.
      // - browser: node param (only when target=node)
      // - read/write/edit: node param
      // - nodes: node param (for invoke and other actions)
      let targetNode: string | undefined;
      if (normalizedName === "browser") {
        if (p.target === "node" && typeof p.node === "string" && p.node.trim()) {
          targetNode = p.node.trim();
        }
      } else if (
        normalizedName === "read" ||
        normalizedName === "write" ||
        normalizedName === "edit" ||
        normalizedName === "nodes"
      ) {
        if (typeof p.node === "string" && p.node.trim()) {
          targetNode = p.node.trim();
        }
      }

      if (targetNode) {
        if (constraints.allowedNodes && constraints.allowedNodes.length > 0) {
          const allowed = new Set(constraints.allowedNodes.map((n) => n.toLowerCase()));
          if (!allowed.has(targetNode.toLowerCase())) {
            return {
              blocked: true,
              reason: `Node "${targetNode}" is not in the allowed nodes list for this session. Allowed: ${constraints.allowedNodes.join(", ")}`,
            };
          }
        }
        if (constraints.deniedNodes && constraints.deniedNodes.length > 0) {
          const denied = new Set(constraints.deniedNodes.map((n) => n.toLowerCase()));
          if (denied.has(targetNode.toLowerCase())) {
            return {
              blocked: true,
              reason: `Node "${targetNode}" is denied for this session.`,
            };
          }
        }
      }
    }
  }

  return null;
}

function loadBeforeToolCallRuntime() {
  beforeToolCallRuntimePromise ??= import("./pi-tools.before-tool-call.runtime.js");
  return beforeToolCallRuntimePromise;
}

function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  let params = args.params;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } =
      await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });

    const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      } else {
        const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
        if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
          log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
          logToolLoopAction({
            sessionKey: args.ctx.sessionKey,
            sessionId: args.ctx?.agentId,
            toolName,
            level: "warning",
            action: "warn",
            detector: loopResult.detector,
            count: loopResult.count,
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
          });
        }
      }
    }

    recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection);
  }

  // --- Tool constraints enforcement (subagent restrictions) ---
  const constraintOutcome = enforceToolConstraints(toolName, params, args.ctx?.sessionKey);
  if (constraintOutcome) {
    if (constraintOutcome.blocked) {
      return constraintOutcome;
    }
    // Constraints adjusted params (e.g. browser profile override).
    // Continue with modified params for downstream hooks.
    params = constraintOutcome.params;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const toolContext = {
      toolName,
      ...(args.ctx?.agentId ? { agentId: args.ctx.agentId } : {}),
      ...(args.ctx?.sessionKey ? { sessionKey: args.ctx.sessionKey } : {}),
      ...(args.ctx?.sessionId ? { sessionId: args.ctx.sessionId } : {}),
      ...(args.ctx?.runId ? { runId: args.ctx.runId } : {}),
      ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
    };
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
        ...(args.ctx?.runId ? { runId: args.ctx.runId } : {}),
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
      },
      toolContext,
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      if (isPlainObject(params)) {
        return { blocked: false, params: { ...params, ...hookResult.params } };
      }
      return { blocked: false, params: hookResult.params };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        const adjustedParamsKey = buildAdjustedParamsKey({ runId: ctx?.runId, toolCallId });
        adjustedParamsByToolCallId.set(adjustedParamsKey, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return result;
      } catch (err) {
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  buildAdjustedParamsKey,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
};
