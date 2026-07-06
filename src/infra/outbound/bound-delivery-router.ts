import { resolveConversationDeliveryTarget } from "../../utils/delivery-context.js";
import { normalizeConversationRef } from "./session-binding-normalization.js";
import {
  getSessionBindingService,
  type ConversationRef,
  type SessionBindingRecord,
  type SessionBindingService,
} from "./session-binding-service.js";

export type BoundDeliveryRouterInput = {
  eventKind: "task_completion";
  targetSessionKey: string;
  requester?: ConversationRef;
  failClosed: boolean;
};

export type BoundDeliveryRouterResult = {
  binding: SessionBindingRecord | null;
  mode: "bound" | "fallback";
  reason: string;
};

export type BoundDeliveryRouter = {
  resolveDestination: (input: BoundDeliveryRouterInput) => BoundDeliveryRouterResult;
};

function isActiveBinding(record: SessionBindingRecord): boolean {
  return record.status === "active";
}

export type FocusBindingDeliveryRoute = {
  channel: string;
  accountId?: string;
  to?: string;
  threadId?: string;
};

/**
 * Resolve the delivery route implied by a `/focus` conversation binding on a
 * target session, if (and only if) exactly one active binding exists.
 *
 * This is the outbound counterpart to the inbound `/focus` routing. When a chat
 * is `/focus`-bound to a session that has no external delivery route of its own
 * (e.g. `agent:main:main` bound from a Telegram DM), proactive/async turns that
 * run inside that session — cron reminders, heartbeat nudges, exec-event
 * notifications, subagent completion announces — otherwise have no idea which
 * external channel to deliver to and silently land only on the web surface.
 *
 * A single active binding is unambiguous and identifies exactly the `/focus`
 * origin to deliver to. Multiple bindings are ambiguous without a requester and
 * intentionally return `undefined` (callers keep their existing behavior).
 */
export function resolveFocusBindingDeliveryRoute(
  targetSessionKey: string,
  service: SessionBindingService = getSessionBindingService(),
): FocusBindingDeliveryRoute | undefined {
  const key = targetSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const activeBindings = service.listBySession(key).filter(isActiveBinding);
  if (activeBindings.length !== 1) {
    return undefined;
  }
  const binding = activeBindings[0];
  if (!binding) {
    return undefined;
  }
  const conversation = normalizeConversationRef(binding.conversation);
  if (!conversation.channel) {
    return undefined;
  }
  const conversationId = conversation.conversationId?.trim() ?? "";
  const parentConversationId = conversation.parentConversationId?.trim() ?? "";
  const target = resolveConversationDeliveryTarget({
    channel: conversation.channel,
    conversationId,
    parentConversationId,
  });
  const threadId =
    target.threadId ??
    (parentConversationId && parentConversationId !== conversationId ? conversationId : undefined);
  return {
    channel: conversation.channel,
    accountId: conversation.accountId,
    to: target.to,
    threadId,
  };
}

function resolveBindingForRequester(
  requester: ConversationRef,
  bindings: SessionBindingRecord[],
): SessionBindingRecord | null {
  const matchingChannelAccount = bindings.filter((entry) => {
    const conversation = normalizeConversationRef(entry.conversation);
    return (
      conversation.channel === requester.channel && conversation.accountId === requester.accountId
    );
  });
  if (matchingChannelAccount.length === 0) {
    return null;
  }

  const exactConversation = matchingChannelAccount.find(
    (entry) =>
      normalizeConversationRef(entry.conversation).conversationId === requester.conversationId,
  );
  if (exactConversation) {
    return exactConversation;
  }

  if (matchingChannelAccount.length === 1) {
    return matchingChannelAccount[0] ?? null;
  }
  return null;
}

export function createBoundDeliveryRouter(
  service: SessionBindingService = getSessionBindingService(),
): BoundDeliveryRouter {
  return {
    resolveDestination: (input) => {
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return {
          binding: null,
          mode: "fallback",
          reason: "missing-target-session",
        };
      }

      const activeBindings = service.listBySession(targetSessionKey).filter(isActiveBinding);
      if (activeBindings.length === 0) {
        return {
          binding: null,
          mode: "fallback",
          reason: "no-active-binding",
        };
      }

      if (!input.requester) {
        if (input.failClosed) {
          return {
            binding: null,
            mode: "fallback",
            reason: "missing-requester",
          };
        }
        if (activeBindings.length === 1) {
          return {
            binding: activeBindings[0] ?? null,
            mode: "bound",
            reason: "single-active-binding",
          };
        }
        return {
          binding: null,
          mode: "fallback",
          reason: "ambiguous-without-requester",
        };
      }

      const requester: ConversationRef = normalizeConversationRef(input.requester);
      if (!requester.channel || !requester.conversationId) {
        return {
          binding: null,
          mode: "fallback",
          reason: "invalid-requester",
        };
      }

      const fromRequester = resolveBindingForRequester(requester, activeBindings);
      if (fromRequester) {
        return {
          binding: fromRequester,
          mode: "bound",
          reason: "requester-match",
        };
      }

      if (activeBindings.length === 1 && !input.failClosed) {
        return {
          binding: activeBindings[0] ?? null,
          mode: "bound",
          reason: "single-active-binding-fallback",
        };
      }

      return {
        binding: null,
        mode: "fallback",
        reason: "no-requester-match",
      };
    },
  };
}
