// Format the real inbound receive time (not processing time) with a Chinese
// weekday, so queued/steered messages carry the moment they actually arrived.
//
// This is intentionally self-contained (no plugin-sdk export needed) and used by
// the steer-bypass middleware to stamp the stop hint injected into an active run.

const CHINESE_WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** Resolve an IANA timezone from config, falling back to the host timezone, then UTC. */
export function resolveTelegramReceiveTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
      return trimmed;
    } catch {
      // ignore invalid timezone and fall back to host
    }
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host?.trim() || "UTC";
}

/**
 * Format a millisecond timestamp as `YYYY-MM-DD HH:mm:ss 周X` in the given
 * timezone. Chinese weekday is derived from the wall-clock day in that timezone
 * (not the runtime locale), so it stays correct regardless of host locale.
 */
export function formatReceivedAtWithWeekday(timestampMs: number, timeZone: string): string {
  const date = new Date(timestampMs);
  // Use en-CA to get a stable YYYY-MM-DD, HH:mm:ss layout, then normalize.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);

  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  const year = lookup("year");
  const month = lookup("month");
  const day = lookup("day");
  let hour = lookup("hour");
  // Some environments render midnight as "24" under hour12:false; normalize to "00".
  if (hour === "24") {
    hour = "00";
  }
  const minute = lookup("minute");
  const second = lookup("second");

  // Derive weekday index from the wall-clock date in the target timezone so the
  // Chinese label matches the displayed calendar day even across DST/offset.
  const weekdayIndex = resolveWeekdayIndexInTimeZone(date, timeZone);
  const weekday = CHINESE_WEEKDAYS[weekdayIndex] ?? "";

  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${weekday}`.trim();
}

/** 0=周日 .. 6=周六, computed from the wall-clock date in `timeZone`. */
function resolveWeekdayIndexInTimeZone(date: Date, timeZone: string): number {
  const short = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[short] ?? new Date(date).getDay();
}

/**
 * Build the fixed stop signal injected into an active run when a new inbound
 * message arrives. It never carries the user's actual message content — the real
 * message is delivered in order through the follow-up queue on the next turn.
 */
export function buildSteerStopHint(params: {
  mediaType?: string;
  receivedAtText: string;
}): string {
  const kind = params.mediaType ? `新的${params.mediaType}消息` : "新消息";
  return (
    `[系统] 用户于 ${params.receivedAtText} 发来了一条${kind}（这是真正的接收时间，不是当前处理时间）。` +
    `请立刻停止当前这一轮剩余的所有操作，用一句话简短回复用户（例如「我先暂停一下，马上按顺序处理你的新消息」），然后结束本轮。` +
    `新消息会由系统在随后按接收顺序自动送达，你无需也不要在这里猜测其内容。`
  );
}
