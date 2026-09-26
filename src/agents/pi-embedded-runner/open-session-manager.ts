import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { SessionManager } from "@earendil-works/pi-coding-agent";

async function readSessionCwd(sessionFile: string): Promise<string> {
  const input = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let entry: { type?: unknown; id?: unknown; cwd?: unknown } | null;
      try {
        entry = JSON.parse(line);
      } catch {
        // Match SessionManager's handling of malformed JSONL lines.
        continue;
      }
      return entry?.type === "session" &&
        typeof entry.id === "string" &&
        typeof entry.cwd === "string"
        ? entry.cwd
        : process.cwd();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return process.cwd();
}

/** Open without pi's full-file parse just to discover cwd, then a second load. */
export async function openSessionManager(sessionFile: string): Promise<SessionManager> {
  const cwd = await readSessionCwd(sessionFile);
  // create() only initializes in memory; setSessionFile() performs the one load
  // and retains pi's migration, index, branching, and persistence semantics.
  const manager = SessionManager.create(cwd, path.resolve(sessionFile, ".."));
  manager.setSessionFile(sessionFile);
  return manager;
}
