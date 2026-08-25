import { useCallback, useState } from "react";
import { searchInstruments } from "../../data/module2MarketApi";
import type { InstrumentSearchResult } from "../../data/module2LiveTypes";

/**
 * Instrument search (Phase 13, Step 4). Imperative `search()` rather than a
 * react-query-on-every-keystroke hook — search is user-triggered, not a
 * stable cacheable key.
 */
export const useInstrumentSearch = () => {
  const [results, setResults] = useState<InstrumentSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (symbol: string) => {
    const trimmed = symbol.trim();
    if (!trimmed) {
      setResults([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await searchInstruments(trimmed);
      setResults(data.results || []);
    } catch (err: any) {
      setError(err?.message || "Instrument search failed.");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setResults([]);
    setError(null);
  }, []);

  return { results, loading, error, search, clear };
};
