import { Router } from "express";
import { authenticate, requireMarketDataShutdownAdmin } from "../middleware/auth";
import { shutdownMarketDataEndpoint } from "../controllers/system";

const router = Router();

// POST /api/system/market-data/shutdown
// Global — stops Module 1 AND Module 2 for every connected user — so this is
// gated to an ops-configured admin allowlist (MARKET_DATA_SHUTDOWN_ADMIN_USERNAMES),
// not just "any authenticated application user".
router.post("/system/market-data/shutdown", authenticate, requireMarketDataShutdownAdmin, shutdownMarketDataEndpoint);

export default router;
