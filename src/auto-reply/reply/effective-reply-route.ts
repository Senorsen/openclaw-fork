import type { SessionEntry } from "../../config/sessions/types.js";
import type { FinalizedMsgContext } from "../templating.js";

export type EffectiveReplyRouteContext = Pick<
  FinalizedMsgContext,
  "Provider" | "OriginatingChannel" | "OriginatingTo" | "AccountId"
>;

export type EffectiveReplyRouteEntry = Pick<
  SessionEntry,
  "deliveryContext" | "lastChannel" | "lastTo" | "lastAccountId"
>;

export type EffectiveReplyRoute = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export type FocusBindingFallbackRoute = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

export function isSystemEventProvider(provider?: string): boolean {
  return provider === "heartbeat" || provider === "cron-event" || provider === "exec-event";
}

// A resolved system-event route is only usable if it names an external channel.
// Sessions that were only ever `/focus`-bound (never directly reached from an
// external channel) have no `lastChannel`/`deliveryContext`, or carry an
// internal/webchat placeholder that cannot deliver to the user's real chat.
function isDeliverableRouteChannel(channel?: string): boolean {
  const normalized = channel?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized !== "webchat" && normalized !== "__internal__" && normalized !== "internal";
}

export function resolveEffectiveReplyRoute(params: {
  ctx: EffectiveReplyRouteContext;
  entry?: EffectiveReplyRouteEntry;
  /**
   * Session key of the delivery target. Required for the `/focus` binding
   * fallback below. Callers that cannot supply it simply skip the fallback.
   */
  sessionKey?: string;
  /**
   * Injected lookup for the `/focus` conversation binding on `sessionKey`.
   * Injected (not imported) to keep this module free of the binding-service
   * dependency graph and trivially testable. See
   * `resolveFocusBindingDeliveryRoute` in bound-delivery-router.ts.
   */
  resolveFocusBindingRoute?: (sessionKey: string) => FocusBindingFallbackRoute | undefined;
}): EffectiveReplyRoute {
  if (!isSystemEventProvider(params.ctx.Provider)) {
    return {
      channel: params.ctx.OriginatingChannel,
      to: params.ctx.OriginatingTo,
      accountId: params.ctx.AccountId,
    };
  }
  const persistedDeliveryContext = params.entry?.deliveryContext;
  const route: EffectiveReplyRoute = {
    channel:
      params.ctx.OriginatingChannel ??
      persistedDeliveryContext?.channel ??
      params.entry?.lastChannel,
    to: params.ctx.OriginatingTo ?? persistedDeliveryContext?.to ?? params.entry?.lastTo,
    accountId:
      params.ctx.AccountId ?? persistedDeliveryContext?.accountId ?? params.entry?.lastAccountId,
  };
  // `/focus` fallback for proactive/async system-event turns (cron, heartbeat,
  // exec-event). When the target session has no deliverable external route of
  // its own but IS `/focus`-bound to a single external conversation, deliver
  // there — that binding is exactly where the user expects async replies to go.
  if (!isDeliverableRouteChannel(route.channel) && params.sessionKey && params.resolveFocusBindingRoute) {
    const focus = params.resolveFocusBindingRoute(params.sessionKey);
    if (focus && isDeliverableRouteChannel(focus.channel)) {
      return {
        channel: focus.channel,
        to: focus.to ?? route.to,
        accountId: focus.accountId ?? route.accountId,
      };
    }
  }
  return route;
}
