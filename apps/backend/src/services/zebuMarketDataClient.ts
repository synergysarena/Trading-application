import WebSocket from "ws";
import { Tick } from "@stock/shared";
import { getZebuOAuthMissingConfig, resolveZebuSessionToken } from "./zebuOAuthService";
import { debugLog } from "../utils/logger";

type DataSource = "LIVE_MARKET_API" | "SIMULATOR";

// Test seam: lets a regression test drive the Zebu reconnect/session-expiry state
// machine with a fake, in-memory WebSocket instead of a real network socket —
// same pattern already used for the Mongo/pivot writers (see ohlcAggregator.ts,
// pivotService.ts). Production always uses the real `ws` client.
type WebSocketFactory = (url: string) => WebSocket;
let _wsFactory: WebSocketFactory = (url: string) => new WebSocket(url);
export const __setWebSocketFactoryForTest = (fn: WebSocketFactory | null): void => {
  _wsFactory = fn || ((url: string) => new WebSocket(url));
};

let wsConnected = false;
export const isZebuLiveConnected = () => wsConnected;

// Runtime token overrides (set by instrumentTokenService after NFO refresh)
let runtimeFutToken: string | null = null;
let runtimeCeTokens: string | null = null;
let runtimePeTokens: string | null = null;

export const setRuntimeInstrumentTokens = (
  futToken: string | null,
  ceTokens: string[],
  peTokens: string[]
) => {
  runtimeFutToken = futToken || null;
  runtimeCeTokens = ceTokens.length > 0 ? ceTokens.join(",") : null;
  runtimePeTokens = peTokens.length > 0 ? peTokens.join(",") : null;
  console.log(`[Zebu] Runtime tokens updated — FUT: ${futToken ? "set" : "null"} | CE: ${ceTokens.length} | PE: ${peTokens.length}`);
};

export interface ZebuInstrument {
  key: string;
  exchange: string;
  token: string;
  symbol: string;
}

interface ZebuClient {
  close: () => void;
  // Subscribes additional instruments on an already-open connection (Noren allows
  // incremental "t":"t" subscribe frames). Only present on the credentials-based client.
  subscribeTokens?: (instruments: ZebuInstrument[]) => void;
}

const isPlaceholder = (value?: string) =>
  !value || value.includes("your-") || value.includes("placeholder");

const getZebuWsUrl = () => process.env.ZEBU_WS_URL || process.env.CLIENT_API_URL || "";
const getZebuUserId = () => process.env.ZEBU_CLIENT_ID || process.env.ZEBU_USER_ID || "";
const getZebuAccountId = () => process.env.ZEBU_ACCOUNT_ID || getZebuUserId();
const getZebuSessionToken = () => process.env.ZEBU_SUSERTOKEN || process.env.ZEBU_SESSION_TOKEN || "";

const sanitizeFeedUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url ? "[configured]" : "[missing]";
  }
};

export const parseInstrumentEnv = (value?: string): ZebuInstrument[] => {
  if (!value || isPlaceholder(value)) return [];

  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [exchangeToken, symbolFromEnv] = part.split(":");
      const [exchange, token] = exchangeToken.split("|");
      if (!exchange || !token || !symbolFromEnv) return null;

      return {
        key: `${exchange}|${token}`,
        exchange,
        token,
        symbol: symbolFromEnv,
      };
    })
    .filter((instrument): instrument is ZebuInstrument => instrument !== null);
};

const getModule1ZebuInstruments = () => [
  ...parseInstrumentEnv(process.env.ZEBU_NIFTY_SPOT_TOKEN || "NSE|26000:NIFTY-SPOT"),
  ...parseInstrumentEnv(runtimeFutToken || process.env.ZEBU_NIFTY_FUT_TOKEN),
  ...parseInstrumentEnv(runtimeCeTokens || process.env.ZEBU_NIFTY_CE_TOKENS),
  ...parseInstrumentEnv(runtimePeTokens || process.env.ZEBU_NIFTY_PE_TOKENS),
];

export const getZebuMissingConfig = () => {
  const missing: string[] = [];
  const wsUrl = getZebuWsUrl();
  const instruments = getModule1ZebuInstruments();

  if (!/^wss?:\/\//.test(wsUrl) || isPlaceholder(wsUrl)) missing.push("ZEBU_WS_URL or CLIENT_API_URL");
  if (isPlaceholder(getZebuUserId())) missing.push("ZEBU_CLIENT_ID or ZEBU_USER_ID");
  
  const hasDirectAuth = !isPlaceholder(process.env.ZEBU_PASSWORD) &&
                        !isPlaceholder(process.env.ZEBU_FACTOR2) &&
                        !isPlaceholder(process.env.ZEBU_VENDOR_CODE) &&
                        !isPlaceholder(process.env.ZEBU_LOGIN_URL);
  
  const hasToken = !isPlaceholder(getZebuSessionToken());
  const hasOAuth = getZebuOAuthMissingConfig().length === 0;

  if (!hasToken && !hasDirectAuth && !hasOAuth) {
    missing.push("ZEBU_SUSERTOKEN/ZEBU_SESSION_TOKEN, QuickAuth credentials, or complete Zebu OAuth config");
  }
  if (isPlaceholder(process.env.MOD1_API_KEY)) missing.push("MOD1_API_KEY");
  if (isPlaceholder(process.env.MOD1_API_SECRET)) missing.push("MOD1_API_SECRET");
  if (instruments.length === 0) {
    missing.push("ZEBU_NIFTY_FUT_TOKEN, ZEBU_NIFTY_CE_TOKENS, ZEBU_NIFTY_PE_TOKENS");
  }

  return missing;
};

export const isZebuMarketDataConfigured = () => getZebuMissingConfig().length === 0;

const buildInstrumentMap = (instruments: ZebuInstrument[]) => {
  const symbolByKey = new Map<string, string>();
  for (const instrument of instruments) {
    symbolByKey.set(instrument.key, instrument.symbol);
    symbolByKey.set(instrument.token, instrument.symbol);
  }
  return symbolByKey;
};

// Zebu/Noren "tf" (touchline feed) messages are DELTA updates: t, e, and tk are always
// present, but every other field (lp, oi, v, ...) is included only when it CHANGED since
// the last message for that token. A delta that changes OI/volume without price is a
// perfectly valid, common message — it must not be discarded just because it lacks lp.
// We carry forward the last known price per symbol so such deltas still produce a usable
// Tick (OI/volume update) instead of being dropped and logged as "unrecognized".
const lastKnownLtp = new Map<string, number>();

// Controlled diagnostic logging for Module 1 raw tick verification
let diagFutTickCount = 0;
let diagSpotTickCount = 0;
const MAX_DIAG_TICKS = 20;

const parseZebuTimestamp = (rawFt?: any): Date => {
  if (!rawFt) return new Date();
  const num = Number(rawFt);
  if (Number.isFinite(num) && num > 0) {
    // If epoch > 1e11 it's in milliseconds; if <= 1e11 it's in seconds
    return num > 1e11 ? new Date(num) : new Date(num * 1000);
  }
  return new Date();
};

const logDiagnosticTick = (payload: any, tick: Tick) => {
  const isFut = tick.symbol === "NIFTY-FUT";
  const isSpot = tick.symbol === "NIFTY-SPOT";
  if (!isFut && !isSpot) return;

  if (isFut && diagFutTickCount < MAX_DIAG_TICKS) {
    diagFutTickCount++;
    debugLog(
      `[ZEBU TICK DIAG][FUT #${diagFutTickCount}/${MAX_DIAG_TICKS}] ` +
      `symbol=${tick.symbol} ltp=${tick.ltp} rawLtp=${payload.lp ?? payload.ltp ?? "—"} ` +
      `rawO=${payload.o ?? "—"} rawH=${payload.h ?? "—"} rawL=${payload.l ?? "—"} rawC=${payload.c ?? "—"} ` +
      `ft=${payload.ft ?? "—"} ts=${tick.timestamp.toISOString()} vol=${tick.volume} oi=${tick.oi ?? "—"}`
    );
  } else if (isSpot && diagSpotTickCount < MAX_DIAG_TICKS) {
    diagSpotTickCount++;
    debugLog(
      `[ZEBU TICK DIAG][SPOT #${diagSpotTickCount}/${MAX_DIAG_TICKS}] ` +
      `symbol=${tick.symbol} ltp=${tick.ltp} rawLtp=${payload.lp ?? payload.ltp ?? "—"} ` +
      `rawO=${payload.o ?? "—"} rawH=${payload.h ?? "—"} rawL=${payload.l ?? "—"} rawC=${payload.c ?? "—"} ` +
      `ft=${payload.ft ?? "—"} ts=${tick.timestamp.toISOString()}`
    );
  }
};

const toTick = (payload: any, symbolByKey: Map<string, string>): Tick | null => {
  const exchange = payload.e || payload.exch || payload.exchange;
  const token = payload.tk || payload.token || payload.instrumentToken;
  const mappedSymbol = symbolByKey.get(`${exchange}|${token}`) || symbolByKey.get(String(token));
  const symbol = mappedSymbol || payload.tsym || payload.tradingSymbol || payload.symbol;
  const rawLtp = payload.lp ?? payload.ltp ?? payload.lastPrice ?? payload.last_price ?? payload.price;
  const rawOi = payload.oi ?? payload.openInterest ?? payload.open_interest;

  if (!symbol) return null;

  const symbolKey = String(symbol);
  let ltp = Number(rawLtp);

  if (Number.isNaN(ltp)) {
    // No price in this delta (e.g. OI-only or volume-only update). Fall back to the last
    // known price for this symbol so the tick still carries a valid ltp downstream.
    const carried = lastKnownLtp.get(symbolKey);
    if (carried === undefined) return null; // No price ever seen yet for this symbol — nothing to report.
    ltp = carried;
  } else {
    lastKnownLtp.set(symbolKey, ltp);
  }

  const tick: Tick = {
    symbol: symbolKey,
    ltp,
    timestamp: parseZebuTimestamp(payload.ft),
    volume: payload.v ? Number(payload.v) : payload.volume ? Number(payload.volume) : 0,
    oi: rawOi !== undefined ? Number(rawOi) : undefined,
    exchange: exchange ? String(exchange) : undefined,
  };

  logDiagnosticTick(payload, tick);

  return tick;
};

export const startZebuMarketDataFeed = (
  onTick: (tick: Tick) => Promise<void>,
  onDataSource: (dataSource: DataSource) => void,
  onFallback: (reason: string) => void,
): ZebuClient => {
  const wsUrl = getZebuWsUrl();
  const instruments = getModule1ZebuInstruments();
  const symbolByKey = buildInstrumentMap(instruments);
  const subscribeKeys = instruments.map((instrument) => instrument.key).join("#");

  console.log(`[Module1/Zebu] Connecting to live feed: ${sanitizeFeedUrl(wsUrl)}`);

  const ws = new WebSocket(wsUrl);
  let liveConnected = false;

  ws.on("open", async () => {
    wsConnected = true;
    let sessionToken: string | null = null;
    try {
      sessionToken = await resolveZebuSessionToken();
    } catch (error) {
      ws.close();
      onFallback("Zebu OAuth token exchange failed");
      return;
    }

    if (!sessionToken) {
      ws.close();
      onFallback("missing Zebu session token and OAuth token exchange config");
      return;
    }

    const connectMessage = {
      t: "c",
      uid: getZebuUserId(),
      actid: getZebuAccountId(),
      susertoken: sessionToken,
      source: process.env.ZEBU_SOURCE || "API",
    };

    ws.send(JSON.stringify(connectMessage));
    ws.send(JSON.stringify({ t: "t", k: subscribeKeys }));

    liveConnected = true;
    onDataSource("LIVE_MARKET_API");
    console.log("[Module1/Zebu] Live feed connected");
  });

  ws.on("message", async (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      const records = Array.isArray(payload) ? payload : [payload];

      for (const record of records) {
        const tick = toTick(record, symbolByKey);
        if (tick) await onTick(tick);
      }
    } catch (error) {
      console.warn("[Module1/Zebu] Ignored malformed market tick payload.");
    }
  });

  ws.on("close", () => {
    wsConnected = false;
    const reason = liveConnected ? "live feed closed" : "live feed closed before connection";
    onDataSource("SIMULATOR");
    onFallback(reason);
  });

  ws.on("error", () => {
    wsConnected = false;
    onDataSource("SIMULATOR");
    onFallback("live feed connection error");
  });

  return {
    close: () => ws.close(),
  };
};

/**
 * Start Zebu feed using runtime credentials (from user-initiated broker login).
 * Instruments remain env-configured (they are configuration, not credentials).
 */
// Deliberately scoped to phrases that are ONLY meaningful for a connection-ack
// (t:"ck") rejection — i.e. the session/credentials themselves, never a
// per-instrument/market-data condition. Generic words like "Not_Ok" or "login"
// are excluded here on purpose: a `ck` rejection can legitimately carry a vague
// `Not_Ok` for reasons that are NOT session invalidity (e.g. a transient
// broker-side hiccup), and misclassifying that as "session expired" would force
// a user to re-login when a plain reconnect would have worked. Anything this
// list doesn't recognize is still caught by the repeated-rejection fallback
// below (see shouldTreatSessionAsInvalid), which is what actually protects
// against reusing a definitely-dead token forever.
export const SESSION_EXPIRY_PATTERNS = [
  // Explicit session/token expiry or invalidity
  "session expired", "session is expired", "session has expired", "sessionexpired",
  "invalid session", "session invalid", "invalid susertoken", "invalid session key",
  "susertoken",
  "token expired", "token has expired", "expired token", "token invalid", "invalid token",
  // Explicit re-authentication requirements
  "please login", "please re-login", "please login again", "login again", "relogin required",
  "user not login", "not logged in", "login required", "re-authenticate", "reauthenticate",
  // Explicit unauthorized/credential rejection (not a generic "Not_Ok")
  "unauthorized", "unauthorised", "authentication failed", "auth failed", "invalid user",
  "invalid credential", "invalid login",
];

export const isSessionExpiredMessage = (emsg?: string, stat?: string): boolean => {
  const combined = `${emsg || ""} ${stat || ""}`.toLowerCase();
  return SESSION_EXPIRY_PATTERNS.some(p => combined.includes(p));
};

// ── Repeated-rejection fallback ─────────────────────────────────────────────
// Structural safety net for a `ck` rejection whose wording isn't recognized by
// SESSION_EXPIRY_PATTERNS above. A `ck` frame exists ONLY to validate the
// connect handshake (uid/actid/susertoken) — there is no legitimate reason for
// the SAME session token to be rejected by it more than once in a row. If it
// is, the token is being treated as invalid regardless of the exact wording,
// which is what stops the old "reuse the same dead token forever" loop even
// when Zebu's rejection text doesn't match a known phrase.
const SESSION_INVALID_REJECT_THRESHOLD =
  Math.max(1, Number(process.env.MODULE1_SESSION_INVALID_REJECT_THRESHOLD) || 2);
let lastRejectedSessionToken: string | null = null;
let consecutiveSessionRejections = 0;

export const __resetSessionRejectionTrackingForTest = (): void => {
  lastRejectedSessionToken = null;
  consecutiveSessionRejections = 0;
};

/**
 * Decides whether a `ck` rejection means "this session token is dead" (stop
 * retrying it) as opposed to "transient — keep reconnecting with it". Never
 * throws; always returns a definite true/false so the caller's branch stays
 * deterministic and explainable in logs.
 */
const shouldTreatSessionAsInvalid = (
  sessionToken: string,
  emsg?: string,
  stat?: string
): { invalid: boolean; matchedKnownPattern: boolean; consecutiveRejections: number } => {
  const matchedKnownPattern = isSessionExpiredMessage(emsg, stat);

  if (lastRejectedSessionToken === sessionToken) {
    consecutiveSessionRejections++;
  } else {
    lastRejectedSessionToken = sessionToken;
    consecutiveSessionRejections = 1;
  }

  const invalid = matchedKnownPattern || consecutiveSessionRejections >= SESSION_INVALID_REJECT_THRESHOLD;
  return { invalid, matchedKnownPattern, consecutiveRejections: consecutiveSessionRejections };
};

/** Called on any successful `ck` ack — the token just proved itself valid. */
const clearSessionRejectionTracking = (): void => {
  lastRejectedSessionToken = null;
  consecutiveSessionRejections = 0;
};

// Dynamic runtime subscriptions (e.g. option strikes requested by user)
// Preserved across WebSocket reconnect cycles so reconnected feed immediately resubscribes them.
const dynamicSubscribedInstruments = new Map<string, ZebuInstrument>();

export const clearDynamicSubscribedInstruments = () => {
  dynamicSubscribedInstruments.clear();
};

// ── Subscription-restoration diagnostics (lightweight, not per-tick) ───────
// Read by getModule1SubscriptionStats() so an incident can answer "how many
// instruments did we expect vs. actually request on the last (re)connect".
let lastSubscriptionStats = {
  expectedInstrumentCount: 0,
  subscriptionRequestsSent: 0,
  subscriptionRestoredAt: null as number | null,
};

export const getModule1SubscriptionStats = () => ({ ...lastSubscriptionStats });

export const startZebuMarketDataFeedWithCredentials = (
  userId: string,
  sessionToken: string,
  onTick: (tick: Tick) => Promise<void>,
  onDataSource: (dataSource: DataSource) => void,
  onFallback: (reason: string) => void,
  onSessionExpired?: () => void,
  onConnected?: () => void,
): ZebuClient => {
  const wsUrl = getZebuWsUrl();
  const baseInstruments = getModule1ZebuInstruments();
  const extraInstruments = Array.from(dynamicSubscribedInstruments.values());
  const allInstrumentsMap = new Map<string, ZebuInstrument>();
  for (const inst of [...baseInstruments, ...extraInstruments]) {
    allInstrumentsMap.set(inst.key, inst);
  }
  const instruments = Array.from(allInstrumentsMap.values());
  const symbolByKey = buildInstrumentMap(instruments);
  const subscribeKeys = instruments.map((i) => i.key).join("#");

  if (!wsUrl || !/^wss?:\/\//.test(wsUrl)) {
    console.warn("[Feed] ZEBU_WS_URL not configured — cannot start live feed.");
    onFallback("ZEBU_WS_URL not configured");
    return { close: () => {} };
  }

  let tickCount = 0;
  let lastPayload: any = null;
  let liveConnected = false;
  let subscriptionSent = false;
  let firstTickLoggedThisConnection = false;

  // Snapshot the expected universe for this connection attempt up front —
  // used both for the "Instrument list" summary log and the subscription-
  // restoration diagnostics below.
  const optCount = instruments.filter(i => /[CP]\d+$/.test(i.symbol)).length;
  const ceCount = instruments.filter(i => /C\d+$/.test(i.symbol)).length;
  const peCount = instruments.filter(i => /P\d+$/.test(i.symbol)).length;
  let subscriptionRequestsSent = 0;
  lastSubscriptionStats = {
    expectedInstrumentCount: instruments.length,
    subscriptionRequestsSent: 0,
    subscriptionRestoredAt: null,
  };

  // ── Runtime (post-connect) subscription support ────────────────────────────
  // Lets the rest of the app (on-demand option requests, ATM-band recompute once a real
  // price arrives) add tokens to an already-open connection instead of requiring a
  // reconnect. Noren accepts additional "t":"t" frames at any point after the initial
  // subscribe — each just adds to what the connection already receives.
  const subscribedKeys = new Set<string>(instruments.map((i) => i.key));
  let pendingExtra: ZebuInstrument[] = [];

  // Noren accepts a '#'-delimited key list per {t:"t"} frame. The full NIFTY
  // option chain can be several hundred instruments, so the initial subscribe is
  // chunked into bounded frames rather than one very large one.
  const SUBSCRIBE_CHUNK = Number(process.env.MODULE1_SUBSCRIBE_CHUNK) || 100;
  const sendSubscribe = (toSend: ZebuInstrument[], label: string) => {
    if (toSend.length === 0) return;
    for (let i = 0; i < toSend.length; i += SUBSCRIBE_CHUNK) {
      const slice = toSend.slice(i, i + SUBSCRIBE_CHUNK);
      const keys = slice.map((x) => x.key).join("#");
      ws.send(JSON.stringify({ t: "t", k: keys }));
      const part = toSend.length > SUBSCRIBE_CHUNK ? ` [${i + 1}-${i + slice.length}/${toSend.length}]` : "";
      console.log(`[Feed:SUB] ${label}${part} — ${slice.length} instrument(s): ${keys.substring(0, 160)}${keys.length > 160 ? "…" : ""}`);
    }
    subscriptionRequestsSent += toSend.length;
    lastSubscriptionStats = { ...lastSubscriptionStats, subscriptionRequestsSent };
  };

  const subscribeTokens = (newInstruments: ZebuInstrument[]) => {
    const fresh = newInstruments.filter((i) => !subscribedKeys.has(i.key));
    if (fresh.length === 0) return;

    for (const inst of fresh) {
      subscribedKeys.add(inst.key);
      dynamicSubscribedInstruments.set(inst.key, inst);
      symbolByKey.set(inst.key, inst.symbol);
      symbolByKey.set(inst.token, inst.symbol);
    }

    if (subscriptionSent && ws.readyState === WebSocket.OPEN) {
      sendSubscribe(fresh, "Runtime subscribe");
    } else {
      // Connection not authenticated / initial subscribe not sent yet — queue and flush
      // once the ck-ack handler sends the initial batch (see below).
      pendingExtra.push(...fresh);
      console.log(`[Feed:SUB] Queued ${fresh.length} instrument(s) for subscribe once connected: ${fresh.map((i) => i.symbol).join(", ")}`);
    }
  };

  // Per-minute message statistics (all message types, not just ticks)
  let msgCountThisMinute = 0;
  let totalMsgCount = 0;
  const statsInterval = setInterval(() => {
    debugLog(`[Feed:STATS] Messages/min: ${msgCountThisMinute} | Total messages: ${totalMsgCount} | Ticks: ${tickCount} | Instruments: ${instruments.length}`);
    if (lastPayload) {
      debugLog(`[Feed:STATS] Last tick — symbol=${lastPayload.symbol} ltp=${lastPayload.ltp} oi=${lastPayload.oi ?? "—"} ts=${lastPayload.timestamp?.toISOString?.() ?? "—"}`);
    } else {
      console.warn("[Feed:STATS] No ticks received yet — waiting for Zebu to stream data.");
    }
    msgCountThisMinute = 0;
  }, 60000);

  // ── Silent-failure watchdog ─────────────────────────────────────────────────
  // Zebu sends a "t":"h" heartbeat periodically even when no instrument has a
  // fresh price, so ANY message (heartbeat, snapshot, tick, even a malformed
  // frame) is proof the socket is genuinely alive. If NOTHING arrives for
  // IDLE_TIMEOUT_MS, the socket is open but not actually delivering data — close
  // it and let the existing close/reconnect flow recover it normally. This is
  // deliberately generous so a quiet options market never trips it; it only
  // catches a socket that has gone completely silent.
  const IDLE_TIMEOUT_MS = Math.max(15_000, Number(process.env.MODULE1_WS_IDLE_TIMEOUT_MS) || 90_000);
  const IDLE_CHECK_INTERVAL_MS = Math.max(5_000, Number(process.env.MODULE1_WS_IDLE_CHECK_INTERVAL_MS) || 15_000);
  let lastActivityAt = Date.now();
  let idleWatchdogFired = false;
  const idleWatchdogInterval = setInterval(() => {
    if (idleWatchdogFired) return;
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs > IDLE_TIMEOUT_MS) {
      idleWatchdogFired = true;
      console.warn(
        `[Feed] Idle watchdog: no messages (not even a heartbeat) from Zebu for ${idleMs}ms ` +
        `(limit ${IDLE_TIMEOUT_MS}ms) — closing the socket so the normal reconnect flow can recover it.`
      );
      try {
        if (typeof (ws as any).terminate === "function") (ws as any).terminate();
        else ws.close();
      } catch { /* the close/error handler below will still run the reconnect flow */ }
    }
  }, IDLE_CHECK_INTERVAL_MS);

  console.log(`[Feed] Connecting with session for user: ${userId} | URL: ${sanitizeFeedUrl(wsUrl)}`);
  {
    // Summary only — the full option chain can be several hundred instruments;
    // dumping every line on each (re)connect floods the log. Set
    // MODULE1_FEED_LIST_VERBOSE=true to print the complete list when debugging.
    console.log(
      `[Feed] Instrument list: ${instruments.length} total ` +
      `(${ceCount} CE + ${peCount} PE + ${instruments.length - optCount} index/futures).`
    );
    if (process.env.MODULE1_FEED_LIST_VERBOSE === "true") {
      for (const inst of instruments) console.log(`  [Feed]   ${inst.key} → ${inst.symbol}`);
    } else {
      for (const inst of instruments.slice(0, 6)) console.log(`  [Feed]   ${inst.key} → ${inst.symbol}`);
      if (instruments.length > 6) console.log(`  [Feed]   … and ${instruments.length - 6} more (set MODULE1_FEED_LIST_VERBOSE=true for all)`);
    }
  }
  if (instruments.length === 0) {
    console.error("[Feed] FATAL: No instruments configured. Set ZEBU_NIFTY_FUT_TOKEN, ZEBU_NIFTY_CE_TOKENS, ZEBU_NIFTY_PE_TOKENS in .env");
  }

  const ws = _wsFactory(wsUrl);

  ws.on("open", () => {
    wsConnected = true;
    // Send connection handshake. Do NOT send subscription here.
    // Per Zebu NorenWS protocol, subscription (t:"t") must wait for the
    // server's connection ack (t:"ck", s:"OK") — see message handler below.
    const connectMsg = {
      t: "c",
      uid:        userId,
      actid:      userId,
      susertoken: sessionToken,
      source:     process.env.ZEBU_SOURCE || "API",
    };
    console.log(`[Feed] WS open — sending connect handshake for user: ${userId}`);
    ws.send(JSON.stringify(connectMsg));
    liveConnected = true;
    onDataSource("LIVE_MARKET_API");
    // onConnected is intentionally NOT called here. It is called after the
    // Zebu ck ack confirms the session is accepted and subscription is sent.
  });

  ws.on("message", async (raw) => {
    // Any inbound byte — heartbeat, snapshot, tick, even something malformed —
    // proves the socket is alive. Reset the idle watchdog unconditionally.
    lastActivityAt = Date.now();
    const rawStr = raw.toString();
    msgCountThisMinute++;
    totalMsgCount++;

    let payload: any;
    try {
      payload = JSON.parse(rawStr);
    } catch {
      console.warn(`[Feed:RAW] Non-JSON message received: ${rawStr.substring(0, 300)}`);
      return;
    }

    const records = Array.isArray(payload) ? payload : [payload];

    for (const record of records) {
      // Fault isolation: one malformed/unexpected record must never abort the
      // rest of this batch, and must never escape as an unhandled promise
      // rejection (which — with no process-wide unhandledRejection handler —
      // would crash the whole backend). Every other valid record in the same
      // message is still processed.
      try {
        const t = record.t;

        // ── Connection acknowledgement ─────────────────────────────────────────
        if (t === "ck") {
          if (record.s === "OK" || record.s === "Ok") {
            console.log(`[Feed:ACK] Connection acknowledged by Zebu (s=${record.s}). Sending subscriptions...`);
            clearSessionRejectionTracking();
            if (subscribeKeys && !subscriptionSent) {
              subscriptionSent = true;
              sendSubscribe(instruments, "Initial subscription");
              // Flush any tokens that were requested (on-demand option resolve, ATM recompute)
              // before the connection finished authenticating.
              if (pendingExtra.length > 0) {
                sendSubscribe(pendingExtra, "Flushing queued subscribe");
                pendingExtra = [];
              }
              lastSubscriptionStats = { ...lastSubscriptionStats, subscriptionRestoredAt: Date.now() };
              console.log(
                `[Feed:SUB] Subscription restoration complete — requested ${subscriptionRequestsSent}/${instruments.length} ` +
                `expected instrument(s) (CE=${ceCount} PE=${peCount} FUT/SPOT/other=${instruments.length - optCount}).`
              );
              // Connection is authenticated and subscription is in-flight. Signal live
              // to the frontend now so the dashboard transitions out of "connecting".
              onConnected?.();
            } else if (!subscribeKeys) {
              console.error("[Feed:SUB] No subscribe keys — no instruments configured in .env");
            }
          } else {
            console.error(`[Feed:ACK] Connection REJECTED by Zebu — s="${record.s}" emsg="${record.emsg ?? "(none)"}" | Full: ${JSON.stringify(record)}`);
            const decision = shouldTreatSessionAsInvalid(sessionToken, record.emsg, record.s);
            if (decision.invalid && onSessionExpired) {
              console.warn(
                `[Feed:ACK] Treating broker session as INVALID (matchedKnownPattern=${decision.matchedKnownPattern}, ` +
                `consecutiveRejections=${decision.consecutiveRejections}/${SESSION_INVALID_REJECT_THRESHOLD}) — ` +
                `halting automatic reconnect for this token. Fresh broker login required.`
              );
              onSessionExpired();
            } else {
              console.warn(
                `[Feed:ACK] Connection rejected but not (yet) classified as session-invalid ` +
                `(consecutiveRejections=${decision.consecutiveRejections}/${SESSION_INVALID_REJECT_THRESHOLD}) — reconnecting normally.`
              );
              onFallback(`Zebu rejected connection: ${record.emsg || record.s}`);
            }
          }
          continue;
        }

        // ── Subscription acknowledgement / initial touchline snapshot ────────────
        // Zebu sends t:"tk" as the FIRST price snapshot for each subscribed
        // instrument after a t:"t" subscribe. It carries lp, oi, ft etc. — NOT
        // an s:"OK" acknowledgement field. The only s field in the protocol is on
        // t:"ck" (connection ack). Processing tk as if s:"OK" were required caused
        // ws.close() on every valid snapshot → the Live→Reconnecting reconnect loop.
        if (t === "tk") {
          const isExplicitRejection = record.s === "Not_Ok" || record.s === "Not_OK";
          if (isExplicitRejection) {
            // Zebu explicitly rejected this specific token (expired contract, bad token etc.)
            // Log and skip — do NOT close the WS. Other instruments still deliver ticks.
            console.error(`[Feed:ACK] Token rejected by Zebu — tk="${record.tk ?? "(none)"}" emsg="${record.emsg ?? "(none)"}" — skipping (feed stays open for other instruments).`);
          } else {
            // Normal case: process as initial price snapshot (same path as t:"tf" ticks)
            const tick = toTick(record, symbolByKey);
            if (tick) {
              tickCount++;
              lastPayload = tick;
              await onTick(tick);
              if (!firstTickLoggedThisConnection) {
                firstTickLoggedThisConnection = true;
                console.log(`[Feed] First tick received since (re)connect — feed confirmed live for symbol=${tick.symbol}.`);
              }
              debugLog(`[Feed:SNAP] Initial snapshot — ${tick.symbol} ltp=${tick.ltp} oi=${tick.oi ?? "—"}`);
            } else {
              // Pre-market or no LTP yet — instrument confirmed but price pending
              debugLog(`[Feed:SNAP] tk received (no price yet) — tk="${record.tk || "(none)"}" e="${record.e || "(none)"}" ts="${record.ts || "(none)"}"`);
            }
          }
          continue;
        }

        // ── Heartbeat / ping ───────────────────────────────────────────────────
        if (t === "h") {
          debugLog(`[Feed:PING] Heartbeat from Zebu (msg #${totalMsgCount})`);
          continue;
        }

        // ── Broker-level error ─────────────────────────────────────────────────
        if (record.s === "Not_Ok" || (record.emsg && !t)) {
          console.error(`[Feed:ERROR] Broker error — emsg="${record.emsg ?? "(none)"}" | Full: ${JSON.stringify(record)}`);
          continue;
        }

        // ── Market tick (tf = tick feed update) ───────────────────────────────
        const tick = toTick(record, symbolByKey);
        if (tick) {
          tickCount++;
          lastPayload = tick;
          await onTick(tick);
          if (!firstTickLoggedThisConnection) {
            firstTickLoggedThisConnection = true;
            console.log(`[Feed] First tick received since (re)connect — feed confirmed live for symbol=${tick.symbol}.`);
          }
        } else {
          const exchange = record.e || record.exch || record.exchange;
          const token = record.tk || record.token || record.instrumentToken;
          const resolvedSymbol = symbolByKey.get(`${exchange}|${token}`) || symbolByKey.get(String(token));
          if (resolvedSymbol) {
            // Token is a known subscribed instrument, but this delta carries neither a
            // price nor any previously-seen price to carry forward — i.e. an OI/volume
            // update that arrived before the instrument's first trade of the day.
            debugLog(`[Feed:OI-ONLY] ${resolvedSymbol} — delta with no price yet (pre-first-trade): ${JSON.stringify(record).substring(0, 200)}`);
          } else {
            // Truly unmapped token — not one of our subscribed instruments, or the
            // exchange|token → symbol mapping is stale (e.g. after an expiry rollover).
            debugLog(`[Feed:SKIP] Unrecognized record (t="${t ?? "(none)"}") e="${exchange ?? "(none)"}" tk="${token ?? "(none)"}": ${JSON.stringify(record).substring(0, 200)}`);
          }
        }
      } catch (err: any) {
        // Never let one bad record take down the whole message handler (or the
        // process, via an unhandled rejection) — log it and keep processing the
        // remaining records in this same WebSocket message.
        console.error(
          `[Feed:ERROR] Unexpected exception while processing a market-data record — skipping this record only: ${err?.message || err}`,
          record
        );
      }
    }
  });

  ws.on("close", () => {
    wsConnected = false;
    clearInterval(statsInterval);
    clearInterval(idleWatchdogInterval);
    const reason = liveConnected ? "live feed closed" : "connection closed before handshake";
    console.log(`[Feed] Disconnected — ${reason}. Total messages received: ${totalMsgCount} | Total ticks: ${tickCount}`);
    onDataSource("SIMULATOR");
    onFallback(reason);
  });

  ws.on("error", (err) => {
    wsConnected = false;
    clearInterval(statsInterval);
    clearInterval(idleWatchdogInterval);
    console.error("[Feed] WebSocket error:", err.message);
    onDataSource("SIMULATOR");
    onFallback("WebSocket error");
  });

  return {
    close: () => {
      clearInterval(statsInterval);
      clearInterval(idleWatchdogInterval);
      ws.close();
    },
    subscribeTokens,
  };
};
