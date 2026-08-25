import axios from "axios";
import { getModule2MissingInteractiveConfig } from "./module2InteractiveDataService";

/**
 * Market Data (Symphony XTS / AETRAM) authentication & session management.
 *
 * Single source of truth for the Module 2 Market Data session. All other
 * services (REST lookups, WebSocket feed) must read the token from here and
 * must never keep their own copy of session state.
 *
 * Only session information is stored — credentials are used transiently for
 * the login request and never retained.
 */

export type MarketDataAuthStatus =
  | "AUTHENTICATED"
  | "NOT_AUTHENTICATED"
  | "EXPIRED"
  | "WAITING_FOR_CONFIGURATION";

export interface MarketDataSession {
  token: string;
  userID: string;
  loginTime: Date;
  expiresAt: Date;
}

export interface MarketDataLoginResult {
  ok: boolean;
  status: MarketDataAuthStatus;
  userID?: string;
  expiresAt?: string;
  error?: string;
  httpStatus?: number;
  rawResponse?: any;
}

export interface MarketDataAuthHealth {
  status: MarketDataAuthStatus;
  authenticated: boolean;
  userID: string | null;
  loginTime: string | null;
  expiresAt: string | null;
  missingConfig: string[];
}

// ── In-memory session state ───────────────────────────────────────────────────
let session: MarketDataSession | null = null;
// Distinguishes "was authenticated but the session ended" (EXPIRED) from
// "never authenticated" (NOT_AUTHENTICATED) in status reports.
let sessionEnded: "expired" | "logout" | null = null;

// XTS tokens have no expiry field in the login response; track a local TTL so
// stale sessions are detected proactively instead of only via 401 responses.
// Kept at 8h to match the module JWT lifetime issued on broker login.
const DEFAULT_SESSION_TTL_HOURS = 8;

const getSessionTtlMs = (): number => {
  const hours = Number(process.env.MOD2_SESSION_TTL_HOURS || DEFAULT_SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_TTL_HOURS) * 3600 * 1000;
};

const getAuthUrl = () => (process.env.AETRAM_MARKETDATA_AUTH_URL || "").trim();
const getBaseUrl = () => (process.env.AETRAM_MARKETDATA_API_BASE_URL || "").trim();
const getEnvAppKey = () => (process.env.AETRAM_APP_KEY || process.env.MOD2_API_KEY || "").trim();
const getEnvSecret = () => (process.env.AETRAM_SECRET_KEY || process.env.MOD2_API_SECRET || "").trim();

const isTtlElapsed = (): boolean =>
  !!session && Date.now() >= session.expiresAt.getTime();

/** Strips anything token-like from an upstream response before it is logged or returned. */
const sanitizeUpstreamBody = (body: unknown): unknown => {
  if (!body || typeof body !== "object") return body;
  const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (clone.result && typeof clone.result === "object") {
    const result = { ...(clone.result as Record<string, unknown>) };
    delete result.token;
    clone.result = result;
  }
  delete (clone as Record<string, unknown>).token;
  return clone;
};

// ── Session accessors ─────────────────────────────────────────────────────────

export const isMarketDataAuthenticated = (): boolean => {
  if (!session) return false;
  if (isTtlElapsed()) {
    markMarketDataSessionExpired();
    return false;
  }
  return true;
};

export const getMarketDataToken = (): string | null =>
  isMarketDataAuthenticated() ? session!.token : null;

export const getMarketDataUser = (): string | null =>
  isMarketDataAuthenticated() ? session!.userID : null;

export const getMarketDataSession = (): MarketDataSession | null =>
  isMarketDataAuthenticated() ? { ...session! } : null;

export const getMarketDataAuthStatus = (): MarketDataAuthStatus => {
  if (getModule2MissingInteractiveConfig().length > 0 && !session) {
    return "WAITING_FOR_CONFIGURATION";
  }
  if (isMarketDataAuthenticated()) return "AUTHENTICATED";
  return sessionEnded === "expired" ? "EXPIRED" : "NOT_AUTHENTICATED";
};

export const getMarketDataAuthHealth = (): MarketDataAuthHealth => {
  const authenticated = isMarketDataAuthenticated();
  return {
    status: getMarketDataAuthStatus(),
    authenticated,
    userID: authenticated ? session!.userID : null,
    loginTime: authenticated ? session!.loginTime.toISOString() : null,
    expiresAt: authenticated ? session!.expiresAt.toISOString() : null,
    missingConfig: getModule2MissingInteractiveConfig(),
  };
};

/** Called on 401s from any Market Data request so all consumers see the same state. */
export const markMarketDataSessionExpired = (): void => {
  if (session) {
    console.warn("[Module2Auth] Session expired.");
  }
  session = null;
  sessionEnded = "expired";
};

// ── Login / logout ────────────────────────────────────────────────────────────

/**
 * Authenticate against the Symphony XTS Market Data API.
 * Credentials may be provided at runtime (user login) or omitted to fall back
 * to the configured MOD2_API_KEY / MOD2_API_SECRET.
 */
export const loginMarketData = async (
  appKey?: string,
  secretKey?: string
): Promise<MarketDataLoginResult> => {
  const authUrl = getAuthUrl();
  const key = (appKey || getEnvAppKey()).trim();
  const secret = (secretKey || getEnvSecret()).trim();

  const missing: string[] = [];
  if (!authUrl) missing.push("AETRAM_MARKETDATA_AUTH_URL");
  if (!getBaseUrl()) missing.push("AETRAM_MARKETDATA_API_BASE_URL");
  if (!key) missing.push("MOD2_API_KEY (or request appKey)");
  if (!secret) missing.push("MOD2_API_SECRET (or request secretKey)");

  if (missing.length > 0) {
    console.error(`[Module2Auth] Configuration error — missing: ${missing.join(", ")}`);
    return {
      ok: false,
      status: "WAITING_FOR_CONFIGURATION",
      error: `Market Data API not configured. Missing: ${missing.join(", ")}`,
    };
  }

    const maskedSecret = secret.length > 6 
    ? `${secret.slice(0, 3)}***${secret.slice(-3)}`
    : "***";
  
  const reqBody = { secretKey: secret, appKey: key, source: "WEBAPI" };
  const reqHeaders = { "Content-Type": "application/json" };

  let parsedHost = "secure.aetramtrades.in";
  let parsedPath = "/apimarketdata/auth/login";
  let parsedProtocol = "HTTPS";
  try {
    const urlObj = new URL(authUrl);
    parsedHost = urlObj.hostname;
    parsedPath = urlObj.pathname;
    parsedProtocol = urlObj.protocol.replace(":", "").toUpperCase();
  } catch (_) {
    // fallback
  }

  console.log(`[AETRAM][NETWORK] Request starting`);
  console.log(`[AETRAM][NETWORK] Host: ${parsedHost}`);
  console.log(`[AETRAM][NETWORK] Path: ${parsedPath}`);
  console.log(`[AETRAM][NETWORK] Protocol: ${parsedProtocol}`);
  console.log(`[AETRAM][NETWORK] Timeout: 15000ms`);

  console.log("[AETRAM][AUTH] Starting authentication");
  console.log(`----------------------------------------------------
[Module2/Login] Starting broker authentication...
API URL: ${authUrl}
HTTP Method: POST
Request Headers: ${JSON.stringify(reqHeaders)}
Request Body: ${JSON.stringify({ ...reqBody, secretKey: maskedSecret })}
Timestamp: ${new Date().toISOString()}
----------------------------------------------------`);

  const startTime = Date.now();

  try {
    const response = await axios.post(
      authUrl,
      reqBody,
      { headers: reqHeaders, timeout: 15000 }
    );

    const duration = Date.now() - startTime;
    console.log(`[AETRAM][NETWORK] HTTP response received`);
    console.log(`[AETRAM][NETWORK] Status: ${response.status}`);
    console.log(`[AETRAM][NETWORK] Duration: ${duration}ms`);

    const body = response.data;
    
    if (body?.type === "success" && body?.result?.token) {
      const now = new Date();
      session = {
        token: String(body.result.token),
        userID: String(body.result.userID || ""),
        loginTime: now,
        expiresAt: new Date(now.getTime() + getSessionTtlMs()),
      };
      sessionEnded = null;
      
      const maskedToken = session.token.length > 12 
        ? `${session.token.substring(0, 8)}...[REDACTED]`
        : "***";
      
      console.log("[AETRAM][AUTH] Login successful");
      console.log(`[AETRAM][AUTH] Token received for userID: ${session.userID}`);
      console.log(`----------------------------------------------------
[Module2/Login] Authentication Success

HTTP Status: ${response.status}
Response Headers: ${JSON.stringify(response.headers)}
Token (masked): ${maskedToken}
UserID: ${session.userID}
Description: ${body?.description || 'N/A'}
----------------------------------------------------`);

      return {
        ok: true,
        status: "AUTHENTICATED",
        userID: session.userID,
        expiresAt: session.expiresAt.toISOString(),
      };
    }

    console.warn(`[AETRAM][AUTH] Login failed: ${body?.description || body?.message || "Invalid credentials"}`);

    console.log(`----------------------------------------------------
[Module2/Login] Authentication Failed

HTTP Status: ${response.status}
Status Text: ${response.statusText}
Response Headers: ${JSON.stringify(response.headers)}
Raw Response Body: ${typeof body === 'object' ? JSON.stringify(body) : body}
Parsed JSON: ${typeof body === 'object' ? JSON.stringify(body, null, 2) : 'N/A'}

type: ${body?.type}
code: ${body?.code}
description: ${body?.description}
message: ${body?.message}
errors: ${JSON.stringify(body?.errors)}
stack: ${body?.stack}
requestId: ${body?.requestId}

Axios Error: undefined
Axios Code: undefined
Axios Message: undefined
Axios Config: undefined
Axios URL: undefined
----------------------------------------------------`);
    
    return {
      ok: false,
      status: "NOT_AUTHENTICATED",
      error: body?.description || JSON.stringify(body) || "Authentication rejected by Market Data API.",
      httpStatus: response.status,
      rawResponse: body
    } as any;
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`[AETRAM][NETWORK] Request failed`);
    console.error(`[AETRAM][NETWORK] Error code: ${error?.code || 'N/A'}`);
    console.error(`[AETRAM][NETWORK] Error message: ${error?.message || 'N/A'}`);
    console.error(`[AETRAM][NETWORK] Duration: ${duration}ms`);
    console.error(`[AETRAM][NETWORK] errno: ${error?.errno || error?.cause?.errno || 'N/A'}`);
    console.error(`[AETRAM][NETWORK] syscall: ${error?.syscall || error?.cause?.syscall || 'N/A'}`);
    console.error(`[AETRAM][NETWORK] hostname: ${error?.hostname || error?.cause?.hostname || parsedHost}`);

    const httpStatus: number | undefined = error?.response?.status;
    const body = error?.response?.data;
    
    console.error(`----------------------------------------------------
[Module2/Login] Authentication Failed

HTTP Status: ${httpStatus || 'N/A'}
Status Text: ${error?.response?.statusText || 'N/A'}
Response Headers: ${JSON.stringify(error?.response?.headers || {})}
Raw Response Body: ${typeof body === 'object' ? JSON.stringify(body) : (body || 'N/A')}
Parsed JSON: ${typeof body === 'object' ? JSON.stringify(body, null, 2) : 'N/A'}

type: ${body?.type}
code: ${body?.code}
description: ${body?.description}
message: ${body?.message}
errors: ${JSON.stringify(body?.errors)}
stack: ${body?.stack}
requestId: ${body?.requestId}

Axios Error: ${error}
Axios Code: ${error?.code}
Axios Message: ${error?.message}
Axios Config: ${JSON.stringify(error?.config || {})}
Axios URL: ${error?.config?.url}
----------------------------------------------------`, error);

    let reason: string = "Market Data API request failed.";
    if (body?.description) reason = body.description;
    else if (error?.code === "ECONNABORTED") reason = "Market Data API request timed out.";
    else if (httpStatus) reason = body ? JSON.stringify(body) : `Market Data API rejected the request (HTTP ${httpStatus}).`;

    return { 
      ok: false, 
      status: "NOT_AUTHENTICATED", 
      error: reason, 
      httpStatus,
      rawResponse: body
    } as any;
  }
};

/**
 * End the Market Data session. Best-effort remote invalidation, then the local
 * session is always cleared.
 */
export const logoutMarketData = async (): Promise<{ loggedOut: boolean }> => {
  const token = session?.token;
  const baseUrl = getBaseUrl();

  if (token && baseUrl) {
    try {
      await axios.delete(`${baseUrl}/auth/logout`, {
        headers: { authorization: token },
        timeout: 8000,
      });
      console.log("[Module2Auth] Remote session invalidated.");
    } catch (error: any) {
      // Local logout still proceeds — the token dies with the local session.
      console.warn(
        `[Module2Auth] Remote logout failed (${error?.response?.status || error?.code || error?.message}). Clearing local session anyway.`
      );
    }
  }

  session = null;
  sessionEnded = "logout";
  console.log("[Module2Auth] Logout complete — session cleared.");
  return { loggedOut: true };
};
