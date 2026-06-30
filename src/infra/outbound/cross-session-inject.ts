import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { DmScope } from "../../config/types.base.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("outbound/cross-session-inject");

/**
 * Returns `true` when the dmScope setting means each DM peer gets its own
 * isolated session transcript.
 */
function isIsolatedDmScope(dmScope: DmScope | undefined): boolean {
  return (
    dmScope === "per-peer" ||
    dmScope === "per-channel-peer" ||
    dmScope === "per-account-channel-peer"
  );
}

export type CrossSessionInjectParams = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
  accountId?: string | null;
  /** The target peer identifier (e.g. Telegram user id). */
  targetPeerId: string;
  /** The text the agent sent to the target. */
  text?: string;
  /** Media URLs included in the outbound message. */
  mediaUrls?: string[];
  /**
   * The session key of the *current* (source) session emitting this outbound
   * message. When the resolved target session key equals this, the target is
   * the agent's own session (e.g. DMing yourself), so the inject is skipped to
   * avoid double-writing the message into the same transcript.
   */
  sourceSessionKey?: string | null;
};

/**
 * After the message tool delivers an outbound message, optionally inject that
 * message into the *target user's* session transcript as an assistant message.
 *
 * This is gated on:
 * 1. `session.injectOutboundToTargetSession` being `true`
 * 2. `session.dmScope` being an isolated scope (per-peer / per-channel-peer /
 *    per-account-channel-peer).
 *
 * When both conditions are met the outbound text (or media summary) is appended
 * to the recipient's existing session file so the agent "remembers" what it said
 * the next time the recipient replies.
 *
 * **Limitation:** If the target user has never interacted with the agent (i.e.
 * no session exists yet), the inject is a no-op and a warning is logged. The
 * outbound context will not be available when the user eventually starts a
 * session.
 *
 * This function is fire-and-forget — it never throws and is safe to call with
 * `void` (no `await` needed).
 */
export async function maybeCrossSessionInject(
  params: CrossSessionInjectParams,
): Promise<{ injected: boolean; reason?: string }> {
  const { cfg, channel, agentId, accountId, targetPeerId, text, mediaUrls, sourceSessionKey } =
    params;

  if (!cfg.session?.injectOutboundToTargetSession) {
    return { injected: false, reason: "disabled" };
  }

  const dmScope = cfg.session?.dmScope;
  if (!isIsolatedDmScope(dmScope)) {
    return { injected: false, reason: "dmScope-not-isolated" };
  }

  if (!targetPeerId.trim()) {
    return { injected: false, reason: "missing-target-peer" };
  }

  const targetSessionKey = buildAgentPeerSessionKey({
    agentId,
    channel,
    accountId,
    peerId: targetPeerId,
    peerKind: "direct",
    dmScope,
  });

  // Skip self-targeting: if the resolved target session is the same as the
  // current (source) session (e.g. the agent DMing itself), the outbound text
  // is already recorded in this transcript via the normal send path. Injecting
  // again would double-write the same message.
  if (sourceSessionKey && sourceSessionKey.trim() === targetSessionKey) {
    log.debug("cross-session inject skipped (target is current session)", {
      channel,
      targetSessionKey,
    });
    return { injected: false, reason: "self-target" };
  }

  try {
    const result = await appendAssistantMessageToSessionTranscript({
      agentId,
      sessionKey: targetSessionKey,
      text,
      mediaUrls,
    });

    if (result.ok) {
      log.debug("injected outbound message into target session", {
        channel,
        targetSessionKey,
      });
      return { injected: true };
    }

    log.warn("cross-session inject skipped (target session does not exist yet)", {
      channel,
      targetSessionKey,
      reason: result.reason,
    });
    return { injected: false, reason: result.reason };
  } catch (err) {
    log.warn("cross-session inject failed", {
      channel,
      targetSessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return { injected: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
