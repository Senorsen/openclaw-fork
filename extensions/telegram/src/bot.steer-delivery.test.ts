import { beforeEach, describe, expect, it, vi } from "vitest";

const steer = vi.hoisted(() => ({
  queue: vi.fn((_sessionId: string, _text: string) => true),
  resolveSession: vi.fn((): string | undefined => "active-session"),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  queueAgentHarnessMessage: steer.queue,
  resolveActiveEmbeddedRunSessionId: steer.resolveSession,
}));
vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: vi.fn(async () => ({ path: "/data/media/inbound/preview.jpg" })),
}));

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore, setTelegramBotRuntimeForTest } = await import("./bot-core.js");

type Context = {
  message: {
    chat: { id: number; type: "private" };
    from: { id: number; first_name: string };
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    photo?: { file_id: string }[];
    media_group_id?: string;
    forward_origin?: { type: "hidden_user"; sender_user_name: string; date: number };
  };
  me: { username: string };
  api: { getFile: ReturnType<typeof vi.fn> };
};
type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;

function context(id: number, media = false): Context {
  return {
    message: {
      chat: { id: 1234, type: "private" },
      from: { id: 55, first_name: "User" },
      message_id: id,
      date: 1736380800,
      forward_origin: { type: "hidden_user", sender_user_name: "Sender", date: 1736370000 },
      ...(media
        ? { photo: [{ file_id: `p${id}` }], caption: `caption-${id}`, media_group_id: "album" }
        : { text: `question-${id}-long-enough` }),
    },
    me: { username: "test_bot" },
    api: { getFile: vi.fn(async () => ({ file_path: "photos/p.jpg" })) },
  };
}

function createMiddleware(): Middleware {
  harness.middlewareUseSpy.mockClear();
  setTelegramBotRuntimeForTest(harness.telegramBotRuntimeForTest);
  const fetchMedia = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
  createTelegramBotCore({
    token: "test-token",
    telegramDeps: harness.telegramBotDepsForTest,
    telegramTransport: { fetch: fetchMedia, sourceFetch: fetchMedia, close: async () => {} },
  });
  // tracker -> steer preview -> sequentialize. Exercise the actual ingress gate.
  return harness.middlewareUseSpy.mock.calls[1][0] as Middleware;
}

describe("Telegram steer delivery ownership", () => {
  beforeEach(() => {
    steer.queue.mockReset().mockReturnValue(true);
    steer.resolveSession.mockReset().mockReturnValue("active-session");
  });

  it.each([true, false])(
    "dispatches a complete text without another update when queue returns %s",
    async (queued) => {
      steer.queue.mockReturnValue(queued);
      const middleware = createMiddleware();
      const next = vi.fn(async () => {});
      await middleware(context(101), next);
      expect(steer.queue).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it("retains every native attachment and caption during a mixed forwarded burst", async () => {
    const middleware = createMiddleware();
    const entries = Array.from({ length: 30 }, (_, i) => context(200 + i, i % 2 === 0));
    const delivered: Context[] = [];
    await Promise.all(
      entries.map((ctx) =>
        middleware(ctx, async () => {
          delivered.push(ctx);
        }),
      ),
    );
    expect(delivered).toHaveLength(entries.length);
    expect(new Set(delivered.map((ctx) => ctx.message.message_id)).size).toBe(30);
    expect(delivered.filter((ctx) => ctx.message.photo)).toHaveLength(15);
    for (const ctx of entries) {
      expect(delivered).toContain(ctx);
    }
    expect(steer.queue.mock.calls.some(([, text]) => String(text).includes("preview.jpg"))).toBe(
      true,
    );
  });

  it("reserves canonical order before a slow photo preview download", async () => {
    const middleware = createMiddleware();
    const photo = context(290, true);
    let finishDownload!: () => void;
    photo.api.getFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDownload = () => resolve({ file_path: "photos/p.jpg" });
        }),
    );
    const delivered: number[] = [];
    const first = middleware(photo, async () => {
      delivered.push(290);
    });
    const second = middleware(context(291), async () => {
      delivered.push(291);
    });
    try {
      expect(delivered).toEqual([290, 291]);
    } finally {
      finishDownload();
      await Promise.all([first, second]);
    }
  });

  it("continues canonical delivery after preview enqueue throws", async () => {
    steer.queue.mockImplementation(() => {
      throw new Error("run ended");
    });
    const next = vi.fn(async () => {});
    await createMiddleware()(context(301), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not inject when idle or for the control lane", async () => {
    const middleware = createMiddleware();
    const next = vi.fn(async () => {});
    steer.resolveSession.mockReturnValue(undefined);
    await middleware(context(401), next);
    steer.resolveSession.mockReturnValue("active-session");
    const stop = context(402);
    stop.message.text = "/stop";
    await middleware(stop, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(steer.queue).not.toHaveBeenCalled();
  });
});
