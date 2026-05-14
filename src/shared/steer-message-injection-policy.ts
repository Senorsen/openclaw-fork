/**
 * Validates whether a steer message should be injected into an active run.
 * Centralizes size-limit and basic sanity checks so callers don't duplicate logic.
 */

export const MAX_INJECTED_STEER_MESSAGE_CHARS = 100_000;

export function validateSteerMessageInjection(params: {
  sessionId: string;
  text: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!params.text || params.text.length === 0) {
    return { ok: false, reason: "empty_message" };
  }
  if (params.text.length > MAX_INJECTED_STEER_MESSAGE_CHARS) {
    return { ok: false, reason: "message_too_large" };
  }
  return { ok: true };
}
