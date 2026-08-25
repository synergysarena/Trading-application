import { useEffect, useState } from "react";
import { marketSocketClient } from "../../services/module2MarketSocket";
import { getCacheEntry } from "../../data/module2MarketApi";
import type { MarketUpdatePayload } from "../../data/module2LiveTypes";

/**
 * Live LTP/OI/Volume/Bid/Ask/Timestamp for one instrument (Phase 13, Step 7).
 *
 * Seeds from the Phase 8 cache (GET /module2/cache/:instrumentId) so the UI
 * shows the last-known tick immediately instead of a blank state, then
 * switches to live `market:update` events. Joining the instrument room is
 * reference-counted in marketSocketClient, so this hook and useCandles can
 * both be mounted for the same instrument without either's unmount cutting
 * off the other.
 */
export const useMarketData = (instrumentId: string | null) => {
  const [data, setData] = useState<MarketUpdatePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    if (!instrumentId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    getCacheEntry(instrumentId)
      .then((entry) => {
        if (cancelled) return;
        setData({
          exchangeSegment: entry.exchangeSegment,
          exchangeInstrumentID: entry.exchangeInstrumentID,
          timestamp: entry.lastUpdateTimestamp,
          lastPrice: entry.lastPrice,
          openInterest: entry.openInterest,
          volume: entry.volume,
          bid: entry.bid,
          ask: entry.ask,
        });
      })
      .catch(() => {
        // No cached tick yet is a normal empty state, not an error — the
        // live market:update listener below will populate it once a tick arrives.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [instrumentId]);

  useEffect(() => {
    if (!instrumentId) return;
    marketSocketClient.joinRoom("instrument", instrumentId);

    const handler = (payload: MarketUpdatePayload) => {
      if (payload.exchangeInstrumentID !== instrumentId) return;
      setData(payload);
      setError(null);
    };
    marketSocketClient.on("market:update", handler);

    return () => {
      marketSocketClient.off("market:update", handler);
      marketSocketClient.leaveRoom("instrument", instrumentId);
    };
  }, [instrumentId]);

  return { data, loading, error };
};
