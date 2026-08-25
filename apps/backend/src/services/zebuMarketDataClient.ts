import WebSocket from "ws";
import { Tick } from "@stock/shared";
import { getZebuOAuthMissingConfig, resolveZebuSessionToken } from "./zebuOAuthService";

type DataSource = "LIVE_MARKET_API" | "SIMULATOR";

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
    console.log(
      `[ZEBU TICK DIAG][FUT #${diagFutTickCount}/${MAX_DIAG_TICKS}] ` +
      `symbol=${tick.symbol} ltp=${tick.ltp} rawLtp=${payload.lp ?? payload.ltp ?? "—"} ` +
      `rawO=${payload.o ?? "—"} rawH=${payload.h ?? "—"} rawL=${payload.l ?? "—"} rawC=${payload.c ?? "—"} ` +
      `ft=${payload.ft ?? "—"} ts=${tick.timestamp.toISOString()} vol=${tick.volume} oi=${tick.oi ?? "—"}`
    );
  } else if (isSpot && diagSpotTickCount < MAX_DIAG_TICKS) {
    diagSpotTickCount++;
    console.log(
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
const SESSION_EXPIRY_PATTERNS = [
  "session expired", "sessionexpired", "invalid session", "token expired",
  "susertoken", "not_ok", "login", "unauthorized", "invalid user"
];

const isSessionExpiredMessage = (emsg?: string, stat?: string): boolean => {
  const combined = `${emsg || ""} ${stat || ""}`.toLowerCase();
  return SESSION_EXPIRY_PATTERNS.some(p => combined.includes(p));
};

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
  const instruments   = getModule1ZebuInstruments();
  const symbolByKey   = buildInstrumentMap(instruments);
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

  // ── Runtime (post-connect) subscription support ────────────────────────────
  // Lets the rest of the app (on-demand option requests, ATM-band recompute once a real
  // price arrives) add tokens to an already-open connection instead of requiring a
  // reconnect. Noren accepts additional "t":"t" frames at any point after the initial
  // subscribe — each just adds to what the connection already receives.
  const subscribedKeys = new Set<string>(instruments.map((i) => i.key));
  let pendingExtra: ZebuInstrument[] = [];

  const sendSubscribe = (toSend: ZebuInstrument[], label: string) => {
    if (toSend.length === 0) return;
    const keys = toSend.map((i) => i.key).join("#");
    ws.send(JSON.stringify({ t: "t", k: keys }));
    console.log(`[Feed:SUB] ${label} — ${toSend.length} instrument(s): ${keys.substring(0, 200)}${keys.length > 200 ? "…" : ""}`);
  };

  const subscribeTokens = (newInstruments: ZebuInstrument[]) => {
    const fresh = newInstruments.filter((i) => !subscribedKeys.has(i.key));
    if (fresh.length === 0) return;

    for (const inst of fresh) {
      subscribedKeys.add(inst.key);
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
    console.log(`[Feed:STATS] Messages/min: ${msgCountThisMinute} | Total messages: ${totalMsgCount} | Ticks: ${tickCount} | Instruments: ${instruments.length}`);
    if (lastPayload) {
      console.log(`[Feed:STATS] Last tick — symbol=${lastPayload.symbol} ltp=${lastPayload.ltp} oi=${lastPayload.oi ?? "—"} ts=${lastPayload.timestamp?.toISOString?.() ?? "—"}`);
    } else {
      console.warn("[Feed:STATS] No ticks received yet — waiting for Zebu to stream data.");
    }
    msgCountThisMinute = 0;
  }, 60000);

  console.log(`[Feed] Connecting with session for user: ${userId} | URL: ${sanitizeFeedUrl(wsUrl)}`);
  console.log(`[Feed] Instrument list (${instruments.length}):`);
  for (const inst of instruments) {
    console.log(`  [Feed]   ${inst.key} → ${inst.symbol}`);
  }
  if (instruments.length === 0) {
    console.error("[Feed] FATAL: No instruments configured. Set ZEBU_NIFTY_FUT_TOKEN, ZEBU_NIFTY_CE_TOKENS, ZEBU_NIFTY_PE_TOKENS in .env");
  }

  const ws = new WebSocket(wsUrl);

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
      const t = record.t;

      // ── Connection acknowledgement ─────────────────────────────────────────
      if (t === "ck") {
        if (record.s === "OK" || record.s === "Ok") {
          console.log(`[Feed:ACK] Connection acknowledged by Zebu (s=${record.s}). Sending subscriptions...`);
          if (subscribeKeys && !subscriptionSent) {
            subscriptionSent = true;
            ws.send(JSON.stringify({ t: "t", k: subscribeKeys }));
            console.log(`[Feed:SUB] Subscription sent — ${instruments.length} instruments: ${subscribeKeys.substring(0, 120)}${subscribeKeys.length > 120 ? "…" : ""}`);
            // Flush any tokens that were requested (on-demand option resolve, ATM recompute)
            // before the connection finished authenticating.
            if (pendingExtra.length > 0) {
              sendSubscribe(pendingExtra, "Flushing queued subscribe");
              pendingExtra = [];
            }
            // Connection is authenticated and subscription is in-flight. Signal live
            // to the frontend now so the dashboard transitions out of "connecting".
            onConnected?.();
          } else if (!subscribeKeys) {
            console.error("[Feed:SUB] No subscribe keys — no instruments configured in .env");
          }
        } else {
          console.error(`[Feed:ACK] Connection REJECTED by Zebu — s="${record.s}" emsg="${record.emsg ?? "(none)"}" | Full: ${JSON.stringify(record)}`);
          if (isSessionExpiredMessage(record.emsg, record.s) && onSessionExpired) {
            console.warn("[Feed:ACK] Session token rejected — likely expired. Triggering session expiry handler.");
            onSessionExpired();
          } else {
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
            console.log(`[Feed:SNAP] Initial snapshot — ${tick.symbol} ltp=${tick.ltp} oi=${tick.oi ?? "—"}`);
          } else {
            // Pre-market or no LTP yet — instrument confirmed but price pending
            console.log(`[Feed:SNAP] tk received (no price yet) — tk="${record.tk || "(none)"}" e="${record.e || "(none)"}" ts="${record.ts || "(none)"}"`);
          }
        }
        continue;
      }

      // ── Heartbeat / ping ───────────────────────────────────────────────────
      if (t === "h") {
        console.log(`[Feed:PING] Heartbeat from Zebu (msg #${totalMsgCount})`);
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
      } else {
        const exchange = record.e || record.exch || record.exchange;
        const token = record.tk || record.token || record.instrumentToken;
        const resolvedSymbol = symbolByKey.get(`${exchange}|${token}`) || symbolByKey.get(String(token));
        if (resolvedSymbol) {
          // Token is a known subscribed instrument, but this delta carries neither a
          // price nor any previously-seen price to carry forward — i.e. an OI/volume
          // update that arrived before the instrument's first trade of the day.
          console.log(`[Feed:OI-ONLY] ${resolvedSymbol} — delta with no price yet (pre-first-trade): ${JSON.stringify(record).substring(0, 200)}`);
        } else {
          // Truly unmapped token — not one of our subscribed instruments, or the
          // exchange|token → symbol mapping is stale (e.g. after an expiry rollover).
          console.log(`[Feed:SKIP] Unrecognized record (t="${t ?? "(none)"}") e="${exchange ?? "(none)"}" tk="${token ?? "(none)"}": ${JSON.stringify(record).substring(0, 200)}`);
        }
      }
    }
  });

  ws.on("close", () => {
    wsConnected = false;
    clearInterval(statsInterval);
    const reason = liveConnected ? "live feed closed" : "connection closed before handshake";
    console.log(`[Feed] Disconnected — ${reason}. Total messages received: ${totalMsgCount} | Total ticks: ${tickCount}`);
    onDataSource("SIMULATOR");
    onFallback(reason);
  });

  ws.on("error", (err) => {
    wsConnected = false;
    clearInterval(statsInterval);
    console.error("[Feed] WebSocket error:", err.message);
    onDataSource("SIMULATOR");
    onFallback("WebSocket error");
  });

  return {
    close: () => {
      clearInterval(statsInterval);
      ws.close();
    },
    subscribeTokens,
  };
};
