import { FuturesOHLC } from "../models/FuturesOHLC";
import { PivotLevels as PivotLevelsModel } from "../models/PivotLevels";

// ── Module 1 end-of-day storage cleanup ───────────────────────────────────────
//
// Client requirement: long-term historical storage is no longer needed
// (EMA200's old 45-day warm-up requirement is obsolete — EMA itself stays in
// the app for now, per a separate future task, but it no longer justifies
// retaining old candles). MongoDB should hold ONLY the current trading
// session's Module 1 market data: every previous session's Futures/Spot/
// Option OHLC and Pivot Levels must be gone before today's session begins.
//
// Deliberately NOT a Mongo TTL index — a TTL's background sweep runs on its
// own schedule (not guaranteed to have already fired by the time a fresh
// session starts) and can't be triggered deterministically at server
// startup. This is an explicit, awaited delete instead.
//
// Scope is a strict allow-list — only the two Module 1 market-data models
// below are ever touched. Users, Watchlists, auth, config, and every
// Module 2 collection are never referenced here, so they can't be touched
// even by accident.
//
// Note on scope: SpotTicks (models/SpotTicks.ts) also carries Module 1
// market data in its schema, but a prior audit confirmed it is never
// actually written to anywhere in the codebase (dead code) — there is
// nothing for this cleanup to remove there, so it's intentionally omitted
// rather than adding a no-op delete against an always-empty collection.

const SESSION_OPEN_UTC_MINUTES = 3 * 60 + 45; // 09:15 IST = 03:45 UTC

/**
 * Start of TODAY's calendar trading session (03:45 UTC / 09:15 IST) —
 * always today's boundary, even if that session hasn't started ticking yet.
 *
 * Deliberately different from ohlcAggregator's getTodaySessionOpenMs, which
 * returns YESTERDAY's session open before 09:15 (correct for candle-boundary
 * alignment, so a new candle "day" doesn't begin at midnight). This cleanup
 * needs the opposite: a server restarted at, say, 6am must still purge ALL
 * of yesterday's session, not just data older than yesterday's own open —
 * so the cutoff has to be today's boundary regardless of whether it has
 * arrived yet.
 */
const getTodayCalendarSessionOpenMs = (): number => {
  const now = Date.now();
  const todayMidnightMs = now - (now % (24 * 60 * 60000));
  return todayMidnightMs + SESSION_OPEN_UTC_MINUTES * 60000;
};

let lastCleanedSessionOpenMs = -1;

/**
 * Deletes every Module 1 market-data document from before the current
 * trading session. Safe to call any number of times — the delete filter is
 * always strictly "older than today's session open," so it can never touch
 * today's active session, and re-running it after it already ran for the
 * same session is a no-op (idempotent).
 */
export const cleanupPreviousModule1SessionData = async (): Promise<{
  sessionOpenMs: number;
  futuresOHLCDeleted: number;
  pivotLevelsDeleted: number;
}> => {
  const sessionOpenMs = getTodayCalendarSessionOpenMs();
  const cutoff = new Date(sessionOpenMs);

  let futuresOHLCDeleted = 0;
  let pivotLevelsDeleted = 0;

  try {
    const result = await FuturesOHLC.deleteMany({ bar_time: { $lt: cutoff } });
    futuresOHLCDeleted = result.deletedCount || 0;
  } catch (err: any) {
    console.error("[Module1Cleanup] FuturesOHLC cleanup failed:", err?.message || err);
  }

  try {
    const result = await PivotLevelsModel.deleteMany({ computed_at: { $lt: cutoff } });
    pivotLevelsDeleted = result.deletedCount || 0;
  } catch (err: any) {
    console.error("[Module1Cleanup] PivotLevels cleanup failed:", err?.message || err);
  }

  lastCleanedSessionOpenMs = sessionOpenMs;
  console.log(
    `[Module1Cleanup] Purged previous-session Module 1 market data (cutoff=${cutoff.toISOString()}) — ` +
    `FuturesOHLC: ${futuresOHLCDeleted} removed, PivotLevels: ${pivotLevelsDeleted} removed.`
  );

  return { sessionOpenMs, futuresOHLCDeleted, pivotLevelsDeleted };
};

const ROLLOVER_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Keeps the cleanup current for a server that stays running across a
 * midnight/session boundary without restarting — the startup cleanup alone
 * only covers "the server happened to restart this morning." Polls the
 * session boundary rather than scheduling a one-shot timer at a fixed clock
 * time, so it self-corrects after any delay and needs no wall-clock cron.
 */
export const startModule1DailyCleanupScheduler = (): void => {
  setInterval(() => {
    const sessionOpenMs = getTodayCalendarSessionOpenMs();
    if (sessionOpenMs === lastCleanedSessionOpenMs) return; // already cleaned for today's session
    void cleanupPreviousModule1SessionData().catch((err: any) => {
      console.error("[Module1Cleanup] Scheduled cleanup failed:", err?.message || err);
    });
  }, ROLLOVER_CHECK_INTERVAL_MS);
  console.log(
    `[Module1Cleanup] Daily rollover scheduler started (checks every ${ROLLOVER_CHECK_INTERVAL_MS / 1000}s for a new trading session).`
  );
};
