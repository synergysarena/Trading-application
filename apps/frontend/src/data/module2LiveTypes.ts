// Types mirroring the Module 2 Phase 3-12 backend response shapes.
// Kept local to the frontend (no shared package changes) since these are
// pure API response contracts, not shared business logic.

export const SUPPORTED_INSTRUMENTS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"] as const;
export type SupportedInstrument = typeof SUPPORTED_INSTRUMENTS[number];

export const INSTRUMENT_EXCHANGE: Record<SupportedInstrument, "NSE" | "BSE"> = {
  NIFTY: "NSE",
  BANKNIFTY: "NSE",
  FINNIFTY: "NSE",
  MIDCPNIFTY: "NSE",
  SENSEX: "BSE",
};

export type OptionType = "CE" | "PE";

// ── Instrument Discovery (Phase 3) ─────────────────────────────────────────────

export interface InstrumentSearchResult {
  exchange: string;
  instrumentName: string;
  tradingSymbol: string;
  exchangeInstrumentID: string;
  series: string;
  instrumentType: string;
}

export interface ResolvedInstrument {
  valid: boolean;
  reason?: string;
  exchangeInstrumentID?: string;
  tradingSymbol?: string;
  exchangeSegment?: number;
}

// ── Subscription Management (Phase 4) ──────────────────────────────────────────

export type SubscriptionStatus = "ACTIVE" | "REMOVED";

export interface SubscriptionRecord {
  subscriptionId: string;
  sessionId: string;
  exchange: string;
  exchangeSegment: number;
  exchangeInstrumentID: string;
  tradingSymbol: string;
  strike: number;
  optionType: OptionType;
  subscribedAt: string;
  status: SubscriptionStatus;
}

// ── WebSocket Connection Manager (Phase 5) ─────────────────────────────────────

export type BrokerConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING";

export interface BrokerConnectionHealth {
  state: BrokerConnectionState;
  authenticated: boolean;
  connectionStartedAt: string | null;
  connectedAt: string | null;
  lastHeartbeatAt: string | null;
  lastDisconnectAt: string | null;
  reconnectAttempts: number;
  lastError: string | null;
}

// ── Market Data Cache (Phase 8) ─────────────────────────────────────────────────

export interface MarketDataCacheEntry {
  exchangeSegment: number | null;
  exchangeInstrumentID: string;
  tradingSymbol: string | null;
  lastPrice: number | null;
  openInterest: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  lastUpdateTimestamp: string;
  packetType: string;
}

// ── Minute Aggregation Engine (Phase 9) ─────────────────────────────────────────

export interface MinuteCandle {
  exchangeSegment: number | null;
  exchangeInstrumentID: string;
  tradingSymbol: string | null;
  minuteStartTime: string;
  minuteEndTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  openInterest: number | null;
  tickCount: number;
}

// ── Redis History (Phase 10) / MongoDB Archive (Phase 11) ─────────────────────

export interface PersistedCandle {
  exchangeSegment: number | null;
  instrumentId: string;
  tradingSymbol: string | null;
  minuteStart: string;
  minuteEnd: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  openInterest: number | null;
  tickCount: number;
  persistedAt?: string;
  completedAt?: string;
}

// ── Socket.IO Broadcast Layer (Phase 12) ────────────────────────────────────────

/** Payload of the `market:update` socket event — never carries a packet type. */
export interface MarketUpdatePayload {
  exchangeSegment: number | null;
  exchangeInstrumentID: string;
  timestamp: string | null;
  lastPrice: number | null;
  openInterest: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
}

/** Payload of the `market:candle` socket event — a completed MinuteCandle. */
export type MarketCandlePayload = MinuteCandle;

export interface MarketConnectionPayload {
  status: "CONNECTED" | "RECONNECTED" | "DISCONNECTED";
  connectedAt?: string;
  reason?: string;
  manual?: boolean;
}

export interface MarketSubscriptionPayload {
  status: "SUBSCRIBED" | "UNSUBSCRIBED";
  exchangeInstrumentID: string;
  subscriptionId?: string;
}

export interface SocketStats {
  connectedClients: number;
  broadcastCounts: Record<string, number>;
  activeInstrumentRooms: number;
  activeSessionRooms: number;
}
