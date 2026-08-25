import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../store/useStore";
import { marketSocketClient } from "../../services/module2MarketSocket";
import type { MarketConnectionPayload } from "../../data/module2LiveTypes";

export type SocketConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * Owns the Market Data socket's connect/disconnect lifecycle (Phase 13, Step 3/9).
 * Call this ONCE near the root of the new Module 2 Live screen — every other
 * hook here (useMarketData, useCandles, useSubscriptions) assumes the
 * connection this hook establishes already exists, exactly like the existing
 * useSocket() is called once in ModuleDashboardLayout and everything else
 * assumes it.
 *
 * Exposes two distinct connection concepts:
 *  - `status`: THIS BROWSER TAB's Socket.IO connection to the backend.
 *  - `brokerStatus`: the BACKEND's connection to the AETRAM broker (from the
 *    `market:connection` event) — what Step 9 actually means by
 *    "Connected / Connecting / Disconnected / Reconnecting".
 */
export const useMarketSocket = () => {
  const accessToken = useStore((s) => s.accessToken);
  const [status, setStatus] = useState<SocketConnectionStatus>("disconnected");
  const [brokerStatus, setBrokerStatus] = useState<MarketConnectionPayload | null>(null);

  useEffect(() => {
    if (!accessToken) {
      marketSocketClient.disconnect();
      setStatus("disconnected");
      return;
    }

    setStatus(marketSocketClient.isConnected() ? "connected" : "connecting");
    marketSocketClient.connect(accessToken);

    const handleConnect = () => setStatus("connected");
    const handleDisconnect = () => setStatus("disconnected");
    const handleConnectError = () => setStatus("disconnected");
    const handleBrokerConnection = (payload: MarketConnectionPayload) => setBrokerStatus(payload);

    marketSocketClient.on("connect", handleConnect);
    marketSocketClient.on("disconnect", handleDisconnect);
    marketSocketClient.on("connect_error", handleConnectError);
    marketSocketClient.on("market:connection", handleBrokerConnection);

    return () => {
      marketSocketClient.off("connect", handleConnect);
      marketSocketClient.off("disconnect", handleDisconnect);
      marketSocketClient.off("connect_error", handleConnectError);
      marketSocketClient.off("market:connection", handleBrokerConnection);
      marketSocketClient.disconnect();
    };
  }, [accessToken]);

  const reconnect = useCallback(() => {
    setStatus("connecting");
    marketSocketClient.reconnect();
  }, []);

  return { status, brokerStatus, reconnect };
};
