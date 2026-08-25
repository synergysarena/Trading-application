import { EventEmitter } from "events";

/**
 * Internal backend-only event bus for the Market Data WebSocket lifecycle,
 * subscription synchronization (Phase 6), and the market data pipeline
 * (Phase 7). NOT the Socket.IO layer that talks to the frontend (see
 * socketService.ts / broadcastBrokerStatus) — this is purely for backend
 * services to react to each other without importing one another directly
 * (e.g. aetramMarketDataService and subscriptionSyncService both react to the
 * WebSocket manager's lifecycle without it knowing they exist; the pipeline
 * publishes normalized ticks without knowing who, if anyone, consumes them).
 */

export type MarketDataEventName =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTED"
  | "SUBSCRIBED"
  | "UNSUBSCRIBED"
  | "SUBSCRIPTION_FAILED"
  | "SUBSCRIPTION_REGISTERED"
  | "MARKET_DATA"
  | "LTP_UPDATED"
  | "OI_UPDATED"
  | "PIPELINE_ERROR"
  | "CANDLE_STARTED"
  | "CANDLE_UPDATED"
  | "CANDLE_COMPLETED";

export interface ConnectedEventPayload {
  connectedAt: string;
}

export interface DisconnectedEventPayload {
  reason: string;
  manual: boolean;
}

export interface SubscribedEventPayload {
  count: number;
  exchangeInstrumentIDs: string[];
}

export interface UnsubscribedEventPayload {
  subscriptionId: string;
  exchangeInstrumentID: string;
  sessionId: string;
}

export interface SubscriptionFailedEventPayload {
  reason: string;
  attemptedCount: number;
}

export interface SubscriptionRegisteredEventPayload {
  sessionId: string;
  count: number;
}

class MarketDataEventBus extends EventEmitter {}

export const marketDataEvents = new MarketDataEventBus();

// EventEmitter defaults to warning past 10 listeners on one event — several
// independent backend services legitimately listen to the same lifecycle
// events here, so raise the ceiling rather than silence a real leak signal.
marketDataEvents.setMaxListeners(20);
