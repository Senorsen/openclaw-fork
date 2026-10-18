import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ThinkLevel } from "../thinking.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { initFastReplySessionState } from "./get-reply-fast-path.js";
import { maybeResolveNativeSlashCommandFastReply } from "./get-reply-native-slash-fast-path.js";
import { createTypingController } from "./typing.js";

const mocks = vi.hoisted(() => ({
  loadSessionStore: vi.fn(),
  loadModelCatalog: vi.fn<() => Promise<ModelCatalogEntry[]>>(),
  compactEmbeddedPiSession: vi.fn(),
  buildStatusReply: vi.fn(),
}));

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
}));
vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
}));
// Keep the real fast-path session routing, command context, dispatcher and compact handler.
// Stub only runtime boundaries (no model requests, credentials or session-file writes).
vi.mock("./get-reply-fast-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./get-reply-fast-path.js")>();
  return { ...actual, initFastReplySessionState: vi.fn(actual.initFastReplySessionState) };
});
vi.mock("./commands.runtime.js", async () => ({
  handleCommands: (await import("./commands-core.js")).handleCommands,
}));
vi.mock("./commands-handlers.runtime.js", async () => {
  const { handleCompactCommand } = await import("./commands-compact.js");
  return {
    loadCommandHandlers: () => [
      handleCompactCommand,
      async (params: HandleCommandsParams) =>
        ["/help", "/whoami"].includes(params.command.commandBodyNormalized)
          ? { shouldContinue: false, reply: { text: "unrelated command" } }
          : null,
    ],
  };
});
vi.mock("./commands-reset.js", () => ({
  maybeHandleResetCommand: async () => null,
}));
vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => undefined,
}));
vi.mock("../../agents/harness/selection.js", () => ({
  resolveAgentHarnessPolicy: () => ({ runtime: "pi" }),
}));
vi.mock("./commands-compact.runtime.js", () => ({
  isEmbeddedPiRunActive: () => false,
  compactEmbeddedPiSession: mocks.compactEmbeddedPiSession,
  resolveSessionFilePath: (_sessionId: string, entry: SessionEntry) => entry.sessionFile,
  resolveSessionFilePathOptions: () => ({}),
  enqueueSystemEvent: vi.fn(),
  formatContextUsageShort: () => "Context 1k",
  resolveFreshSessionTotalTokens: () => 1000,
}));
vi.mock("./commands-status.js", () => ({ buildStatusReply: mocks.buildStatusReply }));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: vi.fn(() => {
    throw new Error("unexpected directive fallback");
  }),
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: vi.fn(() => {
    throw new Error("unexpected inline action fallback");
  }),
}));

type FastReplyParams = Parameters<typeof maybeResolveNativeSlashCommandFastReply>[0];
const targetSessionKey = "agent:main:telegram:direct:target";
const nativeSessionKey = "telegram:slash:source";
const workspaceDir = path.join(process.cwd(), "tmp", "native-slash-test");

function entry(thinkingLevel?: ThinkLevel): SessionEntry {
  return {
    sessionId: "target-session",
    updatedAt: 1,
    sessionFile: path.join(workspaceDir, "target.jsonl"),
    thinkingLevel,
  };
}

function buildParams(overrides: Partial<FastReplyParams> = {}): FastReplyParams {
  return {
    ctx: {
      Body: "/compact",
      BodyForCommands: "/compact",
      CommandBody: "/compact",
      CommandSource: "native",
      CommandTurn: { kind: "native", source: "native", authorized: true },
      CommandTargetSessionKey: targetSessionKey,
      SessionKey: nativeSessionKey,
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:123",
      SenderId: "123",
      To: "telegram:123",
    },
    cfg: { session: { store: path.join(workspaceDir, "sessions.json") } },
    agentId: "main",
    agentDir: workspaceDir,
    agentCfg: undefined,
    commandAuthorized: true,
    defaultProvider: "test-provider",
    defaultModel: "reasoning-model",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: "test-provider",
    model: "reasoning-model",
    workspaceDir,
    typing: createTypingController({}),
    ...overrides,
  };
}

function setTargetThinking(thinkingLevel?: ThinkLevel) {
  mocks.loadSessionStore.mockImplementation(() => ({
    [targetSessionKey]: entry(thinkingLevel),
    [nativeSessionKey]: { ...entry("minimal"), sessionId: "native-command-session" },
  }));
}

async function compact(params = buildParams()) {
  const result = await maybeResolveNativeSlashCommandFastReply(params);
  expect(result).toMatchObject({
    handled: true,
    reply: { text: expect.stringContaining("skipped") },
  });
  expect(mocks.compactEmbeddedPiSession).toHaveBeenCalledOnce();
  expect(mocks.compactEmbeddedPiSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "target-session",
      sessionKey: targetSessionKey,
      provider: params.provider,
      model: params.model,
      trigger: "manual",
    }),
  );
  return mocks.compactEmbeddedPiSession.mock.calls[0][0];
}

describe("maybeResolveNativeSlashCommandFastReply thinking inheritance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTargetThinking();
    mocks.loadModelCatalog.mockResolvedValue([
      {
        provider: "test-provider",
        id: "reasoning-model",
        name: "Reasoning model",
        reasoning: true,
      },
    ]);
    mocks.compactEmbeddedPiSession.mockResolvedValue({ ok: true, compacted: false });
    mocks.buildStatusReply.mockImplementation(async (params) => ({
      text: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
    }));
  });

  it.each(["high", "off"] as const)(
    "inherits target session %s, not native command state",
    async (level) => {
      setTargetThinking(level);
      const params = buildParams({ agentCfg: { thinkingDefault: "low" } });
      expect((await compact(params)).thinkLevel).toBe(level);
      expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    },
  );

  it("prefers the target store entry over a temporary session entry", async () => {
    const params = buildParams();
    setTargetThinking("high");
    const state = initFastReplySessionState(params);
    vi.mocked(initFastReplySessionState).mockReturnValueOnce({
      ...state,
      sessionEntry: { ...entry("off"), sessionId: "temporary-session" },
    });
    expect((await compact(params)).thinkLevel).toBe("high");
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });

  it.each(["high", "off"] as const)(
    "prioritizes the explicit thinking override %s",
    async (level) => {
      setTargetThinking(level === "off" ? "high" : "off");
      const params = buildParams({ opts: { thinkingLevelOverride: level } });
      expect((await compact(params)).thinkLevel).toBe(level);
      expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    },
  );

  it.each(["high", "off"] as const)(
    "prefers per-agent default %s over global defaults",
    async (level) => {
      const params = buildParams({ agentCfg: { thinkingDefault: "minimal" } });
      params.cfg.agents = {
        defaults: { thinkingDefault: "low" },
        list: [
          { id: "other", thinkingDefault: "medium" },
          { id: "main", thinkingDefault: level },
        ],
      };
      expect((await compact(params)).thinkLevel).toBe(level);
      expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    },
  );

  it.each(["high", "off"] as const)("inherits global thinking default %s", async (level) => {
    const params = buildParams();
    params.cfg.agents = { defaults: { thinkingDefault: level }, list: [{ id: "main" }] };
    expect((await compact(params)).thinkLevel).toBe(level);
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });

  it.each(["high", "off"] as const)("inherits supplied agentCfg default %s", async (level) => {
    const params = buildParams({ agentCfg: { thinkingDefault: level } });
    expect((await compact(params)).thinkLevel).toBe(level);
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });

  it.each([
    { reasoning: true, expected: "medium" },
    { reasoning: false, expected: "off" },
  ])("uses model fallback ($reasoning -> $expected)", async ({ reasoning, expected }) => {
    mocks.loadModelCatalog.mockResolvedValue([
      { provider: "test-provider", id: "reasoning-model", name: "Test model", reasoning },
    ]);
    expect((await compact()).thinkLevel).toBe(expected);
    expect(mocks.loadModelCatalog).toHaveBeenCalledExactlyOnceWith({ config: expect.any(Object) });
  });

  it("uses configured model capability without loading the runtime catalog", async () => {
    const params = buildParams();
    params.cfg.models = {
      providers: {
        "test-provider": {
          baseUrl: "https://unused.invalid",
          models: [
            {
              id: "reasoning-model",
              name: "Test model",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
      },
    };
    expect((await compact(params)).thinkLevel).toBe("medium");
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });

  it("preserves the existing per-model thinking fallback", async () => {
    const params = buildParams();
    params.cfg.agents = {
      defaults: { models: { "test-provider/reasoning-model": { params: { thinking: "high" } } } },
    };
    expect((await compact(params)).thinkLevel).toBe("high");
  });

  it.each(["/help", "/whoami"])("does not load a thinking catalog for %s", async (body) => {
    const params = buildParams();
    params.ctx = { ...params.ctx, Body: body, BodyForCommands: body, CommandBody: body };
    await expect(maybeResolveNativeSlashCommandFastReply(params)).resolves.toMatchObject({
      handled: true,
    });
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    expect(mocks.compactEmbeddedPiSession).not.toHaveBeenCalled();
  });

  it("leaves unauthorized /compact rejection and lazy loading unchanged", async () => {
    const params = buildParams({ commandAuthorized: false });
    params.ctx = {
      ...params.ctx,
      CommandTurn: { kind: "native", source: "native", authorized: false },
    };
    await expect(maybeResolveNativeSlashCommandFastReply(params)).resolves.toMatchObject({
      handled: true,
    });
    expect(mocks.compactEmbeddedPiSession).not.toHaveBeenCalled();
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });

  it.each(["high", "off"] as const)(
    "shares target session %s resolution with /status",
    async (level) => {
      setTargetThinking(level);
      const params = buildParams();
      params.ctx = { ...params.ctx, BodyForCommands: "/status", CommandBody: "/status" };
      await expect(maybeResolveNativeSlashCommandFastReply(params)).resolves.toEqual({
        handled: true,
        reply: { text: level },
      });
      expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    },
  );

  it("shares the per-agent default resolver with /status", async () => {
    const params = buildParams();
    params.cfg.agents = { list: [{ id: "main", thinkingDefault: "high" }] };
    params.ctx = { ...params.ctx, BodyForCommands: "/status", CommandBody: "/status" };
    await expect(maybeResolveNativeSlashCommandFastReply(params)).resolves.toEqual({
      handled: true,
      reply: { text: "high" },
    });
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });
});
