import { marketDataEvents } from "./marketDataEvents";

/**
 * Market Data Pipeline (Phase 7).
 *
 * Pure transport → structured-data conversion: decode a raw broker packet,
 * normalize it into a common shape, validate it, publish it as an internal
 * event. No storage, no Redis, no MongoDB, no calculations — every future
 * subsystem (Phase 8 persistence, Phase 9 aggregation, ...) consumes this by
 * subscribing to marketDataEvents, not by calling into this file directly.
 *
 * Entry point is processRawPacket(packetType, raw) — called from wherever a
 * raw socket event lands (aetramMarketDataService's onRawSocketEvent
 * registrations). It never throws; every failure path publishes
 * PIPELINE_ERROR instead of crashing the caller.
 */

export interface NormalizedMarketEvent {
  exchangeSegment: number | null;
  exchangeInstrumentID: string | null;
  timestamp: string | null; // ISO 8601, receipt time if the broker didn't send one
  lastPrice: number | null;
  openInterest: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  rawPacketType: string;
}

export interface PipelineErrorPayload {
  packetType: string;
  reason: string;
  partialEvent: NormalizedMarketEvent | null;
}

/** Intermediate shape a decoder extracts from a raw packet — every field optional, decoder-specific. */
interface DecodedFields {
  exchangeSegment?: number;
  exchangeInstrumentID?: string;
  timestamp?: number | string;
  lastPrice?: number;
  openInterest?: number;
  volume?: number;
  bid?: number;
  ask?: number;
}

type PacketDecoder = (payload: Record<string, any>) => DecodedFields | null;

const numOrUndef = (v: any): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const strOrUndef = (v: any): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
};

// ── Per-packet-type decoders (Step 3) — one small function each, registered
// below in a lookup map instead of a giant switch. Field names follow the
// Symphony XTS Market Data message conventions; 1510/1512 are verified against
// this codebase's existing tick handlers, 1501/1502 are spec-based best-effort
// since nothing in this project has ever subscribed to them live (see Known
// Limitations in the Phase 7 report).

/** 1501 — Full Touchline: LTP + OI + best bid/ask + volume in one packet. */
const decodeTouchline1501: PacketDecoder = (payload) => {
  const t = payload.Touchline || payload.touchline || payload;
  return {
    exchangeSegment: numOrUndef(payload.exchangeSegment ?? payload.ExchangeSegment),
    exchangeInstrumentID: strOrUndef(payload.exchangeInstrumentID ?? payload.ExchangeInstrumentID),
    lastPrice: numOrUndef(t.lastTradedPrice ?? t.LastTradedPrice),
    openInterest: numOrUndef(t.openInterest ?? t.OpenInterest),
    volume: numOrUndef(t.totalTradedQuantity ?? t.TotalTradedQuantity),
    bid: numOrUndef(t.bidInfo?.price ?? t.BidInfo?.Price ?? t.bidPrice),
    ask: numOrUndef(t.askInfo?.price ?? t.AskInfo?.Price ?? t.askPrice),
    timestamp: payload.lastUpdateTime ?? payload.LastUpdateTime ?? payload.timestamp,
  };
};

/** 1502 — Market Depth (order book): best bid/ask taken from the top of book. */
const decodeMarketDepth1502: PacketDecoder = (payload) => {
  const bids = payload.Bids || payload.bids || [];
  const asks = payload.Asks || payload.asks || [];
  const bestBid = Array.isArray(bids) ? bids[0] : undefined;
  const bestAsk = Array.isArray(asks) ? asks[0] : undefined;
  return {
    exchangeSegment: numOrUndef(payload.exchangeSegment ?? payload.ExchangeSegment),
    exchangeInstrumentID: strOrUndef(payload.exchangeInstrumentID ?? payload.ExchangeInstrumentID),
    bid: numOrUndef(bestBid?.price ?? bestBid?.Price),
    ask: numOrUndef(bestAsk?.price ?? bestAsk?.Price),
    timestamp: payload.lastUpdateTime ?? payload.LastUpdateTime ?? payload.timestamp,
  };
};

const parseStringPayload = (str: string): Record<string, any> => {
  const result: Record<string, any> = {};
  const parts = str.split(",");
  for (const part of parts) {
    const colonIndex = part.indexOf(":");
    if (colonIndex !== -1) {
      const key = part.substring(0, colonIndex).trim();
      const val = part.substring(colonIndex + 1).trim();
      result[key] = val;
    }
  }
  if (result.t) {
    const [seg, tok] = result.t.split("_");
    if (seg) result.exchangeSegment = seg;
    if (tok) result.exchangeInstrumentID = tok;
  }
  return result;
};

/** 1510 — Open Interest updates. Field names match aetramMarketDataService's existing handleOiTick. */
const decodeOpenInterest1510: PacketDecoder = (payload) => {
  const t = payload.Touchline || payload.touchline || payload;
  return {
    exchangeSegment: numOrUndef(payload.exchangeSegment ?? payload.ExchangeSegment ?? t.exchangeSegment ?? t.ExchangeSegment),
    exchangeInstrumentID: strOrUndef(payload.exchangeInstrumentID ?? payload.ExchangeInstrumentID ?? payload.InstrumentID ?? payload.Token ?? t.exchangeInstrumentID ?? t.ExchangeInstrumentID),
    openInterest: numOrUndef(payload.openInterest ?? payload.OpenInterest ?? payload.oi ?? payload.OI ?? t.openInterest ?? t.OpenInterest ?? t.oi),
    timestamp: payload.timestamp ?? payload.LastUpdateTime ?? payload.lut,
  };
};

/** 1512 — LTP updates. Field names match aetramMarketDataService's existing handleLtpTick. */
const decodeLtp1512: PacketDecoder = (payload) => {
  const t = payload.Touchline || payload.touchline || payload;
  return {
    exchangeSegment: numOrUndef(payload.exchangeSegment ?? payload.ExchangeSegment ?? t.exchangeSegment ?? t.ExchangeSegment),
    exchangeInstrumentID: strOrUndef(payload.exchangeInstrumentID ?? payload.ExchangeInstrumentID ?? payload.InstrumentID ?? payload.Token ?? t.exchangeInstrumentID ?? t.ExchangeInstrumentID),
    lastPrice: numOrUndef(payload.lastTradedPrice ?? payload.LastTradedPrice ?? payload.lastPrice ?? payload.LastPrice ?? payload.ltp ?? payload.LTP ?? payload.close ?? payload.c ?? t.lastTradedPrice ?? t.LastTradedPrice ?? t.lastPrice ?? t.LastPrice ?? t.ltp ?? t.LTP),
    volume: numOrUndef(payload.totalTradedQuantity ?? payload.TotalTradedQuantity ?? payload.volume ?? payload.ltq ?? t.totalTradedQuantity ?? t.TotalTradedQuantity),
    timestamp: payload.lastTradedTime ?? payload.timestamp ?? payload.LastUpdateTime ?? payload.lut,
  };
};

const DECODERS: Record<string, PacketDecoder> = {
  "1501": decodeTouchline1501,
  "1502": decodeMarketDepth1502,
  "1510": decodeOpenInterest1510,
  "1512": decodeLtp1512,
};

/**
 * Normalization (Step 4) — every decoded packet becomes this exact shape.
 * Missing fields are null, never omitted, so downstream consumers can rely on
 * every key always being present.
 */
const normalizePacket = (packetType: string, decoded: DecodedFields): NormalizedMarketEvent => {
  let timestamp: string | null;
  if (decoded.timestamp === undefined || decoded.timestamp === null) {
    // Broker didn't send one — receipt time is a reasonable stand-in, not an error.
    timestamp = new Date().toISOString();
  } else {
    const raw = decoded.timestamp;
    // XTS sometimes sends epoch seconds, sometimes milliseconds — treat anything
    // shorter than a millisecond-epoch (< 1e12) as seconds.
    const numRaw = Number(raw);
    const asDate = !isNaN(numRaw)
      ? new Date(numRaw < 1e12 ? numRaw * 1000 : numRaw)
      : new Date(raw);
    timestamp = isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }

  return {
    exchangeSegment: decoded.exchangeSegment ?? null,
    exchangeInstrumentID: decoded.exchangeInstrumentID ?? null,
    timestamp,
    lastPrice: decoded.lastPrice ?? null,
    openInterest: decoded.openInterest ?? null,
    volume: decoded.volume ?? null,
    bid: decoded.bid ?? null,
    ask: decoded.ask ?? null,
    rawPacketType: packetType,
  };
};

const publishError = (packetType: string, reason: string, partialEvent: NormalizedMarketEvent | null = null) => {
  console.warn(`[MarketDataPipeline] Rejected ${packetType} packet: ${reason}`);
  const payload: PipelineErrorPayload = { packetType, reason, partialEvent };
  marketDataEvents.emit("PIPELINE_ERROR", payload);
};

const lastTickCache = new Map<string, string>();

/**
 * Entry point: receive one raw broker packet, decode → normalize → validate →
 * publish. Never throws — every failure path is a PIPELINE_ERROR emit instead
 * (Step 5: "Never crash the pipeline").
 */
export const processRawPacket = (packetType: string, raw: unknown): void => {
  try {
    let payload: any = raw;

    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (trimmed.startsWith("{")) {
        try {
          payload = JSON.parse(trimmed);
        } catch {
          publishError(packetType, "Corrupted payload — string could not be parsed as JSON.");
          return;
        }
      } else if (trimmed.includes(":") || trimmed.includes(",")) {
        payload = parseStringPayload(trimmed);
      }
    }

    const decoder = DECODERS[packetType];
    if (!decoder) {
      publishError(packetType, `Unknown packet type "${packetType}".`);
      return;
    }

    if (Array.isArray(payload)) {
      for (const item of payload) {
        processRawPacket(packetType, item);
      }
      return;
    }

    if (!payload || typeof payload !== "object") {
      publishError(packetType, "Malformed packet — payload is not an object.");
      return;
    }

    const decoded = decoder(payload);
    if (!decoded) {
      publishError(packetType, "Malformed packet — decoder could not extract any fields.");
      return;
    }

    const event = normalizePacket(packetType, decoded);

    if (!event.exchangeInstrumentID) {
      publishError(packetType, "Missing instrument ID.", event);
      return;
    }
    if (event.timestamp === null) {
      publishError(packetType, "Invalid timestamp.", event);
      return;
    }

    marketDataEvents.emit("MARKET_DATA", event);
    if (event.lastPrice !== null) {
      const tickKey = `${event.exchangeInstrumentID}|${event.lastPrice}|${event.timestamp}`;
      if (lastTickCache.get(event.exchangeInstrumentID!) === tickKey) {
        return;
      }
      lastTickCache.set(event.exchangeInstrumentID!, tickKey);

      if (event.lastPrice === 0) {
        console.log(`[PIPELINE][ZERO_LTP] token=${event.exchangeInstrumentID} rawPayload=${JSON.stringify(payload)}`);
      } else {
        console.log(`[PIPELINE][NORMALIZED] token=${event.exchangeInstrumentID} lastPrice=${event.lastPrice}`);
      }
      marketDataEvents.emit("LTP_UPDATED", event);
    }
    if (event.openInterest !== null) marketDataEvents.emit("OI_UPDATED", event);
  } catch (err: any) {
    publishError(packetType, err?.message || String(err));
  }
};

export const getSupportedPacketTypes = (): string[] => Object.keys(DECODERS);
