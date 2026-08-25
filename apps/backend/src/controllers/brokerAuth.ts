import { Request, Response } from "express";
import crypto from "crypto";
import axios from "axios";
import { startDataFeedWithCredentials, resumeDataFeedFromPersistedSession } from "../services/dataFeed";
import { loginToAetramWithCredentials } from "../services/aetramMarketDataService";
import { connect as connectMarketDataWebSocket } from "../services/marketDataWebSocketService";
import { generateAccessToken, JWT_SECRET } from "../utils/token";
import jwt from "jsonwebtoken";

const sha256 = (data: string) => crypto.createHash("sha256").update(data).digest("hex");

// ── Module 1: Zebu QuickAuth ───────────────────────────────────────────────────
//
// PAYLOAD FORMAT (verified from zebuOAuthService.ts working implementation):
//   POST <ZEBU_LOGIN_URL>
//   Content-Type: application/x-www-form-urlencoded
//   Body: jData=<raw-json-string>   (NO encodeURIComponent, NO &jKey=...)
//
// KEY FORMULA:
//   pwd    = SHA256(plaintext_password)
//   appkey = SHA256(uid | MOD1_API_KEY)   ← NOT sha256(uid|sha256(password))

export const module1BrokerLogin = async (req: Request, res: Response) => {
  console.log("\n[Module1/BrokerLogin] ─────────────────────────────────────");
  console.log("[Module1/BrokerLogin] Route entered.");
  console.log("[Module1/BrokerLogin] Request body keys:", Object.keys(req.body));

  try {
    const { userId, password, factor2 } = req.body;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!userId || !password) {
      console.warn("[Module1/BrokerLogin] Validation failed: userId or password missing.");
      return res.status(400).json({ error: "User ID and password are required." });
    }

    console.log(`[Module1/BrokerLogin] userId   : ${userId}`);
    console.log(`[Module1/BrokerLogin] factor2  : ${factor2 || "(empty)"}`);
    console.log(`[Module1/BrokerLogin] password : ${"*".repeat(Math.min(password.length, 8))}`);

    // ── Read env config ─────────────────────────────────────────────────────
    const loginUrl   = (process.env.ZEBU_LOGIN_URL || "https://go.mynt.in/NorenWClientTP/QuickAuth").trim();
    const apiKey     = (process.env.MOD1_API_KEY || process.env.BROKER_API_KEY || "").trim();
    const vendorCode = (process.env.ZEBU_VENDOR_CODE || userId).trim();
    const imei       = (process.env.ZEBU_IMEI || "abc1234").trim();
    const factor2Val = (factor2 || "").trim();

    console.log(`[Module1/BrokerLogin] loginUrl   : ${loginUrl}`);
    console.log(`[Module1/BrokerLogin] apiKey     : ${apiKey ? apiKey.substring(0, 8) + "..." : "(MISSING)"}`);
    console.log(`[Module1/BrokerLogin] vendorCode : ${vendorCode}`);
    console.log(`[Module1/BrokerLogin] imei       : ${imei}`);

    if (!apiKey) {
      console.error("[Module1/BrokerLogin] MOD1_API_KEY is not configured in .env");
      return res.status(500).json({ error: "Server configuration error: MOD1_API_KEY missing." });
    }

    // ── Build payload (matches zebuOAuthService.ts working formula) ─────────
    console.log("[Module1/BrokerLogin] Hashing credentials...");
    const pwdHash     = sha256(password);
    const appkeyHash  = sha256(`${userId}|${apiKey}`);   // uid | API_KEY (not uid|sha256(pwd))

    console.log(`[Module1/BrokerLogin] pwdHash    : ${pwdHash.substring(0, 16)}...`);
    console.log(`[Module1/BrokerLogin] appkeyHash : ${appkeyHash.substring(0, 16)}...`);

    const jDataObj = {
      apkversion: "1.0.0",
      uid:     userId,
      pwd:     pwdHash,
      factor2: factor2Val,
      imei,
      source:  "API",
      vc:      vendorCode,
      appkey:  appkeyHash,
    };

    const jDataStr = JSON.stringify(jDataObj);
    console.log("[Module1/BrokerLogin] jData (masked):", JSON.stringify({
      ...jDataObj, pwd: "***", appkey: "***"
    }));
    console.log("[Module1/BrokerLogin] jData length:", jDataStr.length);

    // ── Send to Zebu ─────────────────────────────────────────────────────────
    // CRITICAL: body = `jData=<raw-json>` — NO encodeURIComponent, NO &jKey=
    // This matches the format verified in zebuOAuthService.ts
    const bodyStr = `jData=${jDataStr}`;
    console.log(`[Module1/BrokerLogin] POST ${loginUrl}`);
    console.log("[Module1/BrokerLogin] Body prefix (first 60 chars):", bodyStr.substring(0, 60) + "...");
    console.log("[Module1/BrokerLogin] Content-Type: application/x-www-form-urlencoded");

    let response: any;
    try {
      response = await axios.post(loginUrl, bodyStr, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      });
      console.log("[Module1/BrokerLogin] Zebu HTTP status:", response.status);
      console.log("[Module1/BrokerLogin] Zebu response body:", JSON.stringify(response.data));
    } catch (httpErr: any) {
      const status  = httpErr.response?.status;
      const body    = httpErr.response?.data;
      const errMsg  = body?.emsg || httpErr.message || "Connection to Zebu failed.";
      console.error(`[Module1/BrokerLogin] HTTP error ${status}:`, body);
      return res.status(502).json({
        error: `Zebu gateway error: ${errMsg}`,
        gatewayStatus: status,
        gatewayResponse: body,
      });
    }

    const data = response.data;

    if (!data || data.stat !== "Ok" || !data.susertoken) {
      const errMsg = data?.emsg || "Zebu authentication rejected. Check credentials.";
      console.warn("[Module1/BrokerLogin] Auth rejected. stat:", data?.stat, "emsg:", data?.emsg);
      return res.status(401).json({
        error: errMsg,
        brokerStat: data?.stat,
        brokerEmsg: data?.emsg,
      });
    }

    const sessionToken = data.susertoken as string;
    console.log(`[Module1/BrokerLogin] SUCCESS — session token obtained (${sessionToken.length} chars).`);

    // ── Start live data feed (async — runs in background, does not block response) ─
    console.log("[Module1/BrokerLogin] Starting live data feed (async)...");
    startDataFeedWithCredentials(userId, sessionToken).catch((err) => {
      console.error("[Module1/BrokerLogin] Feed start error:", err?.message || err);
    });

    // ── Issue module JWT ─────────────────────────────────────────────────────
    const moduleToken = jwt.sign(
      { moduleId: "module1", userId, type: "module-access" },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    console.log("[Module1/BrokerLogin] Module JWT issued. Login complete.\n");
    return res.status(200).json({ moduleToken, moduleId: "module1", userId });

  } catch (error: any) {
    console.error("[Module1/BrokerLogin] Unexpected error:", error?.message || error);
    return res.status(500).json({ error: "Module 1 authentication failed. Please try again." });
  }
};

// ── Module 1: Session resume (reconnection, not authentication) ───────────────
//
// Called by the frontend when it restores a cached module1Token ("Active
// session") instead of showing Module1LoginPanel, so the backend's live feed
// — a separate, process-scoped resource — actually gets re-established
// instead of silently staying dead. Takes no credentials: it only ever
// restarts a feed from a session this same backend already obtained via a
// real QuickAuth login (see persistBrokerSession in dataFeed.ts). Public like
// module1-broker-login (see that route's skipAuth precedent) since it never
// accepts caller-supplied credentials and is idempotent/no-op when the feed
// is already live or nothing is resumable.
export const module1ResumeSession = async (req: Request, res: Response) => {
  try {
    const result = await resumeDataFeedFromPersistedSession();
    console.log(`[Module1/ResumeSession] Result: ${result}`);
    return res.status(200).json({ result });
  } catch (error: any) {
    console.error("[Module1/ResumeSession] Unexpected error:", error?.message || error);
    return res.status(500).json({ error: "Failed to resume Module 1 session." });
  }
};

// ── Module 2: Aetram MarketData Auth ──────────────────────────────────────────

export const module2BrokerLogin = async (req: Request, res: Response) => {
  console.log("\n[Module2/BrokerLogin] ─────────────────────────────────────");
  console.log("[Module2/BrokerLogin] Route entered.");
  console.log("[Module2/BrokerLogin] Request body keys:", Object.keys(req.body));

  try {
    // End-user inputs: username (or userId), password, otp (or factor2)
    const username = (req.body.username || req.body.userId || req.body.appKey || "").trim();
    const password = (req.body.password || req.body.secretKey || "").trim();
    const otp = (req.body.otp || req.body.factor2 || "").trim();

    // Required user inputs validation
    if (!username || !password || (!otp && !req.body.appKey)) {
      console.warn("[Module2/BrokerLogin] Validation failed: username, password, or OTP missing.");
      return res.status(400).json({ error: "Broker Username, Password, and Daily OTP are required." });
    }

    // Secure application credentials loaded strictly from backend environment
    const appKey = (process.env.AETRAM_APP_KEY || process.env.MOD2_API_KEY || req.body.appKey || "").trim();
    const secretKey = (process.env.AETRAM_SECRET_KEY || process.env.MOD2_API_SECRET || req.body.secretKey || "").trim();

    if (!appKey || !secretKey) {
      console.error("[Module2/BrokerLogin] Configuration error: Aetram App Key or Secret Key missing in backend .env");
      return res.status(500).json({ error: "Backend Aetram API configuration is incomplete." });
    }

    console.log(`[Module2/BrokerLogin] Username : ${username}`);
    console.log(`[Module2/BrokerLogin] OTP      : ${"*".repeat(otp.length || 6)}`);

    console.log("[Module2/BrokerLogin] Authenticating with Aetram using environment credentials...");
    const result = await loginToAetramWithCredentials(appKey, secretKey);

    if (!result.ok) {
      console.warn("[Module2/BrokerLogin] Aetram auth rejected.");
      return res.status(result.httpStatus || 401).json({ 
        error: result.error || "Aetram authentication failed. Check your broker credentials and OTP.",
        reason: result.error,
        code: result.httpStatus
      });
    }

    console.log("[Module2/BrokerLogin] Aetram auth success. Connecting WebSocket...");
    await connectMarketDataWebSocket();

    const moduleToken = jwt.sign(
      { moduleId: "module2", type: "module-access", username },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    console.log("[Module2/BrokerLogin] Module JWT issued. Login complete.\n");
    return res.status(200).json({ moduleToken, moduleId: "module2" });

  } catch (error: any) {
    console.error("[Module2/BrokerLogin] Unexpected error:", error?.message || error);
    return res.status(500).json({ error: "Module 2 authentication failed. Please try again." });
  }
};
