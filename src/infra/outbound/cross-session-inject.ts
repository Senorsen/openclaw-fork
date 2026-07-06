import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { DmScope } from "../../config/types.base.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
} from "../../sessions/session-key-utils.js";
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

/**
 * Returns `true` when the *source* session that emitted this outbound message is
 * a human-facing conversation session (a real user chatting with the agent),
 * rather than an agent-to-agent or system-internal session.
 *
 * Cross-session inject only makes sense for the human case: a person talking to
 * the agent in session A causes the agent to message another peer B, and we want
 * B's next reply to "see" what was sent. It must NOT fire for:
 *  - subagent sessions (agent-to-agent / spawned worker traffic)
 *  - cron sessions (system-scheduled traffic)
 *  - ACP sessions (programmatic agent-control-protocol traffic)
 *
 * When the source session key is unknown/empty we conservatively treat it as
 * non-human (skip), because an unattributed send is more likely internal than a
 * genuine human-driven message.
 */
function isHumanSourceSession(sourceSessionKey: string | null | undefined): boolean {
  const key = sourceSessionKey?.trim();
  if (!key) {
    return false;
  }
  if (isSubagentSessionKey(key) || isCronSessionKey(key) || isAcpSessionKey(key)) {
    return false;
  }
  return true;
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
 * 1. `session.injectOutboundToTargetSession` **not** being explicitly `false`.
 *    The behaviour is **enabled by default** (undefined ⇒ on); set it to
 *    `false` in config only if you want to opt out.
 * 2. The *source* session being a human-facing conversation (not a
 *    subagent / cron / ACP session). Agent-to-agent and system-internal
 *    traffic never triggers an inject.
 * 3. `session.dmScope` being an isolated scope (per-peer / per-channel-peer /
 *    per-account-channel-peer).
 *
 * When all conditions are met the outbound text (or media summary) is appended
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

  // Enabled by default: only an explicit `false` opts out. This lets
  // human-driven cross-session context work without any config.
  if (cfg.session?.injectOutboundToTargetSession === false) {
    return { injected: false, reason: "disabled" };
  }

  // Only human-facing source sessions may inject. Skip agent-to-agent
  // (subagent) and system-internal (cron / ACP) traffic so automated sends
  // never pollute a human's session transcript.
  if (!isHumanSourceSession(sourceSessionKey)) {
    return { injected: false, reason: "non-human-source" };
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
