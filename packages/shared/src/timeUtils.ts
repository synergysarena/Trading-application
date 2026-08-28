/**
 * Shared Time and Timezone Normalization Utilities
 * Target timezone: Asia/Kolkata (IST, UTC+05:30)
 *
 * NOTE: Timestamps internally are UTC / epoch milliseconds.
 * Formatted string representations (timeString, minuteBucket) are in Asia/Kolkata.
 */

export interface NormalizedTimestamp {
  timeString: string;     // "HH:mm" in Asia/Kolkata (e.g. "13:39")
  minuteBucket: string;   // "YYYY-MM-DD HH:mm" in Asia/Kolkata (e.g. "2026-08-28 13:39")
  minuteIndex: number;    // Minutes elapsed since 09:15 AM IST (0 for 09:15 AM, 1 for 09:16 AM, etc.)
  timestampMs: number;    // UTC epoch milliseconds
  fullIso: string;        // UTC ISO string (e.g. "2026-08-28T08:09:00.000Z")
}

const IST_TIMEZONE = "Asia/Kolkata";

/**
 * Parses any valid Date / string / number timestamp into UTC epoch ms.
 */
export const toTimestampMs = (timestamp?: Date | string | number | null): number => {
  if (!timestamp) return Date.now();
  if (timestamp instanceof Date) return timestamp.getTime();
  if (typeof timestamp === "number") return timestamp;
  const parsed = new Date(timestamp).getTime();
  return isNaN(parsed) ? Date.now() : parsed;
};

/**
 * Formats a UTC timestamp into 24-hour "HH:mm" in Asia/Kolkata (IST).
 * Example: 2026-08-28T08:09:00.000Z -> "13:39"
 */
export const formatISTTime = (timestamp?: Date | string | number | null): string => {
  const ms = toTimestampMs(timestamp);
  const d = new Date(ms);
  return d.toLocaleTimeString("en-GB", {
    timeZone: IST_TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Formats a UTC timestamp into canonical "YYYY-MM-DD HH:mm" minute bucket in Asia/Kolkata (IST).
 * Example: 2026-08-28T08:09:00.000Z -> "2026-08-28 13:39"
 */
export const getISTMinuteBucket = (timestamp?: Date | string | number | null): string => {
  const ms = toTimestampMs(timestamp);
  const d = new Date(ms);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // "en-CA" formats as "YYYY-MM-DD, HH:mm" -> replace comma with space
  return formatter.format(d).replace(",", "").trim();
};

/**
 * Calculates elapsed minutes since 09:15 AM IST (market open) for the given timestamp.
 * If before 09:15 AM IST, returns 0.
 */
export const getMinutesSinceMarketOpenIST = (timestamp?: Date | string | number | null): number => {
  const ms = toTimestampMs(timestamp);
  const d = new Date(ms);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TIMEZONE,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);

  let hours = 0;
  let minutes = 0;

  for (const p of parts) {
    if (p.type === "hour") hours = parseInt(p.value, 10);
    if (p.type === "minute") minutes = parseInt(p.value, 10);
  }

  if (hours === 24) hours = 0;

  const currentTotalMinutes = hours * 60 + minutes;
  const marketOpenTotalMinutes = 9 * 60 + 15; // 09:15 AM = 555 mins

  if (currentTotalMinutes < marketOpenTotalMinutes) {
    return 0;
  }

  return currentTotalMinutes - marketOpenTotalMinutes;
};

/**
 * Canonical normalizer for any incoming market-data candle or tick timestamp.
 */
export const normalizeCandleTimestamp = (timestamp?: Date | string | number | null): NormalizedTimestamp => {
  const ms = toTimestampMs(timestamp);
  const d = new Date(ms);
  return {
    timeString: formatISTTime(ms),
    minuteBucket: getISTMinuteBucket(ms),
    minuteIndex: getMinutesSinceMarketOpenIST(ms),
    timestampMs: ms,
    fullIso: d.toISOString(),
  };
};
