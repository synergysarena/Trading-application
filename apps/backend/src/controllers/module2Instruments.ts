import { Request, Response } from "express";
import { searchInstrument, getExpiryDates, resolveStrikeToken } from "../services/instrumentService";

/**
 * GET /module2/instruments/search?symbol=NIFTY
 */
export const module2SearchInstruments = async (req: Request, res: Response) => {
  const symbol = ((req.query.symbol as string) || "").trim();
  if (!symbol) {
    return res.status(400).json({ error: "Query parameter 'symbol' is required." });
  }

  try {
    const results = await searchInstrument(symbol);
    return res.status(200).json({ symbol, results });
  } catch (error: any) {
    console.error("[Module2Instruments] Search endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /module2/instruments/expiry?symbol=NIFTY
 */
export const module2GetExpiry = async (req: Request, res: Response) => {
  const symbol = ((req.query.symbol as string) || "").trim();
  if (!symbol) {
    return res.status(400).json({ error: "Query parameter 'symbol' is required." });
  }

  try {
    const result = await getExpiryDates(symbol);
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("[Module2Instruments] Expiry endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * POST /module2/instruments/resolve
 * Body: { exchange, instrument, expiry, strike, optionType }
 */
export const module2ResolveInstrument = async (req: Request, res: Response) => {
  const { exchange, instrument, expiry, strike, optionType } = (req.body || {}) as {
    exchange?: string;
    instrument?: string;
    expiry?: string;
    strike?: number | string;
    optionType?: string;
  };

  if (!exchange || !instrument || !expiry || strike === undefined || strike === null || !optionType) {
    return res.status(400).json({
      error: "exchange, instrument, expiry, strike, and optionType are all required.",
    });
  }

  const strikeNum = Number(strike);
  if (!Number.isFinite(strikeNum)) {
    return res.status(400).json({ error: "strike must be a number." });
  }

  try {
    const result = await resolveStrikeToken({
      exchange: String(exchange),
      instrument: String(instrument),
      expiry: String(expiry),
      strike: strikeNum,
      optionType: String(optionType),
    });

    if (!result.valid) {
      return res.status(422).json(result);
    }
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("[Module2Instruments] Resolve endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
