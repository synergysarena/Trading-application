import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getModule2Status, getModule2Expiries, getModule2Indexes, getModule2OptionChain } from "../controllers/module2";
import { module2AuthLogin, module2AuthLogout, module2AuthStatus } from "../controllers/module2Auth";
import { module2SearchInstruments, module2GetExpiry, module2ResolveInstrument } from "../controllers/module2Instruments";
import {
  module2Subscribe,
  module2BulkSubscribe,
  module2Unsubscribe,
  module2GetSubscriptions,
} from "../controllers/module2Subscriptions";
import {
  module2WsConnect,
  module2WsDisconnect,
  module2WsReconnect,
  module2WsStatus,
} from "../controllers/module2WebSocket";
import {
  module2GetCache,
  module2GetCacheEntry,
  module2GetCacheStats,
  module2ClearCache,
} from "../controllers/module2Cache";
import {
  module2GetCurrentCandles,
  module2GetCandleForInstrument,
  module2GetCandleStats,
  module2ClearCandles,
} from "../controllers/module2Candles";
import {
  module2GetHistory,
  module2GetLatestHistoryCandle,
  module2GetHistoryStats,
  module2DeleteHistory,
} from "../controllers/module2History";
import {
  module2GetArchive,
  module2GetLatestArchivedCandle,
  module2GetArchiveRange,
  module2GetArchiveStats,
  module2DeleteArchive,
} from "../controllers/module2Archive";
import { module2GetSocketStats, module2GetSocketClients } from "../controllers/module2Socket";

const router = Router();

// Same policy as routes/auth.ts — credential endpoints are brute-force targets.
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: "Too many authentication requests. Please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/status", getModule2Status);
router.get("/indexes", getModule2Indexes);
router.get("/expiries", getModule2Expiries);
router.get("/option-chain", getModule2OptionChain);

import { runAetramDiagnostics } from "../scripts/diagnosticAetramConnectivity";

// Market Data authentication & session management
router.post("/auth/login",  authRateLimiter, module2AuthLogin);
router.post("/auth/logout", authRateLimiter, module2AuthLogout);
router.get("/auth/status",  module2AuthStatus);

// Safe network diagnostics for Render / Production
router.get("/diagnostics/network", async (_req, res) => {
  try {
    const report = await runAetramDiagnostics();
    return res.status(200).json(report);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to run diagnostics" });
  }
});

// Instrument Discovery layer (Phase 3)
router.get("/instruments/search",   module2SearchInstruments);
router.get("/instruments/expiry",   module2GetExpiry);
router.post("/instruments/resolve", module2ResolveInstrument);

// Subscription Management layer (Phase 4)
router.post("/subscriptions",      module2Subscribe);
router.post("/subscriptions/bulk", module2BulkSubscribe);
router.delete("/subscriptions",    module2Unsubscribe);
router.get("/subscriptions",       module2GetSubscriptions);

// WebSocket Connection Manager (Phase 5)
router.post("/ws/connect",    module2WsConnect);
router.post("/ws/disconnect", module2WsDisconnect);
router.post("/ws/reconnect",  module2WsReconnect);
router.get("/ws/status",      module2WsStatus);

// Market Data Cache layer (Phase 8)
// /cache/stats is registered before /cache/:instrumentId so "stats" is never
// swallowed as an instrument ID by the param route.
router.get("/cache/stats",        module2GetCacheStats);
router.get("/cache/:instrumentId", module2GetCacheEntry);
router.get("/cache",              module2GetCache);
router.delete("/cache",           module2ClearCache);

// Minute Aggregation Engine (Phase 9)
// /candles/current and /candles/stats are registered before /candles/:instrumentId
// for the same reason as the cache routes above.
router.get("/candles/current",       module2GetCurrentCandles);
router.get("/candles/stats",         module2GetCandleStats);
router.get("/candles/:instrumentId", module2GetCandleForInstrument);
router.delete("/candles",            module2ClearCandles);

// Redis Persistence Layer (Phase 10)
// /history/stats is registered before /history/:instrumentId for the same
// reason as the cache/candle routes above; /history/:instrumentId/latest has
// an extra path segment so it never collides with either.
router.get("/history/stats",                 module2GetHistoryStats);
router.get("/history/:instrumentId/latest",  module2GetLatestHistoryCandle);
router.get("/history/:instrumentId",         module2GetHistory);
router.delete("/history/:instrumentId",      module2DeleteHistory);

// MongoDB Historical Storage (Phase 11)
// /archive/stats is registered before /archive/:instrumentId for the same
// reason as the routes above; /archive/:instrumentId/latest and
// /archive/:instrumentId/range each have an extra path segment so neither
// collides with the single-segment routes.
router.get("/archive/stats",                module2GetArchiveStats);
router.get("/archive/:instrumentId/latest", module2GetLatestArchivedCandle);
router.get("/archive/:instrumentId/range",  module2GetArchiveRange);
router.get("/archive/:instrumentId",        module2GetArchive);
router.delete("/archive/:instrumentId",     module2DeleteArchive);

// Socket.IO Broadcast Layer (Phase 12)
router.get("/socket/stats",   module2GetSocketStats);
router.get("/socket/clients", module2GetSocketClients);

export default router;
