import { useQuery } from "@tanstack/react-query";
import { getExpiryDates } from "../../data/module2MarketApi";

/**
 * Expiry dates (Phase 13, Step 4) — react-query, matching this codebase's
 * existing convention (see Module2.tsx's expiries query).
 */
export const useExpiryDates = (symbol: string | null) => {
  const query = useQuery({
    queryKey: ["module2-live-expiry", symbol],
    queryFn: () => getExpiryDates(symbol as string),
    enabled: !!symbol,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  return {
    expiries: query.data?.expiries || [],
    loading: query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refetch: query.refetch,
  };
};
