import { randomUUID } from "crypto";
import { isMarketDataAuthenticated } from "./marketDataSessionService";
import { activeSessions } from "./trackerService";
import { resolveStrikeToken } from "./instrumentService";
import { marketDataEvents } from "./marketDataEvents";

/**
 * Module 2 Subscription Management layer (Phase 4).
 *
 * Owns an in-memory registry of "instruments a session wants ticks for" —
 * NOT the live broker subscription itself. Building this registry is pure
 * bookkeeping: no WebSocket connect, no broker subscribe call. subscriptionSyncService
 * (Phase 6) reads this registry (via getAllActiveSubscriptions) to decide what
 * to actually subscribe to over the wire once the shared socket is connected.
 *
 * Session existence + market-data auth are reused as-is from trackerService /
 * marketDataSessionService — nothing there is modified.
 */

export type SubscriptionStatus = "ACTIVE" | "REMOVED";

export type SubscriptionRejectCode =
  | "INVALID_SESSION"
  | "MISSING_AUTH"
  | "DUPLICATE"
  | "LIMIT_EXCEEDED"
  | "INVALID_INSTRUMENT"
  | "NOT_FOUND";

export interface SubscriptionRecord {
  subscriptionId: string;
  sessionId: string;
  exchange: string;
  exchangeSegment: number;
  exchangeInstrumentID: string;
  tradingSymbol: string;
  strike: number;
  optionType: "CE" | "PE";
  subscribedAt: string; // ISO timestamp
  status: SubscriptionStatus;
}

export interface SubscriptionRequest {
  exchange: string;
  instrument: string;
  expiry: string;
  strike: number;
  optionType: string;
}

export interface SubscriptionResult {
  ok: boolean;
  code?: SubscriptionRejectCode;
  reason?: string;
  subscription?: SubscriptionRecord;
}

export interface BulkSubscriptionResult {
  requested: number;
  subscribed: number;
  failed: number;
  results: SubscriptionResult[];
}

// Max simultaneous ACTIVE subscriptions per session — generous enough for a full
// option-chain band (e.g. 25 strikes x CE+PE = 50) while still bounding memory.
const MAX_SUBSCRIPTIONS_PER_SESSION = Number(process.env.MOD2_MAX_SUBSCRIPTIONS_PER_SESSION) || 50;

// sessionId -> subscriptionId -> record
const registry = new Map<string, Map<string, SubscriptionRecord>>();

const getSessionRegistry = (sessionId: string): Map<string, SubscriptionRecord> => {
  let sessionRegistry = registry.get(sessionId);
  if (!sessionRegistry) {
    sessionRegistry = new Map();
    registry.set(sessionId, sessionRegistry);
  }
  return sessionRegistry;
};

const activeCountForSession = (sessionId: string): number => {
  const sessionRegistry = registry.get(sessionId);
  if (!sessionRegistry) return 0;
  let count = 0;
  for (const rec of sessionRegistry.values()) {
    if (rec.status === "ACTIVE") count++;
  }
  return count;
};

const findActiveByInstrumentId = (sessionId: string, exchangeInstrumentID: string): SubscriptionRecord | null => {
  const sessionRegistry = registry.get(sessionId);
  if (!sessionRegistry) return null;
  for (const rec of sessionRegistry.values()) {
    if (rec.status === "ACTIVE" && rec.exchangeInstrumentID === exchangeInstrumentID) return rec;
  }
  return null;
};

/**
 * Validates that the session exists (reusing trackerService's activeSessions —
 * the same registry startTrackerSession/resumeSession populate) and that a
 * Market Data session is currently authenticated.
 */
const validateSessionAndAuth = (sessionId: string): SubscriptionResult | null => {
  if (!sessionId || !activeSessions[sessionId]) {
    return { ok: false, code: "INVALID_SESSION", reason: `No active tracker session found for sessionId "${sessionId}".` };
  }
  if (!isMarketDataAuthenticated()) {
    return { ok: false, code: "MISSING_AUTH", reason: "Market Data session is not authenticated. Login required before subscribing." };
  }
  return null;
};

/**
 * Resolves the instrument, checks for duplicates + the per-session limit, and
 * registers the record if everything passes. Shared by subscribe() and
 * bulkSubscribe() so limit/duplicate checks stay consistent across both paths.
 */
const resolveAndRegister = async (sessionId: string, request: SubscriptionRequest): Promise<SubscriptionResult> => {
  const resolved = await resolveStrikeToken({
    exchange: request.exchange,
    instrument: request.instrument,
    expiry: request.expiry,
    strike: request.strike,
    optionType: request.optionType,
  });

  if (!resolved.valid || !resolved.exchangeInstrumentID || !resolved.tradingSymbol || resolved.exchangeSegment === undefined) {
    console.warn(`[SubscriptionService] Invalid instrument for session ${sessionId}: ${resolved.reason}`);
    return { ok: false, code: "INVALID_INSTRUMENT", reason: resolved.reason || "Instrument could not be resolved." };
  }

  const existing = findActiveByInstrumentId(sessionId, resolved.exchangeInstrumentID);
  if (existing) {
    console.warn(`[SubscriptionService] Duplicate subscription rejected: session=${sessionId} instrument=${resolved.exchangeInstrumentID}`);
    return { ok: false, code: "DUPLICATE", reason: `Instrument ${resolved.tradingSymbol} is already subscribed for this session.`, subscription: existing };
  }

  if (activeCountForSession(sessionId) >= MAX_SUBSCRIPTIONS_PER_SESSION) {
    console.warn(`[SubscriptionService] Subscription limit exceeded for session ${sessionId} (max ${MAX_SUBSCRIPTIONS_PER_SESSION}).`);
    return { ok: false, code: "LIMIT_EXCEEDED", reason: `Maximum of ${MAX_SUBSCRIPTIONS_PER_SESSION} subscriptions per session exceeded.` };
  }

  const record: SubscriptionRecord = {
    subscriptionId: randomUUID(),
    sessionId,
    exchange: request.exchange.trim().toUpperCase(),
    exchangeSegment: resolved.exchangeSegment,
    exchangeInstrumentID: resolved.exchangeInstrumentID,
    tradingSymbol: resolved.tradingSymbol,
    strike: request.strike,
    optionType: request.optionType.trim().toUpperCase() as "CE" | "PE",
    subscribedAt: new Date().toISOString(),
    status: "ACTIVE",
  };

  getSessionRegistry(sessionId).set(record.subscriptionId, record);
  console.log(`[SubscriptionService] Subscription created: session=${sessionId} symbol=${record.tradingSymbol} id=${record.subscriptionId}`);
  return { ok: true, subscription: record };
};

/**
 * POST /module2/subscriptions
 */
export const subscribe = async (sessionId: string, request: SubscriptionRequest): Promise<SubscriptionResult> => {
  const gate = validateSessionAndAuth(sessionId);
  if (gate) return gate;
  const result = await resolveAndRegister(sessionId, request);
  if (result.ok) {
    marketDataEvents.emit("SUBSCRIPTION_REGISTERED", { sessionId, count: 1 });
  }
  return result;
};

/**
 * POST /module2/subscriptions/bulk
 * Builds one subscription object per requested instrument (e.g. 10 CE + 10 PE
 * → 20 objects), each independently validated/deduped/limit-checked.
 */
export const bulkSubscribe = async (sessionId: string, requests: SubscriptionRequest[]): Promise<BulkSubscriptionResult | SubscriptionResult> => {
  const gate = validateSessionAndAuth(sessionId);
  if (gate) return gate;

  console.log(`[SubscriptionService] Bulk subscribe requested: session=${sessionId} count=${requests.length}`);

  const results: SubscriptionResult[] = [];
  for (const request of requests) {
    results.push(await resolveAndRegister(sessionId, request));
  }

  const subscribed = results.filter((r) => r.ok).length;
  console.log(`[SubscriptionService] Bulk subscribe complete: session=${sessionId} subscribed=${subscribed}/${requests.length}`);

  if (subscribed > 0) {
    marketDataEvents.emit("SUBSCRIPTION_REGISTERED", { sessionId, count: subscribed });
  }

  return { requested: requests.length, subscribed, failed: requests.length - subscribed, results };
};

/**
 * DELETE /module2/subscriptions (single)
 */
export const unsubscribe = (sessionId: string, subscriptionId: string): SubscriptionResult => {
  const sessionRegistry = registry.get(sessionId);
  const record = sessionRegistry?.get(subscriptionId);

  if (!record || record.status !== "ACTIVE") {
    console.warn(`[SubscriptionService] Unsubscribe failed — not found: session=${sessionId} id=${subscriptionId}`);
    return { ok: false, code: "NOT_FOUND", reason: `No active subscription "${subscriptionId}" found for this session.` };
  }

  record.status = "REMOVED";
  console.log(`[SubscriptionService] Subscription removed: session=${sessionId} symbol=${record.tradingSymbol} id=${subscriptionId}`);
  marketDataEvents.emit("UNSUBSCRIBED", { subscriptionId, exchangeInstrumentID: record.exchangeInstrumentID, sessionId });
  return { ok: true, subscription: record };
};

/**
 * DELETE /module2/subscriptions (bulk)
 */
export const bulkUnsubscribe = (sessionId: string, subscriptionIds: string[]): BulkSubscriptionResult => {
  console.log(`[SubscriptionService] Bulk unsubscribe requested: session=${sessionId} count=${subscriptionIds.length}`);

  const results = subscriptionIds.map((id) => unsubscribe(sessionId, id));
  const subscribed = results.filter((r) => r.ok).length;

  console.log(`[SubscriptionService] Bulk unsubscribe complete: session=${sessionId} removed=${subscribed}/${subscriptionIds.length}`);
  return { requested: subscriptionIds.length, subscribed, failed: subscriptionIds.length - subscribed, results };
};

/**
 * GET /module2/subscriptions
 * Returns subscriptions for a session, optionally filtered by status
 * (defaults to ACTIVE only).
 */
export const getSubscriptions = (sessionId: string, status?: SubscriptionStatus): SubscriptionRecord[] => {
  const sessionRegistry = registry.get(sessionId);
  if (!sessionRegistry) return [];
  const filterStatus = status || "ACTIVE";
  return Array.from(sessionRegistry.values()).filter((r) => r.status === filterStatus);
};

export const getSubscriptionLimit = (): number => MAX_SUBSCRIPTIONS_PER_SESSION;

/**
 * Every ACTIVE subscription across all sessions, regardless of which session
 * created it. Used by subscriptionSyncService (Phase 6) to build the full
 * broker-facing subscribe list on connect/reconnect — the broker's socket
 * doesn't know about our per-session concept, only instrument tokens.
 */
export const getAllActiveSubscriptions = (): SubscriptionRecord[] => {
  const all: SubscriptionRecord[] = [];
  for (const sessionRegistry of registry.values()) {
    for (const record of sessionRegistry.values()) {
      if (record.status === "ACTIVE") all.push(record);
    }
  }
  return all;
};
