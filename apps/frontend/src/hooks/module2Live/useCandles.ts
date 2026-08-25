import { useEffect, useState } from "react";
import { marketSocketClient } from "../../services/module2MarketSocket";
import { getCandle } from "../../data/module2MarketApi";
import type { MinuteCandle } from "../../data/module2LiveTypes";

/**
 * Live 1-minute OHLC candle for one instrument (Phase 13, Step 8).
 *
 * Seeds from the Phase 9 in-progress candle (GET /module2/candles/:instrumentId)
 * then switches to live `market:candle` events (fired once per completed
 * minute). Room join is reference-counted — see useMarketData for why.
 */
export const useCandles = (instrumentId: string | null) => {
  const [candle, setCandle] = useState<MinuteCandle | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setCandle(null);
    if (!instrumentId) return;

    let cancelled = false;
    setLoading(true);

    getCandle(instrumentId)
      .then((c) => {
        if (!cancelled) setCandle(c);
      })
      .catch(() => {
        // No in-progress candle yet — normal empty state until the first tick.
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

    const handler = (payload: MinuteCandle) => {
      if (payload.exchangeInstrumentID !== instrumentId) return;
      setCandle(payload);
    };
    marketSocketClient.on("market:candle", handler);

    return () => {
      marketSocketClient.off("market:candle", handler);
      marketSocketClient.leaveRoom("instrument", instrumentId);
    };
  }, [instrumentId]);

  return { candle, loading };
};
