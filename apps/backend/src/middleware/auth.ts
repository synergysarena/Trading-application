import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/token";
import redis from "../config/redis";

// Custom request interface to append authenticated user context
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
  };
}

// ── In-memory blacklist cache ─────────────────────────────────────────────────
// The old middleware issued one Redis GET per authenticated request — thousands
// of commands/day spent re-asking the same answer for the same token. This is a
// single-instance deployment: logout happens in THIS process, so the local map
// is authoritative for tokens revoked during this process's lifetime. Redis is
// consulted at most ONCE per unique token per process (covers tokens revoked
// before a restart); the durable blacklist:<token> SETEX in logout is unchanged.

const revokedTokens = new Map<string, number>(); // token → revoked-until (ms)
const clearedTokens = new Set<string>();         // tokens confirmed not blacklisted

const REVOKED_CACHE_MAX_MS = 24 * 60 * 60 * 1000;

const pruneCaches = () => {
  if (revokedTokens.size > 1000) {
    const now = Date.now();
    for (const [t, exp] of revokedTokens) {
      if (exp <= now) revokedTokens.delete(t);
    }
  }
  // Bounded negative cache — worst case a cleared token is re-verified once.
  if (clearedTokens.size > 5000) clearedTokens.clear();
};

/** Called by the logout controller so revocation takes effect in-process
 *  immediately, without any per-request Redis reads. */
export const markTokenRevoked = (token: string, ttlSeconds: number) => {
  revokedTokens.set(token, Date.now() + Math.min(ttlSeconds * 1000, REVOKED_CACHE_MAX_MS));
  clearedTokens.delete(token);
  pruneCaches();
};

export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access denied. No token provided." });
    }

    const token = authHeader.split(" ")[1];

    // 1. Local revocation cache (no Redis command)
    const revokedUntil = revokedTokens.get(token);
    if (revokedUntil !== undefined) {
      if (Date.now() < revokedUntil) {
        return res.status(401).json({ error: "Session revoked. Please log in again." });
      }
      revokedTokens.delete(token);
    }

    // 2. First sighting of this token in this process: one durable-blacklist
    //    check against Redis, then cache the verdict either way.
    if (!clearedTokens.has(token)) {
      let isBlacklisted = null;
      try {
        isBlacklisted = await redis.get(`blacklist:${token}`);
      } catch (err) {
        if (process.env.NODE_ENV === "production") {
          throw err;
        }
        console.warn("[Auth Middleware] Failed to check token blacklist in Redis (Redis may be offline). Proceeding without blacklist check.");
      }
      if (isBlacklisted) {
        revokedTokens.set(token, Date.now() + REVOKED_CACHE_MAX_MS);
        return res.status(401).json({ error: "Session revoked. Please log in again." });
      }
      clearedTokens.add(token);
      pruneCaches();
    }

    const decoded = verifyAccessToken(token);
    req.user = { id: decoded.userId };
    next();
  } catch (error: any) {
    console.error("[Auth Middleware Error]:", error?.message || error);
    return res.status(401).json({ error: "Invalid or expired access token.", detail: error?.message });
  }
};
