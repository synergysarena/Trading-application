import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSubscriptions,
  subscribe as subscribeApi,
  unsubscribe as unsubscribeApi,
  ResolveInstrumentParams,
} from "../../data/module2MarketApi";
import { marketSocketClient } from "../../services/module2MarketSocket";
import type { MarketSubscriptionPayload, SubscriptionRecord } from "../../data/module2LiveTypes";

/**
 * Subscription list + subscribe/unsubscribe (Phase 13, Step 4/6/10).
 *
 * Joins the session's socket room so a `market:subscription` event (e.g. the
 * backend resyncing on a broker reconnect, or another tab unsubscribing)
 * invalidates the list and refetches — the UI never needs to poll.
 */
export const useSubscriptions = (sessionId: string | null) => {
  const queryClient = useQueryClient();
  const queryKey = ["module2-live-subscriptions", sessionId];

  const query = useQuery({
    queryKey,
    queryFn: () => getSubscriptions(sessionId as string),
    enabled: !!sessionId,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!sessionId) return;
    marketSocketClient.joinRoom("session", sessionId);
    return () => marketSocketClient.leaveRoom("session", sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const handler = (_payload: MarketSubscriptionPayload) => {
      queryClient.invalidateQueries({ queryKey });
    };
    marketSocketClient.on("market:subscription", handler);
    return () => marketSocketClient.off("market:subscription", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, queryClient]);

  const subscribeMutation = useMutation({
    mutationFn: (params: ResolveInstrumentParams) => {
      if (!sessionId) throw new Error("No active tracking session yet.");
      return subscribeApi({ ...params, sessionId });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const unsubscribeMutation = useMutation({
    mutationFn: (subscriptionId: string) => {
      if (!sessionId) throw new Error("No active tracking session yet.");
      return unsubscribeApi(sessionId, subscriptionId);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return {
    subscriptions: (query.data?.subscriptions || []) as SubscriptionRecord[],
    loading: query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    subscribe: subscribeMutation.mutateAsync,
    subscribing: subscribeMutation.isPending,
    subscribeError: subscribeMutation.error ? (subscribeMutation.error as Error).message : null,
    unsubscribe: unsubscribeMutation.mutateAsync,
    unsubscribing: unsubscribeMutation.isPending,
  };
};
