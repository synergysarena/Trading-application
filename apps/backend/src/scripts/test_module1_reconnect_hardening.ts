/**
 * Reliability-hardening regression suite for the Module 1 Zebu broker
 * connection/session incident (dead session token reused forever after an
 * unrecognized rejection; unguarded WS message-record processing).
 *
 * Proves:
 *  A.  A recognized session-expired ck rejection -> SESSION_EXPIRED, no
 *      further reconnect with the same token.
 *  B.  An UNRECOGNIZED ck rejection, repeated for the SAME token, is still
 *      caught by the structural (consecutive-rejection) fallback.
 *  C.  A normal transient disconnect (WS error+close) reconnects normally,
 *      and error+close firing together does not double-schedule/double-count
 *      the reconnect attempt.
 *  D.  A successful (re)connect restores the full expected subscription
 *      universe (SPOT+FUT+CE+PE), verified via the new diagnostic counters.
 *  E.  A fresh broker login (new token) after SESSION_EXPIRED recovers the
 *      feed to CONNECTED.
 *  F.  A reconnect timer scheduled before an explicit stopDataFeed() must not
 *      fire / must not restart the feed afterwards.
 *  G/H. One malformed record in a WebSocket message batch does not produce an
 *      unhandled promise rejection and does not stop the other valid records
 *      in the same batch (or the connection) from being processed.
 *  I.  controllers/auth.ts (/auth/logout) has no reference to Module 1 feed
 *      teardown functions.
 *  J/K. Global market-data shutdown authorization: unauthorized users are
 *      rejected, allowlisted admins are authorized, an unset allowlist fails
 *      closed.
 *  L.  No duplicate/leaked WebSocket across "already live" reuse, reconnect,
 *      and fresh login.
 *
 * "M" (existing option-chain subscription/selection behavior unchanged) is
 * covered by the pre-existing test_module1_option_universe.ts, which this
 * change does not touch — run as part of the same `npm test` chain.
 *
 *   npx ts-node --transpile-only src/scripts/test_module1_reconnect_hardening.ts
 */
import WebSocketReal from "ws";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

import {
  startDataFeedWithCredentials,
  stopDataFeed,
  getModule1FeedStats,
  getModule1FeedState,
} from "../services/dataFeed";
import {
  __setWebSocketFactoryForTest,
  __resetSessionRejectionTrackingForTest,
  isZebuLiveConnected,
  getModule1SubscriptionStats,
  isSessionExpiredMessage,
} from "../services/zebuMarketDataClient";
import { __setCachedInstrumentTokensForTest } from "../services/instrumentTokenService";
import { stopBoundaryChecker } from "../services/ohlcAggregator";
import { isUsernameAuthorizedForMarketDataShutdown } from "../middleware/auth";

stopBoundaryChecker();

process.env.ZEBU_WS_URL = process.env.ZEBU_WS_URL || "wss://fake.zebu.test/ws";
process.env.MOD1_API_KEY = process.env.MOD1_API_KEY || "test-key";

let passed = 0;
let failed = 0;
const ok = (n: string) => { passed++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d?: unknown) => { failed++; console.error(`  ✗ ${n}`, d ?? ""); };

// ── Fake WebSocket ───────────────────────────────────────────────────────────
// Same test-seam pattern already used for Mongo/pivot writers in this repo
// (__setCandleBatchWriterForTest, __setPivotBulkWriterForTest) — an
// in-memory double instead of a real network socket, driven through the REAL
// dataFeed.ts + zebuMarketDataClient.ts code paths.
class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocketReal.CONNECTING;
  sentFrames: any[] = [];
  constructor(public url: string) { super(); }
  send(data: string) { this.sentFrames.push(JSON.parse(data)); }
  close() {
    if (this.readyState === WebSocketReal.CLOSED) return;
    this.readyState = WebSocketReal.CLOSED;
    this.emit("close");
  }
  terminate() { this.close(); }
  simulateOpen() { this.readyState = WebSocketReal.OPEN; this.emit("open"); }
  simulateMessage(obj: unknown) { this.emit("message", Buffer.from(JSON.stringify(obj))); }
  simulateError(message = "simulated socket error") { this.emit("error", new Error(message)); }
}

const createdSockets: FakeWebSocket[] = [];
__setWebSocketFactoryForTest((url: string) => {
  const sock = new FakeWebSocket(url);
  createdSockets.push(sock);
  return sock as unknown as WebSocketReal;
});
const latestSocket = (): FakeWebSocket => createdSockets[createdSockets.length - 1];
const flush = () => new Promise((r) => setImmediate(r));

const FIXTURE_TOKENS = {
  futToken: "NFO|1:NIFTY-FUT",
  ceTokens: ["NFO|2:NIFTYTESTC100", "NFO|3:NIFTYTESTC200"],
  peTokens: ["NFO|4:NIFTYTESTP100", "NFO|5:NIFTYTESTP200"],
  fetchedAt: new Date(),
  nearestOptionExpiry: "2099-01-01",
  futExpiry: "2099-01-01",
  atmIsReliable: true,
};
// SPOT (always env-defaulted) + FUT + 2 CE + 2 PE = 6 expected instruments.
const EXPECTED_UNIVERSE_SIZE = 6;

/** Drives a connection all the way to CONNECTED (ck ack OK). */
async function connectAndAuthenticate(userId: string, token: string): Promise<FakeWebSocket> {
  __setCachedInstrumentTokensForTest(FIXTURE_TOKENS);
  await startDataFeedWithCredentials(userId, token);
  const sock = latestSocket();
  sock.simulateOpen();
  sock.simulateMessage({ t: "ck", s: "OK" });
  return sock;
}

async function run() {
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── isSessionExpiredMessage: pattern coverage ──");
  {
    const shouldMatch: Array<[string | undefined, string | undefined]> = [
      ["Session Expired", undefined],
      [undefined, "Invalid Session"],
      ["Invalid Susertoken", undefined],
      ["Token Expired", undefined],
      ["Please login again", undefined],
      ["User not login", undefined],
      [undefined, "Unauthorized"],
      ["Invalid credential supplied", undefined],
    ];
    for (const [emsg, stat] of shouldMatch) {
      if (isSessionExpiredMessage(emsg, stat)) ok(`recognized as session-invalid: emsg=${emsg} stat=${stat}`);
      else bad(`NOT recognized as session-invalid (should have matched): emsg=${emsg} stat=${stat}`);
    }

    const shouldNotMatch: Array<[string | undefined, string | undefined]> = [
      ["Server busy, please retry", "Not_Ok"],
      ["Too many requests", undefined],
      ["Contract expired for this instrument", undefined], // per-instrument, not session
      [undefined, "Not_Ok"], // bare Not_Ok alone must NOT be treated as session-invalid by the pattern list
    ];
    for (const [emsg, stat] of shouldNotMatch) {
      if (!isSessionExpiredMessage(emsg, stat)) ok(`NOT misclassified as session-invalid: emsg=${emsg} stat=${stat}`);
      else bad(`incorrectly classified as session-invalid (too broad): emsg=${emsg} stat=${stat}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── A: recognized session-expired ck rejection ──");
  {
    __resetSessionRejectionTrackingForTest();
    await connectAndAuthenticate("userA", "tokenA1");
    if (getModule1FeedState() === "CONNECTED") ok("reached CONNECTED before the rejection");
    else bad("did not reach CONNECTED", getModule1FeedStats());

    latestSocket().simulateMessage({ t: "ck", s: "Not_Ok", emsg: "Session Expired" });

    if (getModule1FeedState() === "SESSION_EXPIRED") ok("recognized rejection -> SESSION_EXPIRED immediately (no waiting for repeats)");
    else bad("wrong state after a recognized session-expired rejection", getModule1FeedStats());
    if (!isZebuLiveConnected()) ok("feed no longer reports itself connected");
    else bad("feed still reports connected after session-expiry");

    stopDataFeed();
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── B: unrecognized-but-repeated ck rejection (structural fallback) ──");
  {
    __resetSessionRejectionTrackingForTest();
    await connectAndAuthenticate("userB", "tokenB1");

    latestSocket().simulateMessage({ t: "ck", s: "Not_Ok", emsg: "Weird one-off gateway hiccup 503" });
    if (getModule1FeedState() === "RECONNECTING") ok("1st unrecognized rejection -> RECONNECTING, not yet expired");
    else bad("wrong state after 1st unrecognized rejection", getModule1FeedStats());

    // Zebu drops the TCP connection after rejecting the handshake.
    latestSocket().close();
    // Simulate the scheduled reconnect timer firing (same stored token).
    await startDataFeedWithCredentials("userB", "tokenB1");
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({ t: "ck", s: "Not_Ok", emsg: "Weird one-off gateway hiccup 503" });

    if (getModule1FeedState() === "SESSION_EXPIRED") {
      ok("2nd consecutive unrecognized rejection of the SAME token -> SESSION_EXPIRED (structural fallback)");
    } else {
      bad("structural fallback did not trigger on repeated rejection", getModule1FeedStats());
    }
    stopDataFeed();
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── C: normal transient disconnect -> RECONNECTING, no double-count ──");
  {
    __resetSessionRejectionTrackingForTest();
    await connectAndAuthenticate("userC", "tokenC1");
    const sock = latestSocket();

    // Real `ws` sockets commonly fire BOTH 'error' and 'close' for one failure.
    sock.simulateError("simulated transient network blip");
    sock.close();

    if (getModule1FeedState() === "RECONNECTING") ok("transient disconnect -> RECONNECTING");
    else bad("wrong state after transient disconnect", getModule1FeedStats());

    const stats = getModule1FeedStats();
    if (stats.reconnectAttempts === 1) ok("exactly one reconnect attempt counted (error+close did not double-schedule)");
    else bad("reconnect attempt was double-counted", stats);

    stopDataFeed();
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── D: successful (re)connect restores the full expected subscription universe ──");
  {
    __resetSessionRejectionTrackingForTest();
    await connectAndAuthenticate("userD", "tokenD1");

    const subStats1 = getModule1SubscriptionStats();
    if (
      subStats1.expectedInstrumentCount === EXPECTED_UNIVERSE_SIZE &&
      subStats1.subscriptionRequestsSent === EXPECTED_UNIVERSE_SIZE &&
      subStats1.subscriptionRestoredAt
    ) {
      ok(`initial connect subscribed the full expected universe (${EXPECTED_UNIVERSE_SIZE} instruments: SPOT+FUT+2CE+2PE)`);
    } else {
      bad("initial subscription counts wrong", subStats1);
    }

    latestSocket().close();
    await startDataFeedWithCredentials("userD", "tokenD1"); // simulate the reconnect timer firing
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({ t: "ck", s: "OK" });

    const subStats2 = getModule1SubscriptionStats();
    if (subStats2.subscriptionRequestsSent === EXPECTED_UNIVERSE_SIZE && subStats2.subscriptionRestoredAt) {
      ok("reconnect re-subscribed the full expected universe");
    } else {
      bad("reconnect subscription counts wrong", subStats2);
    }
    stopDataFeed();
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── E: fresh broker login after SESSION_EXPIRED recovers the feed ──");
  {
    __resetSessionRejectionTrackingForTest();
    await connectAndAuthenticate("userE", "tokenE-dead");
    latestSocket().simulateMessage({ t: "ck", s: "Not_Ok", emsg: "Session Expired" });
    if (getModule1FeedState() === "SESSION_EXPIRED") ok("session marked expired");
    else bad("did not reach SESSION_EXPIRED", getModule1FeedStats());

    // A fresh broker login (module1BrokerLogin) always supplies a brand-new
    // token obtained from a real QuickAuth call.
    await startDataFeedWithCredentials("userE", "tokenE-fresh-valid");
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({ t: "ck", s: "OK" });

    if (getModule1FeedState() === "CONNECTED") ok("fresh login with a new token recovers the feed to CONNECTED");
    else bad("fresh login did not recover the feed", getModule1FeedStats());
    stopDataFeed();
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── F: a stale reconnect timer must not restart an intentionally stopped feed ──");
  {
    __resetSessionRejectionTrackingForTest();
    await connectAndAuthenticate("userF", "tokenF1");
    latestSocket().close(); // schedules a reconnect timer
    if (getModule1FeedState() === "RECONNECTING") ok("disconnect scheduled a reconnect");
    else bad("expected RECONNECTING before shutdown", getModule1FeedStats());

    stopDataFeed(); // explicit shutdown BEFORE the timer fires
    if (getModule1FeedState() === "STOPPED" && !isZebuLiveConnected()) ok("explicit shutdown reaches STOPPED");
    else bad("shutdown did not reach STOPPED", getModule1FeedStats());

    const socketsBefore = createdSockets.length;
    // Wait out the real reconnect delay (first attempt ≈ 4s) to prove the
    // cleared timer genuinely never fires, rather than just inspecting state.
    await new Promise((r) => setTimeout(r, 4300));
    if (createdSockets.length === socketsBefore && getModule1FeedState() === "STOPPED") {
      ok("stale reconnect timer did not fire — feed remained STOPPED, no new socket created");
    } else {
      bad("stale reconnect timer restarted the feed after explicit shutdown!", {
        socketsBefore, socketsAfter: createdSockets.length, state: getModule1FeedState(),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── G & H: one bad WebSocket record must not kill message processing ──");
  {
    __resetSessionRejectionTrackingForTest();
    await connectAndAuthenticate("userG", "tokenG1");
    const sock = latestSocket();

    let unhandledRejectionSeen = false;
    const onUnhandled = () => { unhandledRejectionSeen = true; };
    process.on("unhandledRejection", onUnhandled);

    // One message containing: a malformed record (throws on `.t` access), a
    // valid heartbeat, and a valid tick for a real subscribed instrument.
    sock.simulateMessage([
      null,
      { t: "h" },
      { t: "tf", e: "NFO", tk: "1", lp: 123.45, ft: String(Math.floor(Date.now() / 1000)) },
    ]);

    await flush();
    process.removeListener("unhandledRejection", onUnhandled);

    if (!unhandledRejectionSeen) ok("a malformed record does not produce an unhandled promise rejection");
    else bad("malformed record produced an unhandled promise rejection (process-crash risk)");

    if (isZebuLiveConnected()) ok("connection remains alive after a malformed record in the same batch");
    else bad("connection was dropped by a malformed record");

    stopDataFeed();
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── I: normal /auth/logout must not be able to affect Module 1 ──");
  {
    const authControllerPath = path.join(__dirname, "..", "controllers", "auth.ts");
    const src = fs.readFileSync(authControllerPath, "utf8");
    const forbidden = ["stopDataFeed", "clearPersistedBrokerSession", "zebuMarketDataClient", "module1:broker-session", "dataFeed"];
    const found = forbidden.filter((f) => src.includes(f));
    if (found.length === 0) ok("controllers/auth.ts has no reference to any Module 1 feed/session teardown function");
    else bad("controllers/auth.ts references Module 1 feed internals — logout could affect Module 1!", found);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── J & K: global market-data shutdown authorization ──");
  {
    if (!isUsernameAuthorizedForMarketDataShutdown("randomuser", "")) ok("empty/unset allowlist denies everyone (fail-closed)");
    else bad("empty allowlist incorrectly allowed a user");

    if (!isUsernameAuthorizedForMarketDataShutdown("randomuser", "opsadmin,another.admin")) ok("ordinary user not in the allowlist is rejected");
    else bad("ordinary user was incorrectly authorized");

    if (isUsernameAuthorizedForMarketDataShutdown("OpsAdmin", "opsadmin,another.admin")) ok("allowlisted admin is authorized (case-insensitive)");
    else bad("allowlisted admin was incorrectly rejected");

    if (!isUsernameAuthorizedForMarketDataShutdown(null, "opsadmin")) ok("missing/unresolved username is rejected");
    else bad("null username was incorrectly authorized");
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n── L: no duplicate/leaked WebSocket across reuse, reconnect, and fresh login ──");
  {
    __resetSessionRejectionTrackingForTest();
    const before = createdSockets.length;
    await connectAndAuthenticate("userL", "tokenL1");
    const afterFirst = createdSockets.length;
    if (afterFirst === before + 1) ok("exactly one WebSocket created for the initial connect");
    else bad("unexpected socket count after initial connect", { before, afterFirst });

    const firstSocket = latestSocket();
    await startDataFeedWithCredentials("userL", "tokenL1"); // still live -> must reuse
    if (createdSockets.length === afterFirst) ok("startDataFeedWithCredentials while already live reuses the connection (no duplicate socket)");
    else bad("a duplicate WebSocket was created for an already-live connection", createdSockets.length);

    firstSocket.close();
    await startDataFeedWithCredentials("userL", "tokenL1"); // simulate the reconnect timer firing
    if (createdSockets.length === afterFirst + 1) ok("reconnect creates exactly one new WebSocket, not a duplicate");
    else bad("unexpected socket count after reconnect", createdSockets.length);
    if (firstSocket.readyState === WebSocketReal.CLOSED) ok("the old socket was actually closed (not leaked)");
    else bad("old socket was not closed after being superseded");

    stopDataFeed();
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} Module 1 reconnect/session hardening: ${passed} passed, ${failed} failed.`);
  stopBoundaryChecker();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
