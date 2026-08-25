import { Request, Response } from "express";
import {
  subscribe,
  bulkSubscribe,
  unsubscribe,
  bulkUnsubscribe,
  getSubscriptions,
  SubscriptionRejectCode,
  SubscriptionRequest,
} from "../services/subscriptionService";

const REJECT_CODE_HTTP_STATUS: Record<SubscriptionRejectCode, number> = {
  INVALID_SESSION: 404,
  MISSING_AUTH: 401,
  DUPLICATE: 409,
  LIMIT_EXCEEDED: 409,
  INVALID_INSTRUMENT: 422,
  NOT_FOUND: 404,
};

const isValidSubscriptionRequest = (r: any): r is SubscriptionRequest =>
  !!r && typeof r.exchange === "string" && typeof r.instrument === "string" &&
  typeof r.expiry === "string" && typeof r.optionType === "string" &&
  (typeof r.strike === "number" || typeof r.strike === "string") && Number.isFinite(Number(r.strike));

const normalizeRequest = (r: any): SubscriptionRequest => ({
  exchange: String(r.exchange),
  instrument: String(r.instrument),
  expiry: String(r.expiry),
  strike: Number(r.strike),
  optionType: String(r.optionType),
});

/**
 * POST /module2/subscriptions
 * Body: { sessionId, exchange, instrument, expiry, strike, optionType }
 */
export const module2Subscribe = async (req: Request, res: Response) => {
  const { sessionId, ...rest } = req.body || {};

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required." });
  }
  if (!isValidSubscriptionRequest(rest)) {
    return res.status(400).json({ error: "exchange, instrument, expiry, strike, and optionType are all required." });
  }

  try {
    const result = await subscribe(sessionId, normalizeRequest(rest));
    if (!result.ok) {
      return res.status(REJECT_CODE_HTTP_STATUS[result.code!] || 422).json(result);
    }
    return res.status(201).json(result);
  } catch (error: any) {
    console.error("[Module2Subscriptions] Subscribe endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * POST /module2/subscriptions/bulk
 * Body: { sessionId, instruments: [{ exchange, instrument, expiry, strike, optionType }, ...] }
 */
export const module2BulkSubscribe = async (req: Request, res: Response) => {
  const { sessionId, instruments } = (req.body || {}) as { sessionId?: string; instruments?: any[] };

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required." });
  }
  if (!Array.isArray(instruments) || instruments.length === 0) {
    return res.status(400).json({ error: "instruments must be a non-empty array." });
  }
  const invalidIndex = instruments.findIndex((r) => !isValidSubscriptionRequest(r));
  if (invalidIndex !== -1) {
    return res.status(400).json({ error: `instruments[${invalidIndex}] is missing exchange/instrument/expiry/strike/optionType.` });
  }

  try {
    const result = await bulkSubscribe(sessionId, instruments.map(normalizeRequest));
    if ("code" in result) {
      return res.status(REJECT_CODE_HTTP_STATUS[result.code!] || 422).json(result);
    }
    return res.status(207).json(result);
  } catch (error: any) {
    console.error("[Module2Subscriptions] Bulk subscribe endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * DELETE /module2/subscriptions
 * Body: { sessionId, subscriptionId } for a single removal, or
 *       { sessionId, subscriptionIds: string[] } for bulk removal.
 */
export const module2Unsubscribe = async (req: Request, res: Response) => {
  const { sessionId, subscriptionId, subscriptionIds } = (req.body || {}) as {
    sessionId?: string;
    subscriptionId?: string;
    subscriptionIds?: string[];
  };

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required." });
  }

  try {
    if (Array.isArray(subscriptionIds)) {
      if (subscriptionIds.length === 0) {
        return res.status(400).json({ error: "subscriptionIds must be a non-empty array." });
      }
      const result = bulkUnsubscribe(sessionId, subscriptionIds);
      return res.status(207).json(result);
    }

    if (!subscriptionId || typeof subscriptionId !== "string") {
      return res.status(400).json({ error: "subscriptionId (or subscriptionIds[]) is required." });
    }

    const result = unsubscribe(sessionId, subscriptionId);
    if (!result.ok) {
      return res.status(REJECT_CODE_HTTP_STATUS[result.code!] || 404).json(result);
    }
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("[Module2Subscriptions] Unsubscribe endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /module2/subscriptions?sessionId=...&status=ACTIVE|REMOVED
 */
export const module2GetSubscriptions = (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string || "").trim();
  const status = (req.query.status as string || "").trim().toUpperCase();

  if (!sessionId) {
    return res.status(400).json({ error: "Query parameter 'sessionId' is required." });
  }
  if (status && status !== "ACTIVE" && status !== "REMOVED") {
    return res.status(400).json({ error: "status must be ACTIVE or REMOVED." });
  }

  try {
    const subscriptions = getSubscriptions(sessionId, status as "ACTIVE" | "REMOVED" | undefined);
    return res.status(200).json({ sessionId, count: subscriptions.length, subscriptions });
  } catch (error: any) {
    console.error("[Module2Subscriptions] Get subscriptions endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
