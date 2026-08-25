import { Request, Response } from "express";
import { getCurrentCandles, getCandleForInstrument, getCandleStats, clearCandles } from "../services/minuteAggregationService";

/**
 * GET /module2/candles/current
 */
export const module2GetCurrentCandles = (_req: Request, res: Response) => {
  const candles = getCurrentCandles();
  return res.status(200).json({ count: candles.length, candles });
};

/**
 * GET /module2/candles/stats
 */
export const module2GetCandleStats = (_req: Request, res: Response) => {
  return res.status(200).json(getCandleStats());
};

/**
 * GET /module2/candles/:instrumentId
 */
export const module2GetCandleForInstrument = (req: Request, res: Response) => {
  const { instrumentId } = req.params;
  const candle = getCandleForInstrument(instrumentId);
  if (!candle) {
    return res.status(404).json({ error: `No candle data for instrument "${instrumentId}".` });
  }
  return res.status(200).json(candle);
};

/**
 * DELETE /module2/candles
 */
export const module2ClearCandles = (_req: Request, res: Response) => {
  clearCandles();
  return res.status(200).json({ ok: true });
};
