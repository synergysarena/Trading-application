import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { shutdownMarketDataEndpoint } from "../controllers/system";

const router = Router();

// POST /api/system/market-data/shutdown
router.post("/system/market-data/shutdown", authenticate, shutdownMarketDataEndpoint);

export default router;
