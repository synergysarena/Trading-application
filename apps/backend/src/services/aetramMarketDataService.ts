import axios from "axios";
import { bufferSet } from "./redisWriteBuffer";
import { broadcastBrokerStatus } from "./socketService";
import {
  loginMarketData,
  getMarketDataToken,
  getMarketDataUser,
  isMarketDataAuthenticated,
  markMarketDataSessionExpired,
} from "./marketDataSessionService";
import { onRawSocketEvent, disconnect as disconnectMarketDataWebSocket, getStatus as getWebSocketStatus } from "./marketDataWebSocketService";
import { marketDataEvents } from "./marketDataEvents";
import { processRawPacket, NormalizedMarketEvent } from "./marketDataPipelineService";
import { recordTickReceived } from "./monitoringService";

// Session state (token, userID, expiry) lives in marketDataSessionService.
// The socket connection itself lives ONLY in marketDataWebSocketService
// (Phase 6 consolidation) — this service is a pure consumer of it: it
// registers tick handlers via onRawSocketEvent and reacts to connection
// lifecycle via marketDataEvents. It never creates, destroys, or reconnects
// a socket itself.
let _onReconnectFn: (() => Promise<void>) | null = null;

export const setOnAetramReconnect = (fn: () => Promise<void>) => {
  _onReconnectFn = fn;
};

export const clearSearchCache = () => {
  searchCache.clear();
  symbolToTokenMap.clear();
  tokenToSymbolMap.clear();
};

export const clearActiveSubscribedMap = () => {
  activeSubscribedMap.clear();
};

export const clearAetramSession = () => {
  markMarketDataSessionExpired();
  clearSearchCache();
  clearActiveSubscribedMap();
  // The session backing the shared socket is gone — tear the connection down
  // too rather than leaving a socket open with a now-invalid token.
  disconnectMarketDataWebSocket();
};

export const isAetramConnected = (): "CONNECTED" | "ERROR" | "WAITING_FOR_CONFIGURATION" => {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();
  const authUrl = getAuthUrl();
  const baseUrl = getBaseUrl();

  if (isPlaceholder(apiKey) || isPlaceholder(apiSecret) || !authUrl || !baseUrl) {
    return "WAITING_FOR_CONFIGURATION";
  }

  if (isMarketDataAuthenticated() && getWebSocketStatus().state === "CONNECTED") {
    return "CONNECTED";
  }

  return "ERROR";
};

// Caches for symbol mapping
const symbolToTokenMap = new Map<string, { segment: number; token: string }>();
const tokenToSymbolMap = new Map<string, string>(); // key is `segment|token` or just `token`

const isPlaceholder = (value?: string) =>
  !value || value.includes("your-") || value.includes("placeholder");

const getApiKey = () => (process.env.MOD2_API_KEY || "").trim();
const getApiSecret = () => (process.env.MOD2_API_SECRET || "").trim();
const getBaseUrl = () => (process.env.AETRAM_MARKETDATA_API_BASE_URL || "").trim();
const getAuthUrl = () => (process.env.AETRAM_MARKETDATA_AUTH_URL || "").trim();

const MONTH_NAMES: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

export const parseDateToYMD = (val: string | Date | number): string => {
  if (!val) return "";
  if (typeof val === "string") {
    const s = val.trim();
    // 1. ISO: YYYY-MM-DD
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }
    // 2. DD-Mon-YYYY (e.g. 03-Sep-2026 or 03-SEP-2026)
    const dmMatch = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (dmMatch) {
      const monthNum = MONTH_NAMES[dmMatch[2].toUpperCase()];
      if (monthNum) {
        return `${dmMatch[3]}-${monthNum}-${dmMatch[1].padStart(2, "0")}`;
      }
    }
    // 3. DD/MM/YYYY
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
      return `${slashMatch[3]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[1].padStart(2, "0")}`;
    }
    // 4. DD-MM-YYYY
    const dashMatch = s.match(/^(\d{1,2})-(\d{1,2})\-(\d{4})/);
    if (dashMatch) {
      return `${dashMatch[3]}-${dashMatch[2].padStart(2, "0")}-${dashMatch[1].padStart(2, "0")}`;
    }
  }
  const d = new Date(val);
  if (isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/**
 * Standard HTTP headers for Aetram requests
 */
const getHeaders = () => {
  const token = getMarketDataToken();
  if (!token) return { "Content-Type": "application/json" };
  return {
    "Content-Type": "application/json",
    "authorization": token,
  };
};

/**
 * Perform login to Aetram MarketData API using configured env credentials
 */
export const loginToAetram = async (force?: boolean): Promise<boolean> => {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();

  if (isPlaceholder(apiKey) || isPlaceholder(apiSecret)) {
    console.warn("[AetramMD] Missing or placeholder credentials in env. Skipping Aetram live login.");
    return false;
  }

  const result = await loginMarketData(undefined, undefined, force);
  return result.ok;
};

/**
 * Normalized shape of one row returned by Aetram's /search/instruments endpoint.
 * Used by the Instrument Discovery layer (InstrumentService) as well as the
 * strike-token resolution below.
 */
export interface AetramInstrumentResult {
  exchangeSegment: number;
  exchangeInstrumentID: string;
  name: string;
  tradingSymbol: string;
  series: string;
  instrumentType: string;
  expiryDate?: string;
  strikePrice?: number;
  optionType?: string;
}

/**
 * Raw instrument search against Aetram's /search/instruments endpoint.
 * Extracted from resolveOptionStrikeToken (Phase 3) so the Instrument Discovery
 * layer can reuse the exact same search call instead of re-implementing it.
 */
const searchCache = new Map<string, { timestamp: number; data: AetramInstrumentResult[] }>();
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

const inFlightSearches = new Map<string, Promise<AetramInstrumentResult[]>>();

export const searchInstruments = async (searchString: string): Promise<AetramInstrumentResult[]> => {
  const cacheKey = searchString.trim().toUpperCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL_MS) {
    return cached.data;
  }

  if (inFlightSearches.has(cacheKey)) {
    return inFlightSearches.get(cacheKey)!;
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    console.warn("[AetramMD] Missing AETRAM_MARKETDATA_API_BASE_URL. Cannot search instruments.");
    return [];
  }

  // Ensure authenticated session
  if (!getMarketDataToken()) {
    await loginToAetram();
  }

  const token = getMarketDataToken();
  if (!token) {
    console.warn(`[AetramMD] Unauthenticated search aborted for query "${searchString}".`);
    return [];
  }

  const maskedToken = token.length > 8 ? `${token.slice(0, 4)}...${token.slice(-4)}` : "***";
  const searchUrl = `${baseUrl}/search/instruments?searchString=${encodeURIComponent(searchString)}`;

  console.log(`[AETRAM][SESSION] session available=${isMarketDataAuthenticated()}`);
  console.log(`[AETRAM][INSTRUMENT-SEARCH][REQUEST]
searchString=${searchString}
endpoint=${searchUrl}
user=${getMarketDataUser() || "UNKNOWN"}
tokenSource=BACKEND_SESSION
token=${maskedToken}`);

  const searchPromise = (async () => {
    const startTime = Date.now();
    try {
      const response = await axios.get(searchUrl, { headers: getHeaders(), timeout: 10000 });
      const elapsed = Date.now() - startTime;

      if (response.data?.type !== "success" || !Array.isArray(response.data.result)) {
        console.warn(`[AetramMD] Search returned non-success response shape: type=${response.data?.type || "unknown"}`);
        return [];
      }

      const parsedResults: AetramInstrumentResult[] = response.data.result.map((inst: any) => ({
        exchangeSegment: Number(inst.ExchangeSegment ?? inst.exchangeSegment ?? 2),
        exchangeInstrumentID: String(inst.ExchangeInstrumentID ?? inst.exchangeInstrumentID ?? ""),
        name: String(inst.Name ?? inst.name ?? inst.symbol ?? ""),
        tradingSymbol: String(inst.TradingSymbol ?? inst.tradingSymbol ?? inst.DisplayName ?? inst.displayName ?? ""),
        series: String(inst.Series ?? inst.series ?? ""),
        instrumentType: String(inst.InstrumentType ?? inst.instrumentType ?? inst.Series ?? inst.series ?? ""),
        expiryDate: inst.ContractExpiration || inst.contractExpiration || inst.ExpiryDate || inst.expiryDate || inst.Expiry || inst.expiry || undefined,
        strikePrice: inst.StrikePrice !== undefined ? Number(inst.StrikePrice)
          : inst.strikePrice !== undefined ? Number(inst.strikePrice)
            : inst.Strike !== undefined ? Number(inst.Strike)
              : inst.strike !== undefined ? Number(inst.strike) : undefined,
        optionType: inst.OptionType || inst.optionType || inst.Type || inst.type || undefined,
      }));

      searchCache.set(cacheKey, { timestamp: Date.now(), data: parsedResults });
      console.log(`[AETRAM][INSTRUMENT-SEARCH][SUCCESS] searchString=${searchString} status=${response.status} itemCount=${parsedResults.length} elapsed=${elapsed}ms`);
      return parsedResults;
    } catch (error: any) {
      const elapsed = Date.now() - startTime;
      const status = error?.response?.status || "N/A";
      const respData = error?.response?.data;
      const sanitizedResp = typeof respData === "object" ? JSON.stringify(respData) : (respData || error?.message || String(error));
      const respLower = sanitizedResp.toLowerCase();

      const isAuthFailure = status === 401 || (
        status === 400 && (
          respLower.includes("token") ||
          respLower.includes("auth") ||
          respLower.includes("session") ||
          respLower.includes("unauthorized") ||
          respLower.includes("invalid / expired")
        )
      );

      console.error(`[AETRAM][INSTRUMENT-SEARCH][ERROR]
searchString=${searchString}
status=${status}
response=${sanitizedResp}
elapsed=${elapsed}ms
authFailure=${isAuthFailure}`);

      if (isAuthFailure) {
        console.warn(`[AetramMD] Session expired/invalid (status=${status}) during search for "${searchString}". Clearing session.`);
        clearAetramSession();
        broadcastBrokerStatus("session-expired", "Broker session expired. Please login again.", "module2");
      }
      return [];
    } finally {
      inFlightSearches.delete(cacheKey);
    }
  })();

  inFlightSearches.set(cacheKey, searchPromise);
  return searchPromise;
};

/**
 * Search and resolve an option strike symbol to its instrument token
 */
/**
 * Search and resolve an option strike symbol to its instrument token
 */
export const resolveOptionStrikeToken = async (
  index: string,
  expiryDate: string,
  strikeSymbol: string
): Promise<{ segment: number; token: string } | null> => {
  // If already in cache, return it
  if (symbolToTokenMap.has(strikeSymbol)) {
    const cached = symbolToTokenMap.get(strikeSymbol)!;
    console.log(`[INSTRUMENT][RESOLVED] symbol=${strikeSymbol} segment=${cached.segment} token=${cached.token} (cached)`);
    return cached;
  }

  // Auto-login check if not authenticated
  if (!getMarketDataToken()) {
    console.log("[AetramMD] Market Data token missing. Attempting auto-login...");
    const loggedIn = await loginToAetram();
    if (!loggedIn || !getMarketDataToken()) {
      console.warn(`[INSTRUMENT][FAILED] symbol=${strikeSymbol} reason=Not authenticated to Aetram Market Data API`);
      return null;
    }
  }

  // Extract strike price and option type from strikeSymbol (e.g. "NIFTY22100CE")
  const match = strikeSymbol.match(/(\d+)(CE|PE)$/);
  if (!match) {
    console.warn(`[INSTRUMENT][FAILED] symbol=${strikeSymbol} reason=Invalid strike symbol format`);
    return null;
  }
  const strikePrice = Number(match[1]);
  const optionType = match[2].toUpperCase(); // CE or PE

  const indexShort = index.replace("50", "").replace("fifty", "").toUpperCase(); // e.g. "NIFTY"

  // Search by index query first so single search result populates all option strikes
  let results = await searchInstruments(indexShort);

  if (results.length === 0) {
    const fallbackSearch = `${indexShort} ${strikePrice}`;
    console.log(`[AetramMD] Search '${indexShort}' yielded 0 results. Trying query: '${fallbackSearch}'`);
    results = await searchInstruments(fallbackSearch);
  }

  if (results.length === 0) {
    console.warn(`[INSTRUMENT][FAILED] symbol=${strikeSymbol} reason=No instruments returned from Aetram search query`);
    return null;
  }

  const targetYmd = parseDateToYMD(expiryDate);
  const candidateMatches: Array<{ inst: AetramInstrumentResult; ymd: string }> = [];

  for (const inst of results) {
    const rawExpiry = inst.expiryDate || "";
    const instExpiryYmd = parseDateToYMD(rawExpiry);
    const instStrike = Math.round(Number(inst.strikePrice ?? 0));
    const instOptType = String(inst.optionType || "").toUpperCase();

    // In XTS, OptionType 3 = CE, 4 = PE (or string "CE"/"PE")
    const isOptCE = instOptType === "3" || instOptType.includes("CE") || instOptType.includes("CALL");
    const isOptPE = instOptType === "4" || instOptType.includes("PE") || instOptType.includes("PUT");
    const isTargetCE = optionType === "CE";

    const optTypeMatches = isTargetCE ? isOptCE : isOptPE;

    if (instStrike === strikePrice && optTypeMatches) {
      candidateMatches.push({ inst, ymd: instExpiryYmd });
    }
  }

  if (candidateMatches.length === 0) {
    console.warn(`[INSTRUMENT][FAILED] symbol=${strikeSymbol} reason=No matching strike ${strikePrice} ${optionType} found in search results (${results.length} records scanned)`);
    return null;
  }

  // 1. Try exact expiry match first
  let matchInst = candidateMatches.find(c => c.ymd === targetYmd);

  if (!matchInst) {
    const availableExpiries = Array.from(new Set(candidateMatches.map(c => c.ymd).filter(Boolean))).sort();
    console.log(`[INSTRUMENT][EXPIRY] Requested: ${targetYmd}, Available: ${availableExpiries.join(", ")}`);

    // Select closest available expiry
    matchInst = candidateMatches.sort((a, b) => {
      const diffA = Math.abs(new Date(a.ymd).getTime() - new Date(targetYmd).getTime());
      const diffB = Math.abs(new Date(b.ymd).getTime() - new Date(targetYmd).getTime());
      return diffA - diffB;
    })[0];

    if (matchInst) {
      console.log(`[INSTRUMENT][EXPIRY] Matched nearest available expiry: ${matchInst.ymd} for requested ${targetYmd}`);
    }
  }

  if (matchInst) {
    const inst = matchInst.inst;
    const segment = inst.exchangeSegment;
    const token = inst.exchangeInstrumentID;

    const result = { segment, token };
    symbolToTokenMap.set(strikeSymbol, result);
    tokenToSymbolMap.set(`${segment}|${token}`, strikeSymbol);
    tokenToSymbolMap.set(`${segment}|${String(token)}`, strikeSymbol);
    tokenToSymbolMap.set(`${segment}|${Number(token)}`, strikeSymbol);
    tokenToSymbolMap.set(String(token), strikeSymbol);
    tokenToSymbolMap.set(token, strikeSymbol);
    (tokenToSymbolMap as any).set(Number(token), strikeSymbol);

    console.log(`[INSTRUMENT][RESOLVED] symbol=${strikeSymbol} segment=${segment} token=${token} expiry=${matchInst.ymd} strike=${strikePrice} optionType=${optionType}`);
    return result;
  }

  console.warn(`[INSTRUMENT][FAILED] symbol=${strikeSymbol} reason=No valid contract expiry matched`);
  return null;
};

const activeSubscribedMap = new Map<string, { segment: number; token: string }>();

export const getActiveSubscribedInstruments = (): Array<{ segment: number; token: string }> => {
  return Array.from(activeSubscribedMap.values());
};

/**
 * Subscribe to LTP & OI updates for resolved instruments (deduplicated)
 */
export const subscribeToInstruments = async (
  instruments: Array<{ segment: number; token: string }>
) => {
  const baseUrl = getBaseUrl();
  if (!getMarketDataToken()) {
    await loginToAetram();
  }

  if (!baseUrl || !getMarketDataToken() || instruments.length === 0) {
    console.warn("[AetramMD] Cannot subscribe — unauthenticated or empty instrument list.");
    return;
  }

  // Deduplicate instruments by segment|token to avoid XTS HTTP 400 Bad Request
  const uniqueMap = new Map<string, { segment: number; token: string }>();
  for (const inst of instruments) {
    if (inst && inst.token) {
      const key = `${inst.segment}|${inst.token}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, inst);
      }
    }
  }
  const uniqueInstruments = Array.from(uniqueMap.values());

  console.log(`[AETRAM][SUBSCRIBE] requested=${instruments.length} unique=${uniqueInstruments.length}`);

  try {
    const payload = {
      instruments: uniqueInstruments.map((inst) => ({
        exchangeSegment: inst.segment,
        exchangeInstrumentID: Number(inst.token),
      })),
      xtsMessageCode: 1512, // LTP updates
    };

    const payloadOI = {
      ...payload,
      xtsMessageCode: 1510, // OI updates
    };

    console.log(`[AETRAM][SUBSCRIBE][REQUEST] count=${uniqueInstruments.length}`);
    const respLTP = await axios.post(`${baseUrl}/instruments/subscription`, payload, { headers: getHeaders(), timeout: 10000 });
    const respOI = await axios.post(`${baseUrl}/instruments/subscription`, payloadOI, { headers: getHeaders(), timeout: 10000 });

    if (respLTP.data?.type === "success" || respLTP.status === 200) {
      for (const inst of uniqueInstruments) {
        activeSubscribedMap.set(`${inst.segment}|${inst.token}`, inst);
      }
      console.log(`[AETRAM][SUBSCRIBE][SUCCESS] count=${uniqueInstruments.length}`);
    } else {
      console.warn(`[AETRAM][SUBSCRIBE][WARNING] LTP response:`, JSON.stringify(respLTP.data));
    }
  } catch (error: any) {
    const status = error?.response?.status;
    const respBody = error?.response?.data;
    console.error(`[AETRAM][SUBSCRIBE][FAILED] status=${status || 'N/A'} response=${JSON.stringify(respBody || error?.message || error)}`);

    if (status === 401) {
      console.warn("[AetramMD] Session expired (401) during subscription.");
      clearAetramSession();
      broadcastBrokerStatus("session-expired", "Broker session expired. Please login again.", "module2");
    }
  }
};

/**
 * Unsubscribe from LTP & OI updates for instruments no longer required by any active session
 */
export const unsubscribeFromInstruments = async (
  instruments: Array<{ segment: number; token: string }>
) => {
  const baseUrl = getBaseUrl();
  if (!baseUrl || !getMarketDataToken() || instruments.length === 0) return;

  const uniqueMap = new Map<string, { segment: number; token: string }>();
  for (const inst of instruments) {
    if (inst && inst.token) {
      const key = `${inst.segment}|${inst.token}`;
      uniqueMap.set(key, inst);
    }
  }
  const uniqueInstruments = Array.from(uniqueMap.values());
  console.log(`[AETRAM][UNSUBSCRIBE] requested=${instruments.length} unique=${uniqueInstruments.length}`);

  try {
    const payload = {
      instruments: uniqueInstruments.map((inst) => ({
        exchangeSegment: inst.segment,
        exchangeInstrumentID: Number(inst.token),
      })),
      xtsMessageCode: 1512,
    };
    const payloadOI = { ...payload, xtsMessageCode: 1510 };

    await axios.put(`${baseUrl}/instruments/subscription`, payload, { headers: getHeaders(), timeout: 10000 }).catch(() => { });
    await axios.put(`${baseUrl}/instruments/subscription`, payloadOI, { headers: getHeaders(), timeout: 10000 }).catch(() => { });

    for (const inst of uniqueInstruments) {
      const key = `${inst.segment}|${inst.token}`;
      activeSubscribedMap.delete(key);
    }
    console.log(`[AETRAM][UNSUBSCRIBE][SUCCESS] count=${uniqueInstruments.length}`);
  } catch (error: any) {
    console.warn(`[AETRAM][UNSUBSCRIBE][FAILED]`, error?.message || error);
  }
};

import { onLiveTickReceived } from "./trackerService";

marketDataEvents.on("MARKET_DATA", (event: NormalizedMarketEvent) => {
  recordTickReceived("module2");
});

marketDataEvents.on("LTP_UPDATED", (event: NormalizedMarketEvent) => {
  if (!event.exchangeInstrumentID || event.lastPrice === null) return;
  const rawId = String(event.exchangeInstrumentID);
  const numId = Number(event.exchangeInstrumentID);
  const seg = event.exchangeSegment;
  const symbol = (seg ? tokenToSymbolMap.get(`${seg}|${rawId}`) : null)
    || (seg ? tokenToSymbolMap.get(`${seg}|${numId}`) : null)
    || tokenToSymbolMap.get(rawId)
    || (tokenToSymbolMap as any).get(numId);

  if (symbol) {
    bufferSet(`ltp:${symbol}`, String(event.lastPrice));
    console.log(`[AETRAM][TICK] token=${rawId} symbol=${symbol} ltp=${event.lastPrice}`);
    console.log(`[REDIS][LIVE] key=ltp:${symbol} value=${event.lastPrice}`);
    onLiveTickReceived(symbol, event.lastPrice);
  } else {
    console.log(`[AETRAM][TICK_UNMAPPED] token=${rawId} seg=${seg} ltp=${event.lastPrice}`);
  }
});

marketDataEvents.on("OI_UPDATED", (event: NormalizedMarketEvent) => {
  if (!event.exchangeInstrumentID || event.openInterest === null) return;
  const rawId = String(event.exchangeInstrumentID);
  const numId = Number(event.exchangeInstrumentID);
  const seg = event.exchangeSegment;
  const symbol = (seg ? tokenToSymbolMap.get(`${seg}|${rawId}`) : null)
    || (seg ? tokenToSymbolMap.get(`${seg}|${numId}`) : null)
    || tokenToSymbolMap.get(rawId)
    || (tokenToSymbolMap as any).get(numId);

  if (symbol) {
    bufferSet(`oi:${symbol}`, String(event.openInterest));
    console.log(`[REDIS][LIVE] key=oi:${symbol} value=${event.openInterest}`);
  }
});

/**
 * WebSocket lifecycle wiring (Phase 6 consolidation).
 *
 * marketDataWebSocketService is the ONLY owner of the socket. This service
 * only registers what it needs on top of that shared connection:
 *   - raw packet routing into the Phase 7 pipeline, re-attached to every
 *     socket instance the manager creates (including across reconnects) via
 *     onRawSocketEvent
 *   - a reaction to CONNECTED/RECONNECTED/DISCONNECTED lifecycle events to
 *     preserve the exact same business behavior the old inline socket
 *     handlers had (frontend broker-status broadcast + the tracker resync
 *     callback), without owning the socket itself.
 *
 * "-json-full"/"-json-partial" are Aetram/XTS's own event-name suffixes for a
 * full snapshot vs. an incremental update of the same message code; both route
 * to the same decoder since the pipeline normalizes either shape identically.
 * 1501/1502 are wired defensively even though nothing currently requests those
 * message codes via subscribeToInstruments — the pipeline is meant to be
 * reusable for whatever future subsystems start requesting them.
 */
const routeToPipeline = (packetType: string) => (raw: unknown) => processRawPacket(packetType, raw);

onRawSocketEvent("1512-json-full", routeToPipeline("1512"));
onRawSocketEvent("1512-json-partial", routeToPipeline("1512"));
onRawSocketEvent("1510-json-full", routeToPipeline("1510"));
onRawSocketEvent("1510-json-partial", routeToPipeline("1510"));
onRawSocketEvent("1501-json-full", routeToPipeline("1501"));
onRawSocketEvent("1501-json-partial", routeToPipeline("1501"));
onRawSocketEvent("1502-json-full", routeToPipeline("1502"));
onRawSocketEvent("1502-json-partial", routeToPipeline("1502"));

const triggerReconnectCallback = () => {
  if (_onReconnectFn) {
    _onReconnectFn().catch((err: any) => {
      console.error("[AetramMD] Reconnect callback error:", err?.message || err);
    });
  }
};

marketDataEvents.on("CONNECTED", () => {
  console.log("[AetramMD] Socket connected.");
  console.log("[AETRAM][WS] connected");
  clearActiveSubscribedMap();
  if (isMarketDataAuthenticated()) {
    broadcastBrokerStatus("live", undefined, "module2");
    triggerReconnectCallback();
  } else {
    console.warn("[AetramMD] Socket connected but session is unauthenticated. Skipping live broadcast.");
  }
});

marketDataEvents.on("RECONNECTED", () => {
  console.log("[AetramMD] Socket reconnected.");
  console.log("[AETRAM][WS] reconnected");
  clearActiveSubscribedMap();
  if (isMarketDataAuthenticated()) {
    broadcastBrokerStatus("live", undefined, "module2");
    triggerReconnectCallback();
  } else {
    console.warn("[AetramMD] Socket reconnected but session is unauthenticated. Skipping live broadcast.");
  }
});

marketDataEvents.on("DISCONNECTED", ({ reason, manual }: { reason: string; manual: boolean }) => {
  console.warn(`[AetramMD] Socket disconnected: ${reason}`);
  console.log(`[AETRAM][WS] disconnect reason=${reason}`);
  clearActiveSubscribedMap();
  if (!manual) {
    broadcastBrokerStatus("broker-disconnected", "Lost connection to broker. Reconnecting...", "module2");
  }
});

/**
 * Compute the next N upcoming Thursdays (NSE weekly expiry pattern, last resort fallback)
 */
const computeUpcomingThursdays = (count: number): string[] => {
  const result: string[] = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dayOfWeek = d.getDay();
  const daysToThursday = (4 - dayOfWeek + 7) % 7;
  d.setDate(d.getDate() + daysToThursday);
  for (let i = 0; i < count; i++) {
    result.push(parseDateToYMD(new Date(d)));
    d.setDate(d.getDate() + 7);
  }
  return result;
};

/**
 * Fetch available expiry dates for options on the given index.
 * Priority: Aetram API → MOD2_EXPIRY_DATES env → computed Thursdays
 *
 * `exchangeSegment` defaults to 2 (NSEFO) to preserve existing NIFTY/BANKNIFTY/
 * FINNIFTY behavior. Pass 12 (BSEFO) for SENSEX — the only supported BSE index.
 */
export const getAetramExpiryDates = async (indexSymbol: string, exchangeSegment = 2): Promise<string[]> => {
  const baseUrl = getBaseUrl();

  console.log(`[AETRAM][EXPIRY] request started for ${indexSymbol}`);

  if (baseUrl) {
    if (!getMarketDataToken()) {
      await loginToAetram();
    }

    if (getMarketDataToken()) {
      try {
        const name = indexSymbol.replace(/50$/i, "").replace(/FIFTY$/i, "").toUpperCase();
        // Aetram's Market Data API returns 404 for /instruments/expiry.
        // Instead, we fetch the instruments for the index and extract the unique expiries.
        const results = await searchInstruments(name);

        const todayYmd = new Date().toISOString().slice(0, 10);
        const uniqueExpiries = new Set<string>();

        for (const inst of results) {
          // Only look at options (OptionType 3 = CE, 4 = PE, or strings like "CE"/"PE")
          const optType = String(inst.optionType || "");
          if (!optType || (optType !== "3" && optType !== "4" && !optType.toUpperCase().includes("E"))) {
            continue;
          }

          const rawExp = inst.expiryDate || "";
          const ymd = parseDateToYMD(rawExp);
          if (ymd && ymd >= todayYmd) {
            uniqueExpiries.add(ymd);
          }
        }

        if (uniqueExpiries.size > 0) {
          const sorted = Array.from(uniqueExpiries).sort();
          console.log(`[AETRAM][EXPIRY] response status=200`);
          console.log(`[AETRAM][EXPIRY] expiry count=${sorted.length}`);
          console.log(`[AetramMD] Dynamic expiries found for ${indexSymbol}: ${sorted.length} dates [${sorted.slice(0, 5).join(", ")}...]`);
          return sorted;
        }
      } catch (e: any) {
        console.warn(`[AetramMD] Failed to fetch real expiries for ${indexSymbol}: ${e.message}.`);
        throw e;
      }
    }
  }

  // If unauthenticated, throw error so controller returns 401 instead of generating fake expiries
  if (!isMarketDataAuthenticated()) {
    throw new Error("Broker session expired or unauthenticated.");
  }

  const configDates = (process.env.MOD2_EXPIRY_DATES || "").trim();
  if (configDates) {
    return configDates.split(",").map((d) => d.trim()).filter(Boolean).sort();
  }

  return computeUpcomingThursdays(5);
};

import { MarketDataLoginResult } from "./marketDataSessionService";

/**
 * Login using credentials provided at runtime by the user.
 * Called by module2BrokerLogin controller — never called on server startup.
 */
export const loginToAetramWithCredentials = async (appKey: string, secretKey: string): Promise<MarketDataLoginResult> => {
  clearSearchCache();
  return await loginMarketData(appKey, secretKey, true);
};

/**
 * Legacy env-based startup — NOT called anymore. Kept for reference only.
 */
export const initAetramMarketDataService = async () => {
  // Removed from startup. Module 2 connects only after user broker login.
  console.log("[AetramMD] initAetramMarketDataService: deferred — awaiting user login.");
};