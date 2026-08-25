import { bufferSet, bufferSetex } from "./redisWriteBuffer";
import { aggregateOHLC } from "./ohlcAggregator";
import { Tick } from "@stock/shared";
import { ingestModule1OiTick, setModule1OiDataSource, resetModule1OiMaps } from "./module1OiService";
import { recordTickReceived } from "./monitoringService";
import redis from "../config/redis";
import {
  startZebuMarketDataFeedWithCredentials, setRuntimeInstrumentTokens,
  parseInstrumentEnv, ZebuInstrument, isZebuLiveConnected,
} from "./zebuMarketDataClient";
import { broadcastBrokerStatus, resetMarketReady } from "./socketService";
import { refreshInstrumentTokens, recomputeOptionBandFromLivePrice } from "./instrumentTokenService";

let zebuClient: { close: () => void; subscribeTokens?: (instruments: ZebuInstrument[]) => void } | null = null;

// ── Broker-session persistence (for reconnection, not authentication) ─────────
//
// dataFeed's own storedUserId/storedSessionToken below are process-memory
// only — lost on a backend restart AND once handleFeedDisconnect exhausts its
// 5 reconnect attempts. The frontend's cached module1Token (sessionStorage,
// 8h JWT) has no idea either of those happened: it still shows "Active
// session" and renders the dashboard directly, skipping Module1LoginPanel —
// so nothing ever calls startDataFeedWithCredentials again and the dashboard
// sits Offline until the user manually "Switch Credentials"es back through a
// fresh login. This mirror lets a session be resumed (see
// resumeDataFeedFromPersistedSession) without asking for credentials again —
// the actual Zebu QuickAuth handshake is untouched; this only persists its
// *result* long enough to restart the feed with it later.
const BROKER_SESSION_REDIS_KEY = "module1:broker-session";
// Matches the module1 JWT's own 8h expiry (see brokerAuth.ts) — once the
// frontend's cached token would no longer be considered "active" anyway,
// there is nothing left worth resuming.
const BROKER_SESSION_TTL_SECONDS = 8 * 60 * 60;

const persistBrokerSession = (userId: string, sessionToken: string) => {
  redis.setex(BROKER_SESSION_REDIS_KEY, BROKER_SESSION_TTL_SECONDS, JSON.stringify({ userId, sessionToken }))
    .catch((err: any) => console.warn("[DataFeed] Failed to persist broker session for later resume:", err?.message || err));
};

const clearPersistedBrokerSession = () => {
  redis.del(BROKER_SESSION_REDIS_KEY).catch(() => { /* best-effort */ });
};

// True once the ATM band used at connect time was seeded from a real Redis price rather
// than the hardcoded fallback (see instrumentTokenService.ts). When false, the very first
// genuine NIFTY-SPOT/NIFTY-FUT tick this session triggers a one-time ATM-band recompute +
// runtime subscribe, so the user's actual strikes get picked up without a reconnect.
let atmIsReliableAtConnect = true;
let atmBandRecomputed = false;

/**
 * Subscribes additional option tokens on the live Zebu connection. Used by the on-demand
 * `subscribe:options` socket handler and the first-tick ATM-band recompute below. No-op
 * (logged) if there's no active connection yet — the request is simply not actionable until
 * a broker session exists.
 */
export const subscribeOptionTokens = (tokens: { exchange: string; token: string; symbol: string }[]) => {
  if (tokens.length === 0) return;
  if (!zebuClient?.subscribeTokens) {
    console.warn(`[DataFeed] subscribeOptionTokens called with no active feed connection — dropped: ${tokens.map(t => t.symbol).join(", ")}`);
    return;
  }
  const instruments: ZebuInstrument[] = tokens.map(t => ({
    key: `${t.exchange}|${t.token}`, exchange: t.exchange, token: t.token, symbol: t.symbol,
  }));
  zebuClient.subscribeTokens(instruments);
};

type TickCallback = (tick: Tick) => void;
let onTickReceived: TickCallback | null = null;

export const setOnTickReceived = (callback: TickCallback) => {
  onTickReceived = callback;
};

// ── Reconnection state ────────────────────────────────────────────────────────

let storedUserId: string | null = null;
let storedSessionToken: string | null = null;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let sessionExpired = false;

// Each call to startDataFeedWithCredentials / stopDataFeed increments this
// counter. Disconnect callbacks capture their generation at creation time and
// bail out if it no longer matches — preventing a closing old connection from
// clobbering the newly started one.
let connectionGeneration = 0;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 4000;

const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};

const handleFeedDisconnect = (reason: string, gen: number) => {
  if (gen !== connectionGeneration) {
    console.log(`[DataFeed] Ignoring stale disconnect (gen=${gen}, current=${connectionGeneration}) — reason: ${reason}`);
    return;
  }

  zebuClient = null;
  setModule1OiDataSource("SIMULATOR");

  if (sessionExpired) return;

  if (!storedUserId || !storedSessionToken) {
    console.warn("[DataFeed] No stored credentials — cannot reconnect.");
    broadcastBrokerStatus("broker-disconnected", reason, "module1");
    return;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn(`[DataFeed] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping.`);
    broadcastBrokerStatus("broker-disconnected", "Max reconnection attempts exceeded", "module1");
    storedUserId = null;
    storedSessionToken = null;
    return;
  }

  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts);
  reconnectAttempts++;
  console.log(`[DataFeed] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
  broadcastBrokerStatus("reconnecting", `Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`, "module1");

  reconnectTimer = setTimeout(async () => {
    if (!storedUserId || !storedSessionToken) return;
    if (gen !== connectionGeneration) return; // Superseded before timer fired
    await startDataFeedWithCredentials(storedUserId!, storedSessionToken!);
  }, delay);
};

const handleSessionExpired = (gen: number) => {
  if (gen !== connectionGeneration) return;

  zebuClient = null;
  sessionExpired = true;
  storedUserId = null;
  storedSessionToken = null;
  clearReconnectTimer();
  setModule1OiDataSource("SIMULATOR");
  console.warn("[DataFeed] Broker session expired — user must re-authenticate.");
  broadcastBrokerStatus("session-expired", "Broker session expired. Please reconnect.", "module1");
};

/**
 * Start the live data feed using credentials obtained from user-initiated broker login.
 * Called by module1BrokerLogin controller after successful Zebu QuickAuth.
 */
export const startDataFeedWithCredentials = async (userId: string, sessionToken: string) => {
  // Close any existing connection first
  if (zebuClient) {
    try { zebuClient.close(); } catch {}
    zebuClient = null;
  }
  clearReconnectTimer();

  // Bump generation so any in-flight disconnect callbacks from the old
  // connection are silently ignored when they eventually fire.
  const gen = ++connectionGeneration;

  // Store credentials for auto-reconnection
  storedUserId = userId;
  storedSessionToken = sessionToken;
  sessionExpired = false;
  reconnectAttempts = 0;
  // Best-effort durable copy so a later resume (session-restore path) can
  // restart the feed even after this process-memory copy is gone.
  persistBrokerSession(userId, sessionToken);

  // Clear stale market_ready flag from any previous session. Without this a
  // newly connected frontend socket receives a replay that sets marketDataReady=true
  // before any real ticks exist, triggering auto-generate against empty OHLC.
  resetMarketReady();

  // Reset the ATM-band recompute latch for this connection — see declaration above.
  atmIsReliableAtConnect = true;
  atmBandRecomputed = false;

  // Always refresh instrument tokens before connecting (handles weekly/monthly expiry)
  console.log("[DataFeed] Refreshing instrument tokens from NFO master...");
  const freshTokens = await refreshInstrumentTokens().catch(() => null);
  if (freshTokens) {
    setRuntimeInstrumentTokens(freshTokens.futToken, freshTokens.ceTokens, freshTokens.peTokens);
    // Purge any stale in-memory OI from warmup (may reference expired contracts whose
    // Redis keys had no TTL). New values arrive from live ticks within seconds.
    resetModule1OiMaps();
    atmIsReliableAtConnect = freshTokens.atmIsReliable;
    if (!atmIsReliableAtConnect) {
      console.warn("[DataFeed] ATM band was seeded from a stale fallback at connect time — will recompute from the first real spot/futures tick.");
    }
    console.log(`[DataFeed] Tokens refreshed — futures expiry: ${freshTokens.futExpiry} | option expiry: ${freshTokens.nearestOptionExpiry}`);
  } else {
    console.warn("[DataFeed] NFO token refresh failed — using .env tokens (check network / NFO URL).");
  }

  console.log(`[DataFeed] Starting live feed for user: ${userId}`);

  zebuClient = startZebuMarketDataFeedWithCredentials(
    userId,
    sessionToken,
    processIncomingTick,
    setModule1OiDataSource,
    (reason) => {
      console.warn(`[DataFeed] Feed disconnected: ${reason}`);
      handleFeedDisconnect(reason, gen);
    },
    () => handleSessionExpired(gen),
    () => {
      // Called when the Zebu WebSocket actually connects and the handshake is sent.
      // Only broadcast "live" at this point — not prematurely.
      console.log("[DataFeed] Zebu WS open — broadcasting live status");
      broadcastBrokerStatus("live", undefined, "module1");
    },
  );
};

/**
 * Stop the live feed and clear all state (called on explicit user logout or server shutdown).
 */
export const stopDataFeed = () => {
  // Invalidate any in-flight or pending disconnect callbacks
  connectionGeneration++;
  clearReconnectTimer();
  storedUserId = null;
  storedSessionToken = null;
  sessionExpired = false;
  reconnectAttempts = 0;
  if (zebuClient) {
    try { zebuClient.close(); } catch {}
    zebuClient = null;
  }
  setModule1OiDataSource("SIMULATOR");
  resetMarketReady();
  // Explicit stop (logout) means the next login should be a real one — don't
  // let a stale cached module1Token silently resume this session later.
  clearPersistedBrokerSession();
};

/**
 * Resume the live feed from a previously persisted broker session — used
 * when the frontend has a still-valid cached module1Token ("Active session")
 * but the backend has no live connection for it (process restart, exhausted
 * reconnect attempts, etc). Never prompts for credentials: if nothing
 * resumable is on record, the caller (module1ResumeSession) reports that and
 * the existing dashboard status/retry UI takes over, same as any other
 * disconnected state.
 */
export const resumeDataFeedFromPersistedSession = async (): Promise<"already-live" | "resumed" | "no-session"> => {
  if (isZebuLiveConnected()) return "already-live";

  try {
    const raw = await redis.get(BROKER_SESSION_REDIS_KEY);
    if (!raw) return "no-session";

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const { userId, sessionToken } = parsed || {};
    if (!userId || !sessionToken) return "no-session";

    console.log(`[DataFeed] Resuming persisted broker session for user: ${userId}`);
    await startDataFeedWithCredentials(userId, sessionToken);
    return "resumed";
  } catch (err: any) {
    console.warn("[DataFeed] Resume from persisted session failed:", err?.message || err);
    return "no-session";
  }
};

// ── Tick processing ───────────────────────────────────────────────────────────

let _totalTickCount = 0;
let _firstTickLogged = false;

export const processIncomingTick = async (tick: Tick) => {
  const { symbol, ltp, oi } = tick;

  _totalTickCount++;

  if (!_firstTickLogged) {
    _firstTickLogged = true;
    console.log(`[Feed] ✓ First market tick received — symbol: ${symbol} ltp: ${ltp} oi: ${oi ?? "—"}`);
  }

  if (_totalTickCount % 100 === 0) {
    console.log(`[Feed] Tick #${_totalTickCount} | symbol: ${symbol} ltp: ${ltp} oi: ${oi ?? "—"}`);
  }

  recordTickReceived();

  // Phase 6: coalesced, non-blocking Redis writes — the buffer flushes the latest
  // value per key in one pipelined request every 500ms instead of issuing 2-3
  // awaited REST calls per tick (the Phase 5 OOM root cause).
  bufferSet(`ltp:${symbol}`, ltp.toString());

  if (oi !== undefined) {
    // 25-hour TTL ensures keys expire overnight so next-day warmup never loads stale OI.
    // (Only oi:NIFTY-FUT actually reaches Redis — see redisWriteBuffer PERSISTED_KEYS;
    // option-strike OI lives in the in-memory mirror that all readers consult.)
    bufferSetex(`oi:${symbol}`, 90000, oi.toString());
  }

  ingestModule1OiTick(tick);

  // Aggregate OHLC bars for futures, NIFTY-SPOT index, and option premiums.
  // Option symbols: e.g. NIFTY03JUL26C26200 / NIFTY03JUL26P26200
  const isFut  = symbol.endsWith("-FUT") || symbol.includes("FUT");
  const isSpot = symbol === "NIFTY-SPOT";
  const isOpt  = symbol.startsWith("NIFTY") && /[CP]\d+$/.test(symbol);

  if (isFut || isSpot || isOpt) {
    await aggregateOHLC(tick,   1,   "1m");
    await aggregateOHLC(tick,   2,   "2m");
    await aggregateOHLC(tick,   3,   "3m");
    await aggregateOHLC(tick,   5,   "5m");
    await aggregateOHLC(tick,  10,  "10m");
    await aggregateOHLC(tick,  15,  "15m");
    await aggregateOHLC(tick,  30,  "30m");
    await aggregateOHLC(tick,  45,  "45m");
    await aggregateOHLC(tick,  60,   "1h");
    await aggregateOHLC(tick, 120,   "2h");
    await aggregateOHLC(tick, 180,   "3h");
    await aggregateOHLC(tick, 240,   "4h");
  }

  if (onTickReceived) {
    onTickReceived(tick);
  }
};
