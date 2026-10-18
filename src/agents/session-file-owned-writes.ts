import fs from "node:fs/promises";
import path from "node:path";

/**
 * Process-local record of session transcript writes performed by this
 * OpenClaw process while it held the session write lock.
 *
 * An embedded attempt releases its coarse session lock during model I/O and
 * fences the transcript by fingerprint, so it can detect another owner taking
 * over the file. Writes from this same process (delivery mirrors, compaction
 * notices, transcript injects) legitimately land in that window too. Recording
 * them here lets the fence tell those locked in-process writes apart from
 * unowned external changes instead of failing the whole turn.
 */
export type OwnedSessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    };

export type OwnedSessionFileWrite = {
  generation: number;
  fingerprint: OwnedSessionFileFingerprint;
};

const ownedWrites = new Map<string, OwnedSessionFileWrite>();
let generationCounter = 0;

export function resolveOwnedSessionFileKey(sessionFile: string): string {
  return path.resolve(sessionFile);
}

export function sameOwnedSessionFileFingerprint(
  left: OwnedSessionFileFingerprint | undefined,
  right: OwnedSessionFileFingerprint | undefined,
): boolean {
  if (!left || !right || left.exists !== right.exists) {
    return false;
  }
  if (!left.exists || !right.exists) {
    return true;
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export async function readOwnedSessionFileFingerprint(
  sessionFile: string,
): Promise<OwnedSessionFileFingerprint> {
  try {
    const stat = await fs.stat(sessionFile, { bigint: true });
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

export function currentOwnedSessionFileGeneration(): number {
  return generationCounter;
}

/** Record a write this process made while holding the session write lock. */
export function recordOwnedSessionFileWrite(
  sessionFile: string,
  fingerprint: OwnedSessionFileFingerprint,
): number {
  generationCounter += 1;
  ownedWrites.set(resolveOwnedSessionFileKey(sessionFile), {
    generation: generationCounter,
    fingerprint,
  });
  return generationCounter;
}

/** Re-stat and record after a locked write. Never throws. */
export async function recordOwnedSessionFileWriteFromDisk(sessionFile: string): Promise<void> {
  try {
    recordOwnedSessionFileWrite(sessionFile, await readOwnedSessionFileFingerprint(sessionFile));
  } catch {
    // Best effort: a missing record only means the fence stays conservative.
  }
}

export function getOwnedSessionFileWrite(sessionFile: string): OwnedSessionFileWrite | undefined {
  return ownedWrites.get(resolveOwnedSessionFileKey(sessionFile));
}

export function resetOwnedSessionFileWritesForTest(): void {
  ownedWrites.clear();
  generationCounter = 0;
}
