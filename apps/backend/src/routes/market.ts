import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  getWatchlist,
  updateWatchlist,
  getSpotPrice,
  getFuturesData,
  getOHLCBars,
  getHistoricalOHLCBars,
  getWarmupOHLCBars,
  getPivotLevelsEndpoint,
  getIndicatorsEndpoint,
  getModule1LatestOi,
  getOptionChain,
  updateCustomTimeframe,
  getMarketStatus,
  getModuleStatus,
  getModule1Expiries,
  getModule1Strikes,
  getModule1Exchanges,
  getModule1Instruments,
  getModule1Symbols,
} from "../controllers/market";

const router = Router();

// Watchlist routes
router.get("/watchlist", authenticate, getWatchlist);
router.put("/watchlist", authenticate, updateWatchlist);

// Market pricing & data routes
router.get("/market/spot/:symbol", authenticate, getSpotPrice);
router.get("/market/futures/:symbol", authenticate, getFuturesData);
router.get("/market/ohlc/:symbol/:tf", authenticate, getOHLCBars);
router.get("/market/ohlc-history/:symbol/:tf", authenticate, getHistoricalOHLCBars);
router.get("/market/ohlc-warmup/:symbol/:tf", authenticate, getWarmupOHLCBars);
router.get("/market/pivots/:symbol/:tf", authenticate, getPivotLevelsEndpoint);
router.get("/market/option-chain/:index", authenticate, getOptionChain);
router.post("/market/custom-timeframe", authenticate, updateCustomTimeframe);
router.get("/market/status", authenticate, getMarketStatus);
router.get("/module/status", authenticate, getModuleStatus);

// Module 1 Indicators
router.get("/module1/indicators/:symbol", authenticate, getIndicatorsEndpoint);
router.get("/module1/latest-oi", getModule1LatestOi);

// Module 1 dropdown discovery: Exchange → Instrument → Symbol → Expiry → Strike
// (real broker instrument-master data; each is filtered by the levels above it,
// via query params — no endpoint assumes a particular exchange/instrument)
router.get("/module1/exchanges", authenticate, getModule1Exchanges);
router.get("/module1/instruments", authenticate, getModule1Instruments);
router.get("/module1/symbols", authenticate, getModule1Symbols);
router.get("/module1/expiries", authenticate, getModule1Expiries);
router.get("/module1/strikes", authenticate, getModule1Strikes);

export default router;
