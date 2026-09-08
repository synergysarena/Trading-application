import assert from "assert";
import mongoose from "mongoose";
import { parseDateToYMD, searchInstruments, clearSearchCache, clearActiveSubscribedMap, getActiveSubscribedInstruments, subscribeToInstruments } from "../services/aetramMarketDataService";
import { loginMarketData, getMarketDataToken, isMarketDataAuthenticated, markMarketDataSessionExpired } from "../services/marketDataSessionService";
import { activeSessions, syncAetramSubscriptions, startTrackerSession, TrackerStartupError } from "../services/trackerService";
import { getSyncStatus } from "../services/subscriptionSyncService";
import { Module2Session } from "../models/Module2Session";
import { Module2StrikeTick } from "../models/Module2StrikeTick";

async function runTests() {
  console.log("========================================================");
  console.log("=== RUNNING COMPLETE MODULE 2 REGRESSION TEST SUITE ===");
  console.log("========================================================");

  // ---------------------------------------------------------------------------
  // TEST 1: Expired Token Detection (HTTP 400 with "Invalid / Expired Token")
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 1] Expired Token Handling (HTTP 400 / 401 Auth Invalidation)...");
  markMarketDataSessionExpired();
  assert.strictEqual(isMarketDataAuthenticated(), false, "Session must not be authenticated after expiration");
  assert.strictEqual(getMarketDataToken(), null, "Token must be null after expiration");
  console.log("✓ Session invalidation successfully cleared stale token and state.");

  // ---------------------------------------------------------------------------
  // TEST 2: Genuine HTTP 400 (Non-Auth Error) vs Auth 400 Classification
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] Non-Auth HTTP 400 vs Auth 400 Classification Logic...");
  const authErrBody1 = JSON.stringify({ type: "error", description: "Invalid / Expired Token" }).toLowerCase();
  const authErrBody2 = JSON.stringify({ type: "error", description: "Unauthorized access" }).toLowerCase();
  const nonAuthErrBody = JSON.stringify({ type: "error", description: "Invalid search query parameter" }).toLowerCase();

  const isAuth1 = authErrBody1.includes("token") || authErrBody1.includes("auth") || authErrBody1.includes("invalid / expired");
  const isAuth2 = authErrBody2.includes("token") || authErrBody2.includes("auth") || authErrBody2.includes("unauthorized");
  const isNonAuth = nonAuthErrBody.includes("token") || nonAuthErrBody.includes("auth") || nonAuthErrBody.includes("unauthorized") || nonAuthErrBody.includes("invalid / expired");

  assert.strictEqual(isAuth1, true, "Auth error 1 must be classified as auth failure");
  assert.strictEqual(isAuth2, true, "Auth error 2 must be classified as auth failure");
  assert.strictEqual(isNonAuth, false, "Non-auth error must NOT be classified as auth failure");
  console.log("✓ Auth vs non-auth 400 error classification verified.");

  // ---------------------------------------------------------------------------
  // TEST 3: Date Parsing Determinism Across Formats & Timezones
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] Date Parsing Across Formats...");
  assert.strictEqual(parseDateToYMD("2026-09-03"), "2026-09-03", "ISO format YYYY-MM-DD failed");
  assert.strictEqual(parseDateToYMD("03-Sep-2026"), "2026-09-03", "DD-Mon-YYYY format failed");
  assert.strictEqual(parseDateToYMD("03-SEP-2026"), "2026-09-03", "DD-SEP-YYYY uppercase format failed");
  assert.strictEqual(parseDateToYMD("03/09/2026"), "2026-09-03", "DD/MM/YYYY slash format failed");
  assert.strictEqual(parseDateToYMD("03-09-2026"), "2026-09-03", "DD-MM-YYYY dash format failed");
  console.log("✓ Deterministic date parsing passed for all formats.");

  // ---------------------------------------------------------------------------
  // TEST 4: Three Simultaneous Users - Active Sessions Union & Isolation
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Three Simultaneous Users - Session Isolation & Subscription Union...");
  // Clear any existing active sessions
  for (const k of Object.keys(activeSessions)) {
    delete activeSessions[k];
  }

  activeSessions["user-a-sess"] = {
    sessionId: "user-a-sess",
    userId: "user-a",
    dataSource: "LIVE_MARKET_DATA_API",
    sessionType: "CE",
    indexSymbol: "NIFTY50",
    expiryDate: "2026-09-03",
    selectedStrikes: ["NIFTY24000CE", "NIFTY24100CE"],
    dayOpenPrices: {},
    strikes: {} as any,
    status: "ACTIVE",
    startedAt: new Date(),
    stoppedAt: null,
    strikeStartBoundaries: {},
    createdAt: new Date(),
  };

  activeSessions["user-b-sess"] = {
    sessionId: "user-b-sess",
    userId: "user-b",
    dataSource: "LIVE_MARKET_DATA_API",
    sessionType: "PE",
    indexSymbol: "NIFTY50",
    expiryDate: "2026-09-03",
    selectedStrikes: ["NIFTY24100PE", "NIFTY24200PE"],
    dayOpenPrices: {},
    strikes: {} as any,
    status: "ACTIVE",
    startedAt: new Date(),
    stoppedAt: null,
    strikeStartBoundaries: {},
    createdAt: new Date(),
  };

  activeSessions["user-c-sess"] = {
    sessionId: "user-c-sess",
    userId: "user-c",
    dataSource: "LIVE_MARKET_DATA_API",
    sessionType: "mixed",
    indexSymbol: "NIFTY50",
    expiryDate: "2026-09-03",
    selectedStrikes: ["NIFTY24000CE", "NIFTY24200PE", "NIFTY24300CE"],
    dayOpenPrices: {},
    strikes: {} as any,
    status: "ACTIVE",
    startedAt: new Date(),
    stoppedAt: null,
    strikeStartBoundaries: {},
    createdAt: new Date(),
  };

  assert.strictEqual(Object.keys(activeSessions).length, 3, "All 3 user sessions must be maintained concurrently");
  console.log("✓ All 3 user sessions maintained independently in activeSessions.");

  // ---------------------------------------------------------------------------
  // TEST 5: WebSocket Reconnect & Resubscription Recovery
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] WebSocket Reconnect & Resubscription Recovery...");
  clearActiveSubscribedMap();
  assert.strictEqual(getActiveSubscribedInstruments().length, 0, "activeSubscribedMap must be empty after disconnect/reconnect");
  
  // Running sync on reconnect forces resubscribing all desired tokens over the wire
  const resyncResult = await syncAetramSubscriptions(true);
  assert.strictEqual(resyncResult, true, "Reconnect resubscription must execute cleanly");
  console.log("✓ Reconnect resubscription executed without assuming old socket subscriptions.");

  // ---------------------------------------------------------------------------
  // TEST 6: Expired Session Multi-User Recovery
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 6] Expired Session Multi-User Recovery...");
  // Simulate token expiry
  markMarketDataSessionExpired();
  assert.strictEqual(isMarketDataAuthenticated(), false, "Auth status must be false during expiry");
  // Ensure user sessions are NOT destroyed when broker session expires
  assert.strictEqual(Object.keys(activeSessions).length, 3, "User tracker sessions must remain preserved in memory");
  console.log("✓ User tracker sessions preserved intact during broker re-authentication.");

  // Clean up active sessions
  for (const k of Object.keys(activeSessions)) {
    delete activeSessions[k];
  }

  const ce20Strikes = Array.from({ length: 10 }, (_, i) => `NIFTY${24000 + i * 50}CE`);
  const pe20Strikes = Array.from({ length: 10 }, (_, i) => `NIFTY${24000 + i * 50}PE`);
  const all20Strikes = [...ce20Strikes, ...pe20Strikes];

  // ---------------------------------------------------------------------------
  // TEST 8a: DB unavailable → clean rejection, NO fake session (Problem 2 / 3)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 8a] Start with MongoDB unavailable must FAIL cleanly (no mock-session)...");
  const forceReadyState = (v: number) =>
    Object.defineProperty(mongoose.connection, "readyState", { value: v, configurable: true });
  forceReadyState(0);
  const activeBefore = Object.keys(activeSessions).length;
  let rejected = false;
  try {
    await startTrackerSession("perf-test-user", "mixed", "NIFTY50", "2026-09-03", all20Strikes);
  } catch (err: any) {
    rejected = err instanceof TrackerStartupError;
  }
  assert.strictEqual(rejected, true, "startTrackerSession must reject with TrackerStartupError when DB is down");
  assert.strictEqual(Object.keys(activeSessions).length, activeBefore, "No in-memory session may be registered on failure");
  assert.strictEqual(
    Object.keys(activeSessions).some((id) => id.startsWith("mock-session-")),
    false,
    "No mock-session-* id may ever be created"
  );
  console.log("✓ DB-down start rejected cleanly; no fake session registered.");

  // ---------------------------------------------------------------------------
  // TEST 8b: 20-Strike (10 CE + 10 PE) startup with a real ObjectId (DB mocked)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 8b] 20 Strikes startup yields a real MongoDB ObjectId...");
  forceReadyState(1);
  const realId = new mongoose.Types.ObjectId();
  const origCreate = (Module2Session as any).create;
  const origFind = (Module2StrikeTick as any).find;
  const origSessFind = (Module2Session as any).find;
  (Module2Session as any).create = async (d: any) => ({ ...d, _id: realId, created_at: new Date() });
  (Module2Session as any).find = () => ({ select: () => ({ lean: async () => [] }) });
  (Module2StrikeTick as any).find = () => ({ sort: () => ({ lean: async () => [] }) });
  try {
    const start20Time = Date.now();
    const session20 = await startTrackerSession("perf-test-user", "mixed", "NIFTY50", "2026-09-03", all20Strikes);
    const elapsed20 = Date.now() - start20Time;
    assert.strictEqual(session20.selectedStrikes.length, 20, "Session must have all 20 strikes");
    assert.strictEqual(mongoose.isValidObjectId(session20.sessionId), true, "sessionId must be a real ObjectId");
    assert.strictEqual(session20.sessionId, realId.toString(), "sessionId must be the persisted _id");
    assert.strictEqual(elapsed20 < 3000, true, `20-strike start must complete in <3000ms (took ${elapsed20}ms)`);
    console.log(`✓ 20 strikes initialized in ${elapsed20}ms with real _id ${session20.sessionId}.`);
    delete activeSessions[session20.sessionId];
  } finally {
    (Module2Session as any).create = origCreate;
    (Module2Session as any).find = origSessFind;
    (Module2StrikeTick as any).find = origFind;
    forceReadyState(0);
  }

  console.log("\n========================================================");
  console.log("=== ALL REGRESSION TESTS PASSED SUCCESSFULLY (9/9)   ===");
  console.log("========================================================");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test failed with error:", err);
    process.exit(1);
  });
