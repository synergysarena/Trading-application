import { Request, Response } from "express";
import {
  getArchivedCandles,
  getLatestArchivedCandle,
  getArchivedCandleRange,
  getArchiveStats,
  deleteArchivedHistory,
} from "../services/candleArchiveService";

/**
 * GET /module2/archive/:instrumentId?limit=50
 */
export const module2GetArchive = async (req: Request, res: Response) => {
  const { instrumentId } = req.params;
  const limit = Number(req.query.limit) || 50;

  try {
    const candles = await getArchivedCandles(instrumentId, limit);
    return res.status(200).json({ instrumentId, count: candles.length, candles });
  } catch (error: any) {
    console.error("[Module2Archive] Archive endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /module2/archive/:instrumentId/latest
 */
export const module2GetLatestArchivedCandle = async (req: Request, res: Response) => {
  const { instrumentId } = req.params;

  try {
    const candle = await getLatestArchivedCandle(instrumentId);
    if (!candle) {
      return res.status(404).json({ error: `No archived candle for instrument "${instrumentId}".` });
    }
    return res.status(200).json(candle);
  } catch (error: any) {
    console.error("[Module2Archive] Latest-archive endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /module2/archive/:instrumentId/range?from=ISO&to=ISO
 */
export const module2GetArchiveRange = async (req: Request, res: Response) => {
  const { instrumentId } = req.params;
  const { from, to } = req.query as { from?: string; to?: string };

  if (!from || !to) {
    return res.status(400).json({ error: "Query parameters 'from' and 'to' (ISO date strings) are required." });
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return res.status(400).json({ error: "'from' and 'to' must be valid ISO date strings." });
  }

  try {
    const candles = await getArchivedCandleRange(instrumentId, fromDate, toDate);
    return res.status(200).json({
      instrumentId,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      count: candles.length,
      candles,
    });
  } catch (error: any) {
    console.error("[Module2Archive] Range endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /module2/archive/stats
 */
export const module2GetArchiveStats = async (_req: Request, res: Response) => {
  try {
    const stats = await getArchiveStats();
    return res.status(200).json(stats);
  } catch (error: any) {
    console.error("[Module2Archive] Stats endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * DELETE /module2/archive/:instrumentId
 */
export const module2DeleteArchive = async (req: Request, res: Response) => {
  const { instrumentId } = req.params;

  try {
    const deletedCount = await deleteArchivedHistory(instrumentId);
    return res.status(200).json({ instrumentId, deletedCount });
  } catch (error: any) {
    console.error("[Module2Archive] Delete-archive endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
