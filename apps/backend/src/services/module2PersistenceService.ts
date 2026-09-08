import mongoose from "mongoose";
import { Module2StrikeTick } from "../models/Module2StrikeTick";

/**
 * Module 2 Strike Tracker — durable minute-snapshot persistence.
 *
 * This is the ONLY writer of `module2striketicks`. It exists so the previous
 * failure mode — `Module2StrikeTick.create()` inside an empty `catch` in
 * trackerService, with no logging, no retry, no metrics, and a millisecond
 * timestamp that defeated the unique index — can never recur.
 *
 * Guarantees:
 *   • One logical document per { session_id, strike, minute_timestamp } via an
 *     idempotent upsert keyed on exactly the unique-index fields. Re-running a
 *     minute boundary (timer double-fire, session resume within the same
 *     minute) updates the row in place rather than inserting a duplicate.
 *   • `minute_timestamp` is always a canonical UTC minute boundary (caller
 *     passes a Date already floored with getCanonicalMinuteDate()).
 *   • Bounded retry for TRANSIENT MongoDB failures only. Permanent errors
 *     (validation, cast) fail fast and are never retried.
 *   • Every failure is logged with structured context and counted. Nothing is
 *     ever swallowed silently.
 *   • The live Socket.IO projection is independent of this service — the caller
 *     broadcasts regardless of the persistence result, and marks the broadcast
 *     with the real `persisted` outcome.
 */

export type Module2PersistenceErrorType =
  | "duplicate"
  | "validation"
  | "cast"
  | "connection"
  | "timeout"
  | "unknown";

export interface Module2MinuteSnapshot {
  session_id: string;
  strike: string;
  minute_timestamp: Date; // MUST be a canonical minute boundary
  ltp_integer: number;
  ltp_missing: boolean;
  is_day_high: boolean;
  is_day_low: boolean;
  pct_from_open: number;
  is_downtrend_flagged: boolean;
  oi: number;
  oi_delta: number;
  oi_buy: number;
  oi_sell: number;
}

export interface Module2PersistenceResult {
  attempted: number;
  succeeded: number;
  failed: number;
  retries: number;
  /** strike -> error type, for the strikes that ultimately failed */
  failures: Array<{ strike: string; minute: string; type: Module2PersistenceErrorType; message: string }>;
}

export interface Module2PersistenceMetrics {
  attempted: number;
  succeeded: number;
  failed: number;
  retried: number;
  upsertsInserted: number;
  upsertsUpdated: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  byErrorType: Record<Module2PersistenceErrorType, number>;
  pendingFlushes: number;
}

const MAX_RETRIES = Number(process.env.MOD2_PERSIST_MAX_RETRIES) || 2; // total attempts = 1 + MAX_RETRIES
const RETRY_BASE_DELAY_MS = Number(process.env.MOD2_PERSIST_RETRY_DELAY_MS) || 400;

const metrics: Module2PersistenceMetrics = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  retried: 0,
  upsertsInserted: 0,
  upsertsUpdated: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  byErrorType: { duplicate: 0, validation: 0, cast: 0, connection: 0, timeout: 0, unknown: 0 },
  pendingFlushes: 0,
};

// In-flight persistence promises, awaited by flushPendingPersistence() on shutdown.
const pending = new Set<Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const classifyMongoError = (err: any): Module2PersistenceErrorType => {
  if (!err) return "unknown";
  const code = err.code ?? err?.cause?.code;
  const name = String(err.name || "");
  const msg = String(err.message || err).toLowerCase();

  if (code === 11000 || name === "MongoBulkWriteError" && /duplicate key/.test(msg)) return "duplicate";
  if (name === "ValidationError" || name === "StrictModeError") return "validation";
  if (name === "CastError" || /cast to objectid failed|cast to /.test(msg)) return "cast";
  if (
    name === "MongoServerSelectionError" ||
    name === "MongoNetworkError" ||
    name === "MongoNotConnectedError" ||
    name === "MongooseServerSelectionError" ||
    /not connected|connection|econnreset|topology|no primary|failover|pool/.test(msg)
  ) {
    return "connection";
  }
  if (name === "MongoNetworkTimeoutError" || err.code === 50 || /timed out|timeout/.test(msg)) return "timeout";
  return "unknown";
};

const isTransient = (type: Module2PersistenceErrorType): boolean =>
  type === "connection" || type === "timeout";

const toUpsertOp = (s: Module2MinuteSnapshot) => ({
  updateOne: {
    filter: {
      session_id: s.session_id,
      strike: s.strike,
      minute_timestamp: s.minute_timestamp,
    },
    update: {
      $set: {
        ltp_integer: s.ltp_integer,
        ltp_missing: s.ltp_missing,
        is_day_high: s.is_day_high,
        is_day_low: s.is_day_low,
        pct_from_open: s.pct_from_open,
        is_downtrend_flagged: s.is_downtrend_flagged,
        oi: s.oi,
        oi_delta: s.oi_delta,
        oi_buy: s.oi_buy,
        oi_sell: s.oi_sell,
      },
    },
    upsert: true,
  },
});

const minuteLabel = (d: Date): string => {
  try {
    return d.toISOString();
  } catch {
    return String(d);
  }
};

/**
 * Persist a batch of minute snapshots (one minute boundary, all selected
 * strikes of one session) with a single idempotent bulkWrite, retrying the
 * whole batch on transient failures.
 *
 * Never throws. Returns a per-strike result so the caller can mark broadcasts
 * and expose diagnostics.
 */
export const persistMinuteSnapshots = async (
  snapshots: Module2MinuteSnapshot[]
): Promise<Module2PersistenceResult> => {
  const result: Module2PersistenceResult = {
    attempted: snapshots.length,
    succeeded: 0,
    failed: 0,
    retries: 0,
    failures: [],
  };
  if (snapshots.length === 0) return result;

  metrics.attempted += snapshots.length;

  if (mongoose.connection.readyState !== 1) {
    // Connection is down — do not pretend a write happened. Count as a
    // connection failure so /health surfaces it. No retry loop here: the
    // boundary fires again in 60s and this check runs afresh.
    const type: Module2PersistenceErrorType = "connection";
    metrics.failed += snapshots.length;
    metrics.byErrorType[type] += snapshots.length;
    metrics.lastFailureAt = new Date().toISOString();
    metrics.lastError = `MongoDB not connected (readyState=${mongoose.connection.readyState})`;
    for (const s of snapshots) {
      console.error(
        `[MODULE2][PERSISTENCE][FAILED] session=${s.session_id} strike=${s.strike} minute=${minuteLabel(s.minute_timestamp)} type=${type} error=MongoDB not connected (readyState=${mongoose.connection.readyState})`
      );
      result.failures.push({ strike: s.strike, minute: minuteLabel(s.minute_timestamp), type, message: "MongoDB not connected" });
    }
    result.failed = snapshots.length;
    return result;
  }

  const run = (async () => {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      try {
        const res = await Module2StrikeTick.bulkWrite(snapshots.map(toUpsertOp), { ordered: false });
        metrics.upsertsInserted += res.upsertedCount || 0;
        metrics.upsertsUpdated += res.matchedCount || 0;
        metrics.succeeded += snapshots.length;
        metrics.lastSuccessAt = new Date().toISOString();
        // `snapshots` may have been narrowed to the still-failing subset across
        // retries — account for the earlier partial successes too.
        result.succeeded = result.attempted - result.failed;
        if (attempt > 1) {
          console.log(
            `[MODULE2][PERSISTENCE][RECOVERED] batch=${snapshots.length} succeeded on attempt ${attempt} (session=${snapshots[0].session_id})`
          );
        }
        return;
      } catch (err: any) {
        // A bulkWrite with ordered:false can partially succeed. writeErrors
        // tells us which ops failed; the rest are already persisted.
        const writeErrors: any[] = err?.writeErrors || err?.result?.writeErrors || [];
        const okCount = snapshots.length - (writeErrors.length || snapshots.length);
        if (okCount > 0) {
          metrics.succeeded += okCount;
          metrics.lastSuccessAt = new Date().toISOString();
          result.succeeded += okCount;
        }

        // Duplicate-key errors from the upsert race are benign: the logical
        // minute already exists. Treat as success, not failure.
        const nonDuplicateErrors = writeErrors.filter((we) => (we?.code ?? we?.err?.code) !== 11000);
        const duplicateCount = writeErrors.length - nonDuplicateErrors.length;
        if (duplicateCount > 0) {
          metrics.byErrorType.duplicate += duplicateCount;
          metrics.succeeded += duplicateCount;
          result.succeeded += duplicateCount;
        }

        const failingSnapshots: Module2MinuteSnapshot[] =
          writeErrors.length > 0
            ? nonDuplicateErrors
                .map((we) => snapshots[we.index])
                .filter((s): s is Module2MinuteSnapshot => !!s)
            : snapshots;

        if (failingSnapshots.length === 0) {
          // Only duplicates / already-ok — done.
          result.succeeded = Math.min(result.succeeded, snapshots.length);
          return;
        }

        const type = classifyMongoError(
          writeErrors.length > 0 ? (nonDuplicateErrors[0]?.err || nonDuplicateErrors[0] || err) : err
        );

        if (isTransient(type) && attempt <= MAX_RETRIES) {
          metrics.retried += 1;
          result.retries += 1;
          const delay = RETRY_BASE_DELAY_MS * attempt;
          console.warn(
            `[MODULE2][PERSISTENCE][RETRY] attempt=${attempt}/${1 + MAX_RETRIES} type=${type} failing=${failingSnapshots.length} delayMs=${delay} session=${snapshots[0].session_id} error=${err?.message || err}`
          );
          await sleep(delay);
          // Retry only the still-failing snapshots.
          snapshots = failingSnapshots;
          continue;
        }

        // Give up (permanent error, or transient retries exhausted).
        metrics.failed += failingSnapshots.length;
        metrics.byErrorType[type] += failingSnapshots.length;
        metrics.lastFailureAt = new Date().toISOString();
        metrics.lastError = `${type}: ${err?.message || err}`;
        result.failed += failingSnapshots.length;
        for (const s of failingSnapshots) {
          console.error(
            `[MODULE2][PERSISTENCE][FAILED] session=${s.session_id} strike=${s.strike} minute=${minuteLabel(s.minute_timestamp)} type=${type} code=${err?.code ?? "n/a"} error=${err?.message || err}`
          );
          result.failures.push({
            strike: s.strike,
            minute: minuteLabel(s.minute_timestamp),
            type,
            message: String(err?.message || err),
          });
        }
        return;
      }
    }
  })();

  metrics.pendingFlushes = pending.size + 1;
  pending.add(run);
  try {
    await run;
  } finally {
    pending.delete(run);
    metrics.pendingFlushes = pending.size;
  }
  return result;
};

/**
 * Awaits all in-flight persistence writes. Called during graceful shutdown so a
 * Render redeploy does not drop the minute that was being written when SIGTERM
 * arrived. Bounded by the caller's shutdown timeout.
 */
export const flushPendingPersistence = async (): Promise<void> => {
  if (pending.size === 0) return;
  console.log(`[MODULE2][PERSISTENCE] Flushing ${pending.size} in-flight write batch(es) before shutdown…`);
  await Promise.allSettled(Array.from(pending));
  console.log("[MODULE2][PERSISTENCE] Flush complete.");
};

export const getModule2PersistenceMetrics = (): Module2PersistenceMetrics => ({
  ...metrics,
  byErrorType: { ...metrics.byErrorType },
  pendingFlushes: pending.size,
});

/** Test-only: reset counters. */
export const __resetModule2PersistenceMetrics = () => {
  metrics.attempted = 0;
  metrics.succeeded = 0;
  metrics.failed = 0;
  metrics.retried = 0;
  metrics.upsertsInserted = 0;
  metrics.upsertsUpdated = 0;
  metrics.lastSuccessAt = null;
  metrics.lastFailureAt = null;
  metrics.lastError = null;
  metrics.byErrorType = { duplicate: 0, validation: 0, cast: 0, connection: 0, timeout: 0, unknown: 0 };
};
