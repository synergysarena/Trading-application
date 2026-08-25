import { api } from "../utils/api";
import type {
  InstrumentSearchResult,
  ResolvedInstrument,
  SubscriptionRecord,
  SubscriptionStatus,
  BrokerConnectionHealth,
  MarketDataCacheEntry,
  MinuteCandle,
  PersistedCandle,
  SocketStats,
  OptionType,
} from "./module2LiveTypes";

/**
 * Market Data API service (Phase 13, Step 2).
 *
 * Thin wrapper over every existing Module 2 Phase 3-12 backend endpoint.
 * No business logic here — each function is a single API call with typed
 * request/response shapes. All calls reuse the existing `api` client (same
 * auth/retry/error handling every other frontend feature already uses).
 * Not a single one of these endpoints is new — see the backend routes in
 * apps/backend/src/routes/module2.ts.
 */

// ── Instrument Discovery (Phase 3) ─────────────────────────────────────────────

export const searchInstruments = (symbol: string): Promise<{ symbol: string; results: InstrumentSearchResult[] }> =>
  api.get(`/module2/instruments/search?symbol=${encodeURIComponent(symbol)}`);

export const getExpiryDates = (symbol: string): Promise<{ symbol: string; expiries: string[] }> =>
  api.get(`/module2/instruments/expiry?symbol=${encodeURIComponent(symbol)}`);

export interface ResolveInstrumentParams {
  exchange: string;
  instrument: string;
  expiry: string;
  strike: number;
  optionType: OptionType;
}

export const resolveInstrument = (params: ResolveInstrumentParams): Promise<ResolvedInstrument> =>
  api.post("/module2/instruments/resolve", params);

// ── Subscription Management (Phase 4) ──────────────────────────────────────────

export interface SubscribeParams extends ResolveInstrumentParams {
  sessionId: string;
}

export const subscribe = (params: SubscribeParams): Promise<{ ok: boolean; code?: string; reason?: string; subscription?: SubscriptionRecord }> =>
  api.post("/module2/subscriptions", params);

export const bulkSubscribe = (
  sessionId: string,
  instruments: ResolveInstrumentParams[]
): Promise<{ requested: number; subscribed: number; failed: number; results: any[] }> =>
  api.post("/module2/subscriptions/bulk", { sessionId, instruments });

export const unsubscribe = (sessionId: string, subscriptionId: string): Promise<{ ok: boolean; code?: string; reason?: string }> =>
  api.delete("/module2/subscriptions", { body: JSON.stringify({ sessionId, subscriptionId }) });

export const bulkUnsubscribe = (
  sessionId: string,
  subscriptionIds: string[]
): Promise<{ requested: number; subscribed: number; failed: number }> =>
  api.delete("/module2/subscriptions", { body: JSON.stringify({ sessionId, subscriptionIds }) });

export const getSubscriptions = (
  sessionId: string,
  status?: SubscriptionStatus
): Promise<{ sessionId: string; count: number; subscriptions: SubscriptionRecord[] }> =>
  api.get(`/module2/subscriptions?sessionId=${encodeURIComponent(sessionId)}${status ? `&status=${status}` : ""}`);

// ── WebSocket Connection Manager (Phase 5) ─────────────────────────────────────

export const wsConnect = (): Promise<{ ok: boolean; reason?: string; status: BrokerConnectionHealth }> =>
  api.post("/module2/ws/connect");

export const wsDisconnect = (): Promise<{ ok: boolean; status: BrokerConnectionHealth }> =>
  api.post("/module2/ws/disconnect");

export const wsReconnect = (): Promise<{ ok: boolean; reason?: string; status: BrokerConnectionHealth }> =>
  api.post("/module2/ws/reconnect");

export const getWsStatus = (): Promise<BrokerConnectionHealth> => api.get("/module2/ws/status");

// ── Market Data Cache (Phase 8) ─────────────────────────────────────────────────

export const getCache = (): Promise<{ count: number; entries: MarketDataCacheEntry[] }> => api.get("/module2/cache");

export const getCacheEntry = (instrumentId: string): Promise<MarketDataCacheEntry> =>
  api.get(`/module2/cache/${encodeURIComponent(instrumentId)}`);

// ── Minute Aggregation Engine (Phase 9) ─────────────────────────────────────────

export const getCurrentCandles = (): Promise<{ count: number; candles: MinuteCandle[] }> =>
  api.get("/module2/candles/current");

export const getCandle = (instrumentId: string): Promise<MinuteCandle> =>
  api.get(`/module2/candles/${encodeURIComponent(instrumentId)}`);

// ── Redis History (Phase 10) ─────────────────────────────────────────────────────

export const getCandleHistory = (
  instrumentId: string,
  limit = 50
): Promise<{ instrumentId: string; count: number; candles: PersistedCandle[] }> =>
  api.get(`/module2/history/${encodeURIComponent(instrumentId)}?limit=${limit}`);

export const getLatestHistoryCandle = (instrumentId: string): Promise<PersistedCandle> =>
  api.get(`/module2/history/${encodeURIComponent(instrumentId)}/latest`);

// ── MongoDB Archive (Phase 11) ────────────────────────────────────────────────

export const getArchive = (
  instrumentId: string,
  limit = 50
): Promise<{ instrumentId: string; count: number; candles: PersistedCandle[] }> =>
  api.get(`/module2/archive/${encodeURIComponent(instrumentId)}?limit=${limit}`);

export const getLatestArchiveCandle = (instrumentId: string): Promise<PersistedCandle> =>
  api.get(`/module2/archive/${encodeURIComponent(instrumentId)}/latest`);

export const getArchiveRange = (
  instrumentId: string,
  from: string,
  to: string
): Promise<{ instrumentId: string; from: string; to: string; count: number; candles: PersistedCandle[] }> =>
  api.get(`/module2/archive/${encodeURIComponent(instrumentId)}/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

// ── Socket Debug (Phase 12) ──────────────────────────────────────────────────────

export const getSocketStats = (): Promise<SocketStats> => api.get("/module2/socket/stats");

export const getSocketClients = (): Promise<{ count: number; clients: any[] }> => api.get("/module2/socket/clients");

// ── Legacy tracker-session bridge (existing, unmodified endpoint) ─────────────
//
// The Phase 4 subscription registry validates sessionId against
// trackerService's activeSessions — the tracker session store the OLD
// Module 2 Strike Tracker screen creates via this same endpoint. This new
// screen calls the exact same existing, unmodified contract to mint a
// sessionId of its own; see useTrackerSessionBridge for how it's kept
// separate from the old screen's session state. No backend change involved.

export interface StartTrackerSessionParams {
  sessionType: "CE" | "PE" | "mixed";
  indexSymbol: string;
  expiryDate: string;
  selectedStrikes: string[];
}

export const startTrackerSessionBridge = (params: StartTrackerSessionParams): Promise<{ sessionId: string }> =>
  api.post("/api/module2/session/start", params);
