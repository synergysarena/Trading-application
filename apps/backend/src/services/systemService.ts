import { stopDataFeed, clearPersistedBrokerSession } from "./dataFeed";
import { disconnect as disconnectModule2WS } from "./marketDataWebSocketService";
import { broadcastBrokerStatus, broadcastGlobalShutdown } from "./socketService";
import { clearActiveCandles } from "./ohlcAggregator";
import { clearAllModule1Sessions } from "./module1SessionService";
import {
  disableMarketDataProcessing,
  setMarketDataLifecycleState,
  getMarketDataLifecycleState,
} from "./marketDataLifecycle";

export interface GlobalShutdownResult {
  success: boolean;
  status?: string;
  message: string;
}

let isShutdownInProgress = false;

/**
 * Explicit global shutdown service for all market data pipelines.
 * Callable from ANY authenticated user tab.
 * Stops Module 1 (Zebu) and Module 2 (Aetram/XTS) live market-data feeds,
 * halts all background calculations, clears all module sessions,
 * and broadcasts GLOBAL_SHUTDOWN to every connected TradePro tab.
 */
export const shutdownAllMarketData = async (
  userId: string,
  _requestingSocketId?: string
): Promise<GlobalShutdownResult> => {
  // Idempotency check: if already stopped or in progress
  if (isShutdownInProgress) {
    console.log(`[System/MarketData] Shutdown already in progress, returning idempotent response for user=${userId}`);
    return {
      success: true,
      status: "already_stopped",
      message: "Market data shutdown is already in progress.",
    };
  }

  isShutdownInProgress = true;
  setMarketDataLifecycleState("SHUTTING_DOWN");

  console.log(`[System/MarketData] GLOBAL_SHUTDOWN_REQUESTED user=${userId}`);

  try {
    // 1. Immediately disable background processing and increment epoch generation
    disableMarketDataProcessing();

    // 2. Module 1 Shutdown
    console.log("[System/MarketData] Module1 shutdown requested");
    stopDataFeed(true);
    broadcastBrokerStatus("broker-disconnected", "Global market-data shutdown", "module1");
    console.log("[System/MarketData] Module1 stopped");

    // 3. Module 2 Shutdown
    console.log("[System/MarketData] Module2 shutdown requested");
    disconnectModule2WS();
    broadcastBrokerStatus("broker-disconnected", "Global market-data shutdown", "module2");
    console.log("[System/MarketData] Module2 stopped");

    // 4. Stop Live Background Processing
    clearActiveCandles();
    console.log("[System/MarketData] Background market-data processing stopped");

    // 5. Clear Active Module Sessions & Persisted Session
    clearPersistedBrokerSession();
    clearAllModule1Sessions();
    console.log("[System/MarketData] Active module sessions cleared");

    // 6. Broadcast GLOBAL_SHUTDOWN to every connected client tab
    broadcastGlobalShutdown("Global market-data shutdown");

    setMarketDataLifecycleState("STOPPED");
    console.log("[System/MarketData] GLOBAL_SHUTDOWN_COMPLETED");

    return {
      success: true,
      message: "All market data has been shut down.",
    };
  } catch (err: any) {
    console.error("[System/MarketData] GLOBAL_SHUTDOWN_FAILED:", err?.message || err);
    throw err;
  } finally {
    isShutdownInProgress = false;
  }
};
