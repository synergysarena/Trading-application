/**
 * Standalone unit tests for the Module 2 Strike Tracker persistence hardening.
 * Pure-logic + mocked-Mongo — no live database required.
 *
 *   npx ts-node apps/backend/src/scripts/test_module2_persistence.ts
 *
 * Matches the existing test style (node:assert, run directly with ts-node).
 */
import assert from "assert";
import mongoose from "mongoose";
import {
  floorToMinuteMs,
  getCanonicalMinuteDate,
  normalizeCandleTimestamp,
} from "@stock/shared";
import { Module2StrikeTick } from "../models/Module2StrikeTick";
import {
  classifyMongoError,
  persistMinuteSnapshots,
  getModule2PersistenceMetrics,
  __resetModule2PersistenceMetrics,
  Module2MinuteSnapshot,
} from "../services/module2PersistenceService";
import { isSessionStale, getTodayTradingSessionOpenMs } from "../services/trackerService";

let passed = 0;
const ok = (name: string) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const forceReadyState = (v: number) => {
  Object.defineProperty(mongoose.connection, "readyState", { value: v, configurable: true });
};

const snap = (over: Partial<Module2MinuteSnapshot> = {}): Module2MinuteSnapshot => ({
  session_id: "651111111111111111111111",
  strike: "NIFTY24800CE",
  minute_timestamp: getCanonicalMinuteDate(Date.now()),
  ltp_integer: 123,
  ltp_missing: false,
  is_day_high: false,
  is_day_low: false,
  pct_from_open: 0,
  is_downtrend_flagged: false,
  oi: 1000,
  oi_delta: 0,
  oi_buy: 0,
  oi_sell: 0,
  ...over,
});

async function run() {
  console.log("\n── PHASE A: timestamp normalization ──");
  {
    const ts = Date.parse("2026-09-08T10:30:37.912Z");
    assert.strictEqual(floorToMinuteMs(ts), Date.parse("2026-09-08T10:30:00.000Z"));
    ok("floorToMinuteMs zeroes seconds & milliseconds");

    const d = getCanonicalMinuteDate(ts);
    assert.strictEqual(d.getUTCSeconds(), 0);
    assert.strictEqual(d.getUTCMilliseconds(), 0);
    ok("getCanonicalMinuteDate returns a clean minute boundary Date");

    // Idempotency: two instants in the same clock minute → identical key
    const a = getCanonicalMinuteDate(Date.parse("2026-09-08T10:30:00.001Z")).getTime();
    const b = getCanonicalMinuteDate(Date.parse("2026-09-08T10:30:59.999Z")).getTime();
    assert.strictEqual(a, b);
    ok("all instants within a minute map to ONE canonical key (unique-index safe)");

    assert.strictEqual(normalizeCandleTimestamp(ts).minuteStartMs, floorToMinuteMs(ts));
    ok("normalizeCandleTimestamp().minuteStartMs agrees with floorToMinuteMs");
  }

  console.log("\n── PHASE B: MongoDB error classification ──");
  {
    assert.strictEqual(classifyMongoError({ code: 11000 }), "duplicate");
    assert.strictEqual(classifyMongoError({ name: "ValidationError" }), "validation");
    assert.strictEqual(classifyMongoError({ name: "CastError", message: "Cast to ObjectId failed" }), "cast");
    assert.strictEqual(classifyMongoError({ name: "MongoNotConnectedError", message: "Client must be connected" }), "connection");
    assert.strictEqual(classifyMongoError({ name: "MongoServerSelectionError", message: "no primary" }), "connection");
    assert.strictEqual(classifyMongoError({ message: "operation exceeded time limit, timed out" }), "timeout");
    assert.strictEqual(classifyMongoError({ message: "something weird" }), "unknown");
    ok("classifyMongoError distinguishes duplicate/validation/cast/connection/timeout/unknown");
  }

  console.log("\n── PHASE B: persistence never silently swallows ──");
  {
    __resetModule2PersistenceMetrics();
    forceReadyState(0); // DB "down"
    const r = await persistMinuteSnapshots([snap(), snap({ strike: "NIFTY24800PE" })]);
    assert.strictEqual(r.failed, 2, "both snapshots recorded as failed");
    assert.strictEqual(r.succeeded, 0);
    const m = getModule2PersistenceMetrics();
    assert.strictEqual(m.failed, 2);
    assert.strictEqual(m.byErrorType.connection, 2);
    assert.ok(m.lastError && m.lastError.includes("not connected"));
    ok("DB-down → failures counted + lastError set, no throw, no silent success");
  }

  console.log("\n── PHASE 9/18: idempotent bulkWrite upsert ──");
  {
    __resetModule2PersistenceMetrics();
    forceReadyState(1);
    const calls: any[] = [];
    const orig = (Module2StrikeTick as any).bulkWrite;
    (Module2StrikeTick as any).bulkWrite = async (ops: any[], opts: any) => {
      calls.push({ ops, opts });
      return { upsertedCount: ops.length, matchedCount: 0, modifiedCount: 0 };
    };
    try {
      const r = await persistMinuteSnapshots([snap(), snap({ strike: "NIFTY24850CE" })]);
      assert.strictEqual(r.succeeded, 2);
      assert.strictEqual(r.failed, 0);
      assert.strictEqual(calls.length, 1, "exactly ONE bulkWrite for the whole minute");
      assert.strictEqual(calls[0].opts.ordered, false);
      const op = calls[0].ops[0].updateOne;
      assert.deepStrictEqual(Object.keys(op.filter).sort(), ["minute_timestamp", "session_id", "strike"]);
      assert.strictEqual(op.upsert, true);
      ok("one unordered bulkWrite, filter is exactly the unique-index triple, upsert:true");
    } finally {
      (Module2StrikeTick as any).bulkWrite = orig;
    }
  }

  console.log("\n── PHASE 19: bounded retry on transient failure ──");
  {
    __resetModule2PersistenceMetrics();
    forceReadyState(1);
    let attempts = 0;
    const orig = (Module2StrikeTick as any).bulkWrite;
    (Module2StrikeTick as any).bulkWrite = async (ops: any[]) => {
      attempts += 1;
      if (attempts < 2) {
        const e: any = new Error("connection reset by peer");
        e.name = "MongoNetworkError";
        throw e;
      }
      return { upsertedCount: ops.length, matchedCount: 0, modifiedCount: 0 };
    };
    try {
      const r = await persistMinuteSnapshots([snap()]);
      assert.strictEqual(attempts, 2, "retried once then succeeded");
      assert.strictEqual(r.succeeded, 1);
      assert.ok(r.retries >= 1);
      ok("transient error is retried within bounds and then succeeds");
    } finally {
      (Module2StrikeTick as any).bulkWrite = orig;
    }
  }

  console.log("\n── PHASE 19: permanent errors are NOT retried ──");
  {
    __resetModule2PersistenceMetrics();
    forceReadyState(1);
    let attempts = 0;
    const orig = (Module2StrikeTick as any).bulkWrite;
    (Module2StrikeTick as any).bulkWrite = async () => {
      attempts += 1;
      const e: any = new Error("document failed validation");
      e.name = "ValidationError";
      throw e;
    };
    try {
      const r = await persistMinuteSnapshots([snap()]);
      assert.strictEqual(attempts, 1, "validation error tried exactly once");
      assert.strictEqual(r.failed, 1);
      assert.strictEqual(getModule2PersistenceMetrics().byErrorType.validation, 1);
      ok("permanent (validation) error fails fast, counted, not retried");
    } finally {
      (Module2StrikeTick as any).bulkWrite = orig;
    }
  }

  console.log("\n── PHASE D: trading-day staleness rule ──");
  {
    const open = getTodayTradingSessionOpenMs();
    assert.strictEqual(isSessionStale({ started_at: new Date(open + 60_000) }), false);
    assert.strictEqual(isSessionStale({ started_at: new Date(open - 24 * 3600 * 1000) }), true);
    assert.strictEqual(isSessionStale({ started_at: null, created_at: null }), false);
    ok("today's session is not stale; a previous-day ACTIVE session is stale");
  }

  console.log(`\n✅ All ${passed} Module 2 persistence assertions passed.\n`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ TEST FAILURE:\n", err);
    process.exit(1);
  });
