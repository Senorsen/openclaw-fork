/**
 * Shared before_tool_call state for adjusted tool params.
 * The adapter and wrapper both consult this map so later execution can use the
 * normalized payload selected by hook processing.
 */
export const adjustedParamsByToolCallId = new Map<string, unknown>();
export const preExecutionBlockedToolCallIds = new Set<string>();
export const structuredReplaySafeToolCallIds = new Set<string>();

/**
 * Session ids whose current agent turn has been asked to stop (steer-driven).
 * Written by the embedded runner when a new inbound message steers a fixed stop
 * signal, read by the before_tool_call hook to veto any remaining pending tool
 * calls in the same turn. Kept here (a dependency-free leaf module) so runs.ts
 * and the before_tool_call hook can share it without a circular import.
 */
export const turnStopRequestedSessionIds = new Set<string>();

export function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

/** Consume and remove hook-adjusted params for a completed tool call. */
export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(key);
  adjustedParamsByToolCallId.delete(key);
  return params;
}

/** Snapshot hook-adjusted params without consuming later outcome bookkeeping. */
export function peekAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(key);
  return params === undefined ? undefined : structuredClone(params);
}

/** Consume whether policy prevented the target tool from starting. */
export function consumePreExecutionBlockedToolCall(toolCallId: string, runId?: string): boolean {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const blocked = preExecutionBlockedToolCallIds.has(key);
  preExecutionBlockedToolCallIds.delete(key);
  return blocked;
}

/** Mark a session's current turn as requested-to-stop (steer-driven). */
export function markTurnStopRequested(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  turnStopRequestedSessionIds.add(sessionId);
}

/** Whether the session's current turn has been asked to stop. */
export function isTurnStopRequested(sessionId: string): boolean {
  if (!sessionId) {
    return false;
  }
  return turnStopRequestedSessionIds.has(sessionId);
}

/** Clear the turn-stop flag for a session (call when a new turn starts/ends). */
export function clearTurnStopRequested(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  turnStopRequestedSessionIds.delete(sessionId);
}

export function recordStructuredReplaySafeToolCall(toolCallId: string, runId?: string): void {
  structuredReplaySafeToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
}

export function consumeStructuredReplaySafeToolCall(toolCallId: string, runId?: string): boolean {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const replaySafe = structuredReplaySafeToolCallIds.has(key);
  structuredReplaySafeToolCallIds.delete(key);
  return replaySafe;
}

/** Clear adjusted tool parameters between isolated tests. */
export function resetAdjustedParamsByToolCallIdForTests(): void {
  adjustedParamsByToolCallId.clear();
  preExecutionBlockedToolCallIds.clear();
  structuredReplaySafeToolCallIds.clear();
  turnStopRequestedSessionIds.clear();
}
