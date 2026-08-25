import { Request, Response } from "express";
import {
  loginMarketData,
  logoutMarketData,
  getMarketDataAuthHealth,
} from "../services/marketDataSessionService";

/**
 * POST /module2/auth/login
 * Authenticates against the Symphony XTS Market Data API. Credentials may be
 * supplied in the body ({ appKey, secretKey }); otherwise the configured
 * MOD2_API_KEY / MOD2_API_SECRET are used.
 */
export const module2AuthLogin = async (req: Request, res: Response) => {
  try {
    const { appKey, secretKey } = (req.body || {}) as { appKey?: string; secretKey?: string };

    if ((appKey && typeof appKey !== "string") || (secretKey && typeof secretKey !== "string")) {
      return res.status(400).json({ error: "appKey and secretKey must be strings when provided." });
    }

    const result = await loginMarketData(appKey, secretKey);

    if (result.ok) {
      return res.status(200).json({
        authenticated: true,
        userID: result.userID,
        expiresAt: result.expiresAt,
      });
    }

    // Map failure category to an appropriate HTTP status.
    const httpCode =
      result.status === "WAITING_FOR_CONFIGURATION" ? 503
      : result.httpStatus ? 401
      : 502; // no upstream response at all → gateway problem (network/timeout)

    return res.status(httpCode).json({
      authenticated: false,
      status: result.status,
      error: result.error,
      upstreamStatus: result.httpStatus,
    });
  } catch (error: any) {
    console.error("[Module2Auth] Login endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * POST /module2/auth/logout
 * Ends the Market Data session (best-effort remote invalidation, always clears
 * the local session).
 */
export const module2AuthLogout = async (_req: Request, res: Response) => {
  try {
    const result = await logoutMarketData();
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("[Module2Auth] Logout endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /module2/auth/status
 * Reports the current Market Data session state without exposing the token.
 */
export const module2AuthStatus = (_req: Request, res: Response) => {
  return res.status(200).json(getMarketDataAuthHealth());
};
