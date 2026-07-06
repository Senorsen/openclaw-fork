import { describe, expect, it } from "vitest";
import {
  isSystemEventProvider,
  resolveEffectiveReplyRoute,
  type EffectiveReplyRouteContext,
  type EffectiveReplyRouteEntry,
} from "./effective-reply-route.js";

const ctx = (params: EffectiveReplyRouteContext): EffectiveReplyRouteContext => params;
const entry = (params: EffectiveReplyRouteEntry): EffectiveReplyRouteEntry => params;

describe("resolveEffectiveReplyRoute", () => {
  it("uses live origin context for normal providers", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "slack",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:live",
          AccountId: "live-account",
        }),
        entry: entry({
          deliveryContext: {
            channel: "telegram",
            to: "chat:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "whatsapp",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "discord",
      to: "channel:live",
      accountId: "live-account",
    });
  });

  it("does not use persisted fallbacks for normal providers", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "slack" }),
        entry: entry({
          deliveryContext: {
            channel: "telegram",
            to: "chat:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "whatsapp",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: undefined,
      to: undefined,
      accountId: undefined,
    });
  });

  it("prefers live origin context for exec-event replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "exec-event",
          OriginatingChannel: "telegram",
          OriginatingTo: "chat:live",
          AccountId: "live-account",
        }),
        entry: entry({
          deliveryContext: {
            channel: "discord",
            to: "channel:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "slack",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:live",
      accountId: "live-account",
    });
  });

  it("falls back to deliveryContext for exec-event replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "exec-event" }),
        entry: entry({
          deliveryContext: {
            channel: "telegram",
            to: "chat:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "slack",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:persisted",
      accountId: "persisted-account",
    });
  });

  it("falls back to legacy last route fields for exec-event replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "exec-event" }),
        entry: entry({
          lastChannel: "slack",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "slack",
      to: "last-to",
      accountId: "last-account",
    });
  });

  it("fills partial exec-event route from persisted context", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "exec-event",
          OriginatingChannel: "telegram",
          OriginatingTo: "chat:live",
        }),
        entry: entry({
          deliveryContext: {
            channel: "discord",
            to: "channel:persisted",
            accountId: "persisted-account",
          },
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:live",
      accountId: "persisted-account",
    });
  });
});

describe("resolveEffectiveReplyRoute - /focus binding fallback", () => {
  it("uses the /focus binding for a cron-event turn when the session has no external route", () => {
    // agent:main:main was only ever /focus-bound from Telegram; it has no
    // lastChannel / deliveryContext of its own, so a cron reply would otherwise
    // have nowhere to go.
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "cron-event" }),
        entry: entry({}),
        sessionKey: "agent:main:main",
        resolveFocusBindingRoute: (key) =>
          key === "agent:main:main"
            ? { channel: "telegram", to: "direct:203205281", accountId: "default" }
            : undefined,
      }),
    ).toEqual({
      channel: "telegram",
      to: "direct:203205281",
      accountId: "default",
    });
  });

  it("treats a webchat-only persisted route as non-deliverable and applies the /focus fallback", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "heartbeat" }),
        entry: entry({ lastChannel: "webchat", lastTo: "web:session" }),
        sessionKey: "agent:main:main",
        resolveFocusBindingRoute: () => ({
          channel: "telegram",
          to: "direct:203205281",
          accountId: "default",
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "direct:203205281",
      accountId: "default",
    });
  });

  it("does NOT apply the /focus fallback when the session already has a deliverable route", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "cron-event" }),
        entry: entry({ lastChannel: "telegram", lastTo: "direct:real", lastAccountId: "default" }),
        sessionKey: "agent:main:main",
        resolveFocusBindingRoute: () => ({
          channel: "slack",
          to: "channel:other",
          accountId: "default",
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "direct:real",
      accountId: "default",
    });
  });

  it("does NOT apply the /focus fallback for normal (interactive) provider turns", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "telegram", OriginatingChannel: "telegram", OriginatingTo: "chat:x" }),
        entry: entry({}),
        sessionKey: "agent:main:main",
        resolveFocusBindingRoute: () => ({ channel: "slack", to: "channel:other" }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:x",
      accountId: undefined,
    });
  });

  it("keeps the (undeliverable) route when no /focus binding is present", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ Provider: "cron-event" }),
        entry: entry({}),
        sessionKey: "agent:main:main",
        resolveFocusBindingRoute: () => undefined,
      }),
    ).toEqual({
      channel: undefined,
      to: undefined,
      accountId: undefined,
    });
  });
});

describe("isSystemEventProvider", () => {
  it("recognizes persisted-delivery event providers", () => {
    expect(isSystemEventProvider("heartbeat")).toBe(true);
    expect(isSystemEventProvider("cron-event")).toBe(true);
    expect(isSystemEventProvider("exec-event")).toBe(true);
    expect(isSystemEventProvider("slack")).toBe(false);
    expect(isSystemEventProvider(undefined)).toBe(false);
  });
});
