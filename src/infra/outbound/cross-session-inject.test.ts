import { describe, expect, it, vi, beforeEach } from "vitest";
import { maybeCrossSessionInject } from "./cross-session-inject.js";
import type { OpenClawConfig } from "../../config/config.js";

// Mock the session transcript append function
vi.mock("../../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({
    ok: true,
    sessionFile: "/tmp/sessions/test.jsonl",
  })),
}));

// Mock the logger
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";

const mockAppend = vi.mocked(appendAssistantMessageToSessionTranscript);

// A representative human-facing source session key (a real user DMing the
// agent). Cross-session inject only fires for these.
const HUMAN_SOURCE = "agent:main:telegram:direct:99999";

function makeConfig(overrides?: {
  dmScope?: string;
  injectOutboundToTargetSession?: boolean;
}): OpenClawConfig {
  return {
    session: {
      dmScope: overrides?.dmScope as "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer" | undefined,
      injectOutboundToTargetSession: overrides?.injectOutboundToTargetSession,
    },
  } as unknown as OpenClawConfig;
}

describe("maybeCrossSessionInject", () => {
  beforeEach(() => {
    mockAppend.mockClear();
    mockAppend.mockResolvedValue({ ok: true, sessionFile: "/tmp/sessions/test.jsonl" });
  });

  it("does not inject when injectOutboundToTargetSession is explicitly false", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer", injectOutboundToTargetSession: false }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("injects by default when injectOutboundToTargetSession is undefined (human source)", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(true);
    expect(mockAppend).toHaveBeenCalledOnce();
  });

  it("does not inject when the source session is a subagent (agent-to-agent)", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: "agent:main:subagent:abc-123",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("non-human-source");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("does not inject when the source session is a cron run (system-internal)", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: "agent:main:cron:job1:run:xyz",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("non-human-source");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("does not inject when the source session is an ACP session", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: "agent:main:acp:some-acp-session",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("non-human-source");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("does not inject when the source session key is missing", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      // no sourceSessionKey
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("non-human-source");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("does not inject when dmScope is 'main'", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "main" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("dmScope-not-isolated");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("does not inject when dmScope is undefined (defaults to main)", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({}),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("dmScope-not-isolated");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("injects with per-channel-peer dmScope (human source)", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(true);
    expect(mockAppend).toHaveBeenCalledOnce();
    expect(mockAppend).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:12345",
      text: "Hello from agent",
      mediaUrls: undefined,
    });
  });

  it("injects with per-peer dmScope (human source)", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(true);
    expect(mockAppend).toHaveBeenCalledOnce();
    expect(mockAppend).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:direct:12345",
      text: "Hello from agent",
      mediaUrls: undefined,
    });
  });

  it("injects with per-account-channel-peer dmScope (human source)", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-account-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      accountId: "mybot",
      targetPeerId: "12345",
      text: "Hello from agent",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(true);
    expect(mockAppend).toHaveBeenCalledOnce();
    expect(mockAppend).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:mybot:direct:12345",
      text: "Hello from agent",
      mediaUrls: undefined,
    });
  });

  it("passes mediaUrls to the transcript append", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Check this out",
      mediaUrls: ["https://example.com/photo.jpg"],
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(true);
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrls: ["https://example.com/photo.jpg"],
      }),
    );
  });

  it("skips self-target when source session equals resolved target session", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello",
      sourceSessionKey: "agent:main:telegram:direct:12345",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("self-target");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("does not inject when target peer is empty", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "  ",
      text: "Hello",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("missing-target-peer");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("returns injected=false when appendAssistant returns ok=false", async () => {
    mockAppend.mockResolvedValue({ ok: false, reason: "unknown sessionKey: x" });

    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("unknown sessionKey: x");
  });

  it("handles appendAssistant errors gracefully", async () => {
    mockAppend.mockRejectedValue(new Error("disk full"));

    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello",
      sourceSessionKey: HUMAN_SOURCE,
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("disk full");
  });
});
