import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSessionManager } from "./open-session-manager.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "open-session-once-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "session.jsonl") };
}

describe("openSessionManager", () => {
  it("loads once, preserving header cwd, tree, and append persistence without rewriting history", async () => {
    const { dir, file } = await fixture();
    const header = {
      type: "session",
      version: 3,
      id: "fixture",
      cwd: "/original/汉字",
      timestamp: "2026-01-01T00:00:00Z",
    };
    const entry = {
      type: "message",
      id: "first",
      parentId: null,
      timestamp: "2026-01-01T00:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "original" }], timestamp: 1 },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
    await fs.writeFile(file, original);
    const load = vi.spyOn(SessionManager.prototype, "setSessionFile");
    const open = vi.spyOn(SessionManager, "open");
    const manager = await openSessionManager(file);
    expect(open).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(manager.getCwd()).toBe(header.cwd);
    expect(manager.getSessionId()).toBe(header.id);
    expect(manager.getSessionDir()).toBe(dir);
    expect(manager.getLeafId()).toBe("first");
    expect(await fs.readFile(file, "utf8")).toBe(original);
    manager.appendMessage({ role: "user", content: "next", timestamp: 2 });
    const updated = await fs.readFile(file, "utf8");
    expect(updated.startsWith(original)).toBe(true);
    const last = JSON.parse(updated.trim().split("\n").at(-1)!);
    expect(last.parentId).toBe("first");
    expect(last.message.content).toBe("next");
    expect(await fs.readdir(dir)).toEqual(["session.jsonl"]);
  });

  it("matches malformed-line skipping and reads an arbitrarily long header", async () => {
    const { file } = await fixture();
    const cwd = `/original/${"x".repeat(70_000)}`;
    await fs.writeFile(
      file,
      `\nnot-json\n${JSON.stringify({ type: "session", version: 3, id: "long", cwd })}\n`,
    );
    const manager = await openSessionManager(file);
    expect(manager.getCwd()).toBe(cwd);
    expect(manager.getSessionId()).toBe("long");
  });

  it("keeps a missing file unpersisted until pi receives messages", async () => {
    const { dir, file } = await fixture();
    const manager = await openSessionManager(file);
    expect(manager.getSessionFile()).toBe(file);
    expect(manager.getCwd()).toBe(process.cwd());
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
