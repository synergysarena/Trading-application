/**
 * Module 2 market-hours gate.
 *
 * The Strike Tracker minute-boundary engine and live-tick ingestion must stop
 * producing new per-minute rows once the market has closed, so:
 *   - no synthetic post-close values are ever generated / persisted, and
 *   - the Strike Tracker timeline "freezes" at the closing minute.
 *
 * Standalone (no imports) to avoid a require-cycle with trackerService /
 * aetramMarketDataService / market.ts. Mirrors the IST 09:15–15:30 Mon–Fri
 * window used by GET /api/market/status, with ONE deliberate difference: the
 * boundary that fires exactly at 15:30:00 IST is ALLOWED through, so the final
 * closing snapshot (the "15:30" row) is captured before the freeze.
 */

const IST = "Asia/Kolkata";

const MARKET_OPEN_MIN = 9 * 60 + 15;   // 09:15 IST
const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST

interface IstParts {
  weekday: string;
  minutesSinceMidnight: number;
}

const istParts = (now: Date): IstParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    hour12: false,
    weekday: "long",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // en-US midnight quirk
  return { weekday: map.weekday, minutesSinceMidnight: hour * 60 + parseInt(map.minute, 10) };
};

/** Strict market-open check (15:30 EXCLUSIVE) — matches /api/market/status. */
export const isModule2MarketOpen = (now: Date = new Date()): boolean => {
  const { weekday, minutesSinceMidnight } = istParts(now);
  if (weekday === "Saturday" || weekday === "Sunday") return false;
  return minutesSinceMidnight >= MARKET_OPEN_MIN && minutesSinceMidnight < MARKET_CLOSE_MIN;
};

/**
 * Whether the tracker engine is allowed to process a minute boundary / tick
 * right now. Same window as isModule2MarketOpen but 15:30:00 INCLUSIVE so the
 * closing-minute row is captured. 15:31+ IST → false (freeze).
 */
export const isModule2TrackingMinuteAllowed = (now: Date = new Date()): boolean => {
  const { weekday, minutesSinceMidnight } = istParts(now);
  if (weekday === "Saturday" || weekday === "Sunday") return false;
  return minutesSinceMidnight >= MARKET_OPEN_MIN && minutesSinceMidnight <= MARKET_CLOSE_MIN;
};
