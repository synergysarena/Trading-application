import { CacheStore, MemoryCache } from "./cacheStore";
import { marketDataEvents } from "./marketDataEvents";
import { NormalizedMarketEvent } from "./marketDataPipelineService";

/**
 * Market Data Cache Layer (Phase 8).
 *
 * Sits between the pipeline (Phase 7) and every future consumer (Minute
 * Engine, Formula Engine, Socket.IO broadcast, REST APIs). Consumers read
 * the LATEST known state of an instrument through this service — never by
 * reaching into the pipeline or the socket themselves.
 *
 * Backed by CacheStore<T> (cacheStore.ts) — an in-memory Map today, a Redis
 * adapter later (Phase 10+) implementing the exact same interface. Nothing
 * in this file, and nothing that consumes it, needs to change when that swap
 * happens.
 */

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

export interface CacheStats {
  totalInstruments: number;
  totalInserts: number;
  totalReplacements: number;
  totalUpdates: number;
  lastUpdatedAt: string | null;
}

// Primary store, keyed by exchangeInstrumentID.
const store: CacheStore<MarketDataCacheEntry> = new MemoryCache<MarketDataCacheEntry>();

// Secondary index for trading-symbol lookups. No current event source
// populates this yet (see Known Limitations in the Phase 8 report) — the
// capability is ready for whichever future phase associates symbols.
const symbolIndex = new Map<string, string>(); // tradingSymbol -> exchangeInstrumentID

let totalInserts = 0;
let totalReplacements = 0;
let totalUpdates = 0;
let lastUpdatedAt: Date | null = null;

/** Coalesce: prefer the new value, fall back to whatever was already cached. */
const coalesce = <V>(next: V | null | undefined, prev: V | null | undefined): V | null =>
  next ?? prev ?? null;

/**
 * Stores the latest tick for an instrument, merging field-by-field with
 * whatever was previously cached — a packet type that only carries OI (1510)
 * must not blank out a previously-cached price, and vice versa.
 */
export const upsertTick = (event: NormalizedMarketEvent): MarketDataCacheEntry | null => {
  if (!event.exchangeInstrumentID) return null; // defensive only — the pipeline already validates this

  const key = event.exchangeInstrumentID;
  const existing = store.get(key);

  const merged: MarketDataCacheEntry = {
    exchangeSegment: coalesce(event.exchangeSegment, existing?.exchangeSegment),
    exchangeInstrumentID: key,
    tradingSymbol: existing?.tradingSymbol ?? null,
    lastPrice: coalesce(event.lastPrice, existing?.lastPrice),
    openInterest: coalesce(event.openInterest, existing?.openInterest),
    volume: coalesce(event.volume, existing?.volume),
    bid: coalesce(event.bid, existing?.bid),
    ask: coalesce(event.ask, existing?.ask),
    lastUpdateTimestamp: event.timestamp || new Date().toISOString(),
    packetType: event.rawPacketType,
  };

  store.set(key, merged);
  totalUpdates += 1;
  if (existing) totalReplacements += 1;
  else totalInserts += 1;
  lastUpdatedAt = new Date();

  return merged;
};

/** Associates a trading symbol with an already-cached instrument, enabling getByTradingSymbol(). */
export const associateTradingSymbol = (exchangeInstrumentID: string, tradingSymbol: string): boolean => {
  const entry = store.get(exchangeInstrumentID);
  if (!entry) return false;

  if (entry.tradingSymbol && entry.tradingSymbol !== tradingSymbol) {
    symbolIndex.delete(entry.tradingSymbol);
  }
  entry.tradingSymbol = tradingSymbol;
  store.set(exchangeInstrumentID, entry);
  symbolIndex.set(tradingSymbol, exchangeInstrumentID);
  return true;
};

export const getByInstrumentId = (exchangeInstrumentID: string): MarketDataCacheEntry | undefined =>
  store.get(exchangeInstrumentID);

export const getByTradingSymbol = (tradingSymbol: string): MarketDataCacheEntry | undefined => {
  const id = symbolIndex.get(tradingSymbol);
  return id ? store.get(id) : undefined;
};

export const getBulk = (exchangeInstrumentIDs: string[]): MarketDataCacheEntry[] =>
  exchangeInstrumentIDs
    .map((id) => store.get(id))
    .filter((entry): entry is MarketDataCacheEntry => !!entry);

export const getAll = (): MarketDataCacheEntry[] => store.values();

export const hasInstrument = (exchangeInstrumentID: string): boolean => store.has(exchangeInstrumentID);

export const removeInstrument = (exchangeInstrumentID: string): boolean => {
  const entry = store.get(exchangeInstrumentID);
  if (entry?.tradingSymbol) symbolIndex.delete(entry.tradingSymbol);
  return store.remove(exchangeInstrumentID);
};

export const clearCache = (): void => {
  store.clear();
  symbolIndex.clear();
  totalInserts = 0;
  totalReplacements = 0;
  totalUpdates = 0;
  lastUpdatedAt = null;
};

export const getCacheStats = (): CacheStats => ({
  totalInstruments: store.keys().length,
  totalInserts,
  totalReplacements,
  totalUpdates,
  lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
});

let initialized = false;

/**
 * Called once at server startup. Subscribes to MARKET_DATA only (Step 4) —
 * pure cache maintenance, no business logic, no persistence.
 */
export const initMarketDataCache = (): void => {
  if (initialized) return;
  initialized = true;

  marketDataEvents.on("MARKET_DATA", (event: NormalizedMarketEvent) => {
    upsertTick(event);
  });

  console.log("[MarketDataCache] Initialized — caching every MARKET_DATA event.");
};
