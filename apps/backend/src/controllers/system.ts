import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { shutdownAllMarketData } from "../services/systemService";

/**
 * POST /api/system/market-data/shutdown
 * Dedicated user manual global shutdown endpoint for all market data pipelines.
 * Accessible from ANY authenticated tab without session blockage.
 */
export const shutdownMarketDataEndpoint = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id || "unknown";
    const socketId = (req.headers["x-socket-id"] as string) || undefined;
    const result = await shutdownAllMarketData(userId, socketId);
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("[System/MarketData] Shutdown endpoint error:", error);
    return res.status(500).json({ error: "Failed to shut down market data feeds", details: error?.message });
  }
};
