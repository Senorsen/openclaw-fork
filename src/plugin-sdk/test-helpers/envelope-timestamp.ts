/**
 * Shared helpers for asserting envelope timestamp normalization in channel tests.
 */
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  weekdayShortEnToZh,
} from "../../infra/format-time/format-datetime.js";

export { escapeRegExp } from "../../utils.js";

type EnvelopeTimestampZone = string;

export function formatEnvelopeTimestamp(date: Date, zone: EnvelopeTimestampZone = "utc"): string {
  const trimmedZone = zone.trim();
  const normalized = trimmedZone.toLowerCase();
  const weekday = (() => {
    try {
      if (normalized === "utc" || normalized === "gmt") {
        return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(date);
      }
      if (normalized === "local" || normalized === "host") {
        return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
      }
      return new Intl.DateTimeFormat("en-US", { timeZone: trimmedZone, weekday: "short" }).format(
        date,
      );
    } catch {
      return undefined;
    }
  })();
  // Mirrors the Chinese weekday suffix added by src/auto-reply/envelope.ts's
  // formatEnvelopeTimestamp, so tests asserting against this helper's output
  // stay in sync with the real implementation.
  const weekdayZh = weekdayShortEnToZh(weekday);
  const withWeekdayZh = (base: string): string =>
    weekdayZh ? `${base}（${weekdayZh}）` : base;

  if (normalized === "utc" || normalized === "gmt") {
    const ts = formatUtcTimestamp(date, { displaySeconds: true });
    return withWeekdayZh(weekday ? `${weekday} ${ts}` : ts);
  }
  if (normalized === "local" || normalized === "host") {
    const ts =
      formatZonedTimestamp(date, { displaySeconds: true }) ??
      formatUtcTimestamp(date, { displaySeconds: true });
    return withWeekdayZh(weekday ? `${weekday} ${ts}` : ts);
  }
  const ts =
    formatZonedTimestamp(date, { timeZone: trimmedZone, displaySeconds: true }) ??
    formatUtcTimestamp(date, { displaySeconds: true });
  return withWeekdayZh(weekday ? `${weekday} ${ts}` : ts);
}

export function formatLocalEnvelopeTimestamp(date: Date): string {
  return formatEnvelopeTimestamp(date, "local");
}
