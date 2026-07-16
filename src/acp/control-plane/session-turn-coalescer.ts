import type { AcpTurnAttachment } from "./manager.types.js";

/**
 * Coalesces multiple prompt turns that pile up on the same session actor key
 * while an earlier turn is still running.
 *
 * Background: prompt turns are serialized per session via SessionActorQueue.
 * When the user sends N messages rapidly, message 1 runs while messages 2..N
 * wait in the actor queue. Previously each queued message ran its own agent
 * turn one-by-one. This coalescer lets the FIRST queued turn to actually start
 * executing absorb the text/attachments of every other prompt turn still
 * waiting for the same key, so they are handled in a single turn. The absorbed
 * turns then resolve as no-ops.
 *
 * Only user prompt turns are buffered here; system/heartbeat/non-prompt work
 * is never registered and therefore never coalesced.
 */

export type CoalesceEntry = {
  text: string;
  attachments?: AcpTurnAttachment[];
  requestId: string;
  /** Set true once this entry's payload has been folded into a running turn. */
  consumed: boolean;
};

export type CoalesceResult = {
  /** True when this turn should run and use the merged payload below. */
  run: boolean;
  text: string;
  attachments?: AcpTurnAttachment[];
  /** requestIds of every entry folded into this turn (for logging). */
  mergedRequestIds: string[];
};

export class SessionTurnCoalescer {
  private readonly buffers = new Map<string, CoalesceEntry[]>();

  /**
   * Register a pending prompt turn before it enters the actor queue.
   * Returns the entry handle; pass it to {@link claim} when the turn starts.
   */
  register(actorKey: string, entry: Omit<CoalesceEntry, "consumed">): CoalesceEntry {
    const handle: CoalesceEntry = { ...entry, consumed: false };
    const list = this.buffers.get(actorKey);
    if (list) {
      list.push(handle);
    } else {
      this.buffers.set(actorKey, [handle]);
    }
    return handle;
  }

  /**
   * Called when a queued turn actually begins executing inside the actor.
   * If this entry was already absorbed by an earlier turn, returns run=false.
   * Otherwise it absorbs all currently-unconsumed entries for this key and
   * returns the merged payload.
   */
  claim(actorKey: string, self: CoalesceEntry): CoalesceResult {
    const list = this.buffers.get(actorKey);

    // Already folded into an earlier running turn -> no-op.
    if (self.consumed) {
      this.removeEntry(actorKey, self);
      return { run: false, text: self.text, mergedRequestIds: [self.requestId] };
    }

    if (!list || list.length === 0) {
      self.consumed = true;
      return { run: true, text: self.text, attachments: self.attachments, mergedRequestIds: [self.requestId] };
    }

    // Absorb every unconsumed entry (including self), preserving arrival order.
    const absorbed = list.filter((e) => !e.consumed);
    const texts: string[] = [];
    const attachments: AcpTurnAttachment[] = [];
    const mergedRequestIds: string[] = [];
    for (const entry of absorbed) {
      entry.consumed = true;
      const t = (entry.text ?? "").trim();
      if (t.length > 0) {
        texts.push(entry.text);
      }
      if (entry.attachments && entry.attachments.length > 0) {
        attachments.push(...entry.attachments);
      }
      mergedRequestIds.push(entry.requestId);
    }

    // Drop consumed entries from the buffer.
    this.buffers.delete(actorKey);

    const mergedText = texts.join("\n\n");
    return {
      run: true,
      text: mergedText.length > 0 ? mergedText : self.text,
      attachments: attachments.length > 0 ? attachments : self.attachments,
      mergedRequestIds,
    };
  }

  private removeEntry(actorKey: string, self: CoalesceEntry): void {
    const list = this.buffers.get(actorKey);
    if (!list) {
      return;
    }
    const idx = list.indexOf(self);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
    if (list.length === 0) {
      this.buffers.delete(actorKey);
    }
  }

  getPendingCountForTesting(actorKey: string): number {
    return this.buffers.get(actorKey)?.filter((e) => !e.consumed).length ?? 0;
  }
}
