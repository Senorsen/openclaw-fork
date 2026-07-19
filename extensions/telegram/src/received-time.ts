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
 * Build the steer stop signal injected into an active run when a new inbound
 * message arrives. It now carries a lightweight preview (sender, ids, time and
 * a content marker) so the agent can prioritize the new message. The full,
 * canonical message is still delivered in order through the follow-up queue on
 * the next turn; the shared message id lets the agent dedupe against it.
 */
export function buildSteerStopHint(params: {
  senderName: string;
  senderId?: string | number;
  messageId?: string | number;
  receivedAtText: string;
  /** Preview body: plain text, or a `<media:...>` marker for media messages. */
  previewBody: string;
}): string {
  const name = params.senderName.trim() || "用户";
  const idPart = params.senderId != null && String(params.senderId).trim() ? `（${params.senderId}）` : "";
  const msgIdText = params.messageId != null && String(params.messageId).trim() ? `#${params.messageId}` : "#未知";
  return (
    `[系统] ${name}${idPart}于 ${params.receivedAtText} 发来了一条新 steer 消息，请优先响应。` +
    `注意消息可能略有乱序，这是预览，稍后可能重复出现正式消息，可以根据相同的消息ID（${msgIdText}）避免重复理解；` +
    `但如果消息时间不同则视为不同消息。` +
    `\n⚠️ 如果预览包含语音/图片且已下载到本地，必须立即转录/查看并处理，不要等正式消息。\n\n` +
    `--- 消息预览 ---\n` +
    `${msgIdText} ${name} ${params.receivedAtText}: ${params.previewBody}`
  );
}

/**
 * Build the preview body for a steer message. For text it returns the raw text;
 * for media it returns a `<media:type>` marker plus a hint that the agent should
 * inspect the media itself (transcribe audio / view image) once the full message
 * lands in the follow-up queue.
 */
export function buildSteerPreviewBody(params: {
  text?: string;
  mediaKind?: "audio" | "image" | "video" | "file" | "media";
  /**
   * Local absolute path to the media that was pre-downloaded for this steer
   * preview. When present, the agent can transcribe/view the file immediately
   * instead of waiting for the follow-up queue to deliver the full message.
   */
  filePath?: string;
  /**
   * Machine-generated transcript of a pre-downloaded audio steer preview. When
   * present, it is embedded directly in the preview so the agent can read the
   * spoken content immediately without re-transcribing. The file path is always
   * retained alongside so the agent can re-transcribe if it distrusts the text.
   */
  transcript?: string;
}): string {
  const text = params.text?.trim();
  if (text) {
    return text;
  }
  const filePath = params.filePath?.trim();
  const transcript = params.transcript?.trim();
  switch (params.mediaKind) {
    case "audio":
      if (filePath && transcript) {
        return (
          `<media:audio>（语音消息，已下载到本地：${filePath}）\n` +
          `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`
        );
      }
      return filePath
        ? `<media:audio>（语音消息，已下载到本地：${filePath} —— 必须立即转录并处理，不要等正式消息）`
        : "<media:audio>（语音消息，请在正式消息送达后自行转录查看）";
    case "image":
      return filePath
        ? `<media:image>（图片消息，已下载到本地：${filePath} —— 可立即查看）`
        : "<media:image>（图片消息，请在正式消息送达后自行查看）";
    case "video":
      return filePath
        ? `<media:video>（视频消息，已下载到本地：${filePath} —— 可立即查看）`
        : "<media:video>（视频消息，请在正式消息送达后自行查看）";
    case "file":
      return filePath
        ? `<media:file>（文件消息，已下载到本地：${filePath} —— 可立即查看）`
        : "<media:file>（文件消息，请在正式消息送达后自行查看）";
    default:
      return filePath
        ? `<media:media>（媒体消息，已下载到本地：${filePath} —— 可立即查看）`
        : "<media:media>（媒体消息，请在正式消息送达后自行查看）";
  }
}
