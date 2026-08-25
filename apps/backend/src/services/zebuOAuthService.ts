import axios from "axios";
import crypto from "crypto";

const sha256 = (text: string) => {
  return crypto.createHash("sha256").update(text).digest("hex");
};


let inMemorySessionToken: string | null = null;
let inMemoryAuthCode: string | null = null;

const isPlaceholder = (value?: string) =>
  !value || value.includes("your-") || value.includes("placeholder");

const getClientId = () => process.env.ZEBU_CLIENT_ID || "";
const getUserId = () => process.env.ZEBU_USER_ID || getClientId();
const getApiKey = () => process.env.MOD1_API_KEY || process.env.BROKER_API_KEY || "";
const getApiSecret = () => process.env.MOD1_API_SECRET || process.env.BROKER_API_SECRET || "";
const getRedirectUrl = () => process.env.ZEBU_REDIRECT_URL || process.env.REDIRECT_URL || "";
const getTokenUrl = () => process.env.ZEBU_OAUTH_TOKEN_URL || "";
const getAuthorizeUrl = () => process.env.ZEBU_OAUTH_AUTHORIZE_URL || "";
const getAuthCode = () => inMemoryAuthCode || process.env.ZEBU_AUTH_CODE || "";

export const setZebuAuthCode = (code: string) => {
  inMemoryAuthCode = code;
};

export const getZebuOAuthMissingConfig = () => {
  const missing: string[] = [];

  if (isPlaceholder(getClientId())) missing.push("ZEBU_CLIENT_ID");
  if (isPlaceholder(getApiKey())) missing.push("MOD1_API_KEY or BROKER_API_KEY");
  if (isPlaceholder(getApiSecret())) missing.push("MOD1_API_SECRET or BROKER_API_SECRET");
  if (isPlaceholder(getRedirectUrl())) missing.push("ZEBU_REDIRECT_URL or REDIRECT_URL");
  if (isPlaceholder(getTokenUrl())) missing.push("ZEBU_OAUTH_TOKEN_URL");
  if (isPlaceholder(getAuthCode())) missing.push("ZEBU_AUTH_CODE or callback code");

  return missing;
};

export const hasZebuOAuthConfig = () => getZebuOAuthMissingConfig().length === 0;

export const buildZebuAuthorizeUrl = () => {
  const authorizeUrl = getAuthorizeUrl();
  if (isPlaceholder(authorizeUrl)) return null;

  const url = new URL(authorizeUrl);
  url.searchParams.set("client_id", getClientId());
  url.searchParams.set("userid", getUserId());
  url.searchParams.set("redirect_uri", getRedirectUrl());
  url.searchParams.set("response_type", "code");
  return url.toString();
};

const extractSessionToken = (payload: any) =>
  payload?.susertoken ||
  payload?.sessionToken ||
  payload?.session_token ||
  payload?.access_token ||
  payload?.token ||
  payload?.data?.susertoken ||
  payload?.data?.sessionToken ||
  payload?.data?.access_token;

export const getCachedZebuSessionToken = () => inMemorySessionToken;

export const resolveZebuSessionToken = async () => {
  if (inMemorySessionToken) return inMemorySessionToken;

  const envToken = process.env.ZEBU_SUSERTOKEN || process.env.ZEBU_SESSION_TOKEN;
  if (!isPlaceholder(envToken)) {
    inMemorySessionToken = envToken!;
    return inMemorySessionToken;
  }

  // 1. Try QuickAuth Direct Login first if credentials exist
  const uid = (process.env.ZEBU_USER_ID || process.env.ZEBU_CLIENT_ID || "").trim();
  const pwd = (process.env.ZEBU_PASSWORD || "").trim();
  const factor2 = (process.env.ZEBU_FACTOR2 || "").trim();
  const vc = (process.env.ZEBU_VENDOR_CODE || "").trim();
  const appkey = (process.env.MOD1_API_KEY || process.env.BROKER_API_KEY || "").trim();
  const loginUrl = (process.env.ZEBU_LOGIN_URL || "").trim();

  if (uid && pwd && factor2 && vc && appkey && loginUrl) {
    try {
      console.log("[ZebuAuth] Attempting direct QuickAuth login...");
      const pwdHash = sha256(pwd);
      const appkeyHash = sha256(`${uid}|${appkey}`);
      
      const payload = {
        apkversion: "1.0.0",
        uid,
        pwd: pwdHash,
        factor2,
        imei: (process.env.ZEBU_IMEI || "abc1234").trim(),
        source: "API",
        vc,
        appkey: appkeyHash
      };

      const dataString = `jData=${JSON.stringify(payload)}`;
      const response = await axios.post(loginUrl, dataString, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      });

      if (response.data && response.data.stat === "Ok" && response.data.susertoken) {
        console.log("[ZebuAuth] QuickAuth login successful.");
        inMemorySessionToken = response.data.susertoken;
        return inMemorySessionToken;
      } else {
        console.warn("[ZebuAuth] QuickAuth login failed, response:", response.data);
      }
    } catch (err: any) {
      console.error("[ZebuAuth] QuickAuth login error:", err?.message || err);
    }
  }

  if (!hasZebuOAuthConfig()) return null;

  const brokerApiKey = `${getUserId()}:::${getClientId()}`;
  const response = await axios.post(
    getTokenUrl(),
    {
      code: getAuthCode(),
      redirect_uri: getRedirectUrl(),
      grant_type: "authorization_code",
      client_id: getClientId(),
      api_key: getApiKey(),
      broker_api_key: brokerApiKey,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": getApiKey(),
        "x-api-secret": getApiSecret(),
        "x-broker-api-key": brokerApiKey,
        "x-broker-api-secret": getApiSecret(),
      },
    },
  );

  const token = extractSessionToken(response.data);
  if (!token || typeof token !== "string") {
    throw new Error("Zebu OAuth token response did not include a session token.");
  }

  inMemorySessionToken = token;
  return inMemorySessionToken;
};

export const getZebuOAuthStatus = () => ({
  hasCachedSessionToken: Boolean(inMemorySessionToken),
  authorizeUrl: buildZebuAuthorizeUrl(),
  missing: getZebuOAuthMissingConfig(),
});
