import { Request, Response } from "express";
import { getRecentCandles, getLatestCandle, getHistoryStats, deleteInstrumentHistory } from "../services/candleHistoryService";

/**
 * GET /module2/history/:instrumentId?limit=50
 */
export const module2GetHistory = async (req: Request, res: Response) => {
  const { instrumentId } = req.params;
  const limit = Number(req.query.limit) || 50;

  try {
    const candles = await getRecentCandles(instrumentId, limit);
    return res.status(200).json({ instrumentId, count: candles.length, candles });
  } catch (error: any) {
    console.error("[Module2History] History endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /module2/history/:instrumentId/latest
 */
export const module2GetLatestHistoryCandle = async (req: Request, res: Response) => {
  const { instrumentId } = req.params;

  try {
    const candle = await getLatestCandle(instrumentId);
    if (!candle) {
      return res.status(404).json({ error: `No persisted candle history for instrument "${instrumentId}".` });
    }
    return res.status(200).json(candle);
  } catch (error: any) {
    console.error("[Module2History] Latest-candle endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /module2/history/stats
 */
export const module2GetHistoryStats = (_req: Request, res: Response) => {
  return res.status(200).json(getHistoryStats());
};

/**
 * DELETE /module2/history/:instrumentId
 */
export const module2DeleteHistory = async (req: Request, res: Response) => {
  const { instrumentId } = req.params;

  try {
    const deleted = await deleteInstrumentHistory(instrumentId);
    return res.status(200).json({ instrumentId, deleted });
  } catch (error: any) {
    console.error("[Module2History] Delete-history endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
