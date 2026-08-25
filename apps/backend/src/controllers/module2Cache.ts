import { Request, Response } from "express";
import { getAll, getByInstrumentId, getCacheStats, clearCache } from "../services/marketDataCacheService";

/**
 * GET /module2/cache
 */
export const module2GetCache = (_req: Request, res: Response) => {
  const entries = getAll();
  return res.status(200).json({ count: entries.length, entries });
};

/**
 * GET /module2/cache/:instrumentId
 */
export const module2GetCacheEntry = (req: Request, res: Response) => {
  const { instrumentId } = req.params;
  const entry = getByInstrumentId(instrumentId);
  if (!entry) {
    return res.status(404).json({ error: `No cached tick for instrument "${instrumentId}".` });
  }
  return res.status(200).json(entry);
};

/**
 * GET /module2/cache/stats
 */
export const module2GetCacheStats = (_req: Request, res: Response) => {
  return res.status(200).json(getCacheStats());
};

/**
 * DELETE /module2/cache
 */
export const module2ClearCache = (_req: Request, res: Response) => {
  clearCache();
  return res.status(200).json({ ok: true });
};
