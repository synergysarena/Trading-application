import os from "os";

const REQUIRED_PRODUCTION: Array<{ key: string; label: string }> = [
  { key: "JWT_SECRET",          label: "JWT access token secret" },
  { key: "JWT_REFRESH_SECRET",  label: "JWT refresh token secret" },
  { key: "MONGODB_URI",         label: "MongoDB connection string" },
  { key: "FRONTEND_URL",        label: "Frontend CORS origin" },
];

const ZEBU_KEYS = [
  "ZEBU_USER_ID",
  "ZEBU_CLIENT_ID",
  "MOD1_API_KEY",
  "ZEBU_WS_URL",
  "ZEBU_LOGIN_URL",
  "ZEBU_NIFTY_FUT_TOKEN",
  "ZEBU_NIFTY_CE_TOKENS",
  "ZEBU_NIFTY_PE_TOKENS",
];

const AETRAM_KEYS = [
  "MOD2_API_KEY",
  "MOD2_API_SECRET",
  "AETRAM_MARKETDATA_API_BASE_URL",
  "AETRAM_MARKETDATA_AUTH_URL",
];

const INSECURE_DEFAULTS = [
  "supersecretjwtkeyforstockdashboardintraday2026",
  "anotherrefreshsecretjwtkeyforstockdashboardintraday2026",
  "your_jwt_secret_here",
  "your_jwt_refresh_secret_here",
];

const isInsecureDefault = (value: string | undefined) =>
  !value || INSECURE_DEFAULTS.includes(value);

const maskUri = (uri: string): string => {
  try {
    return uri.replace(/:\/\/([^:@]+)(:[^@]+)?@/, "://***:***@");
  } catch {
    return "[configured]";
  }
};

export const runStartupCheck = (): void => {
  const isProd = process.env.NODE_ENV === "production";
  const errors: string[] = [];
  const warnings: string[] = [];

  const div = "─".repeat(62);
  console.log(`\n${div}`);
  console.log(`[Startup] TradePro Backend  |  ${isProd ? "PRODUCTION" : "DEVELOPMENT"}`);
  console.log(`[Startup] Node ${process.version}  |  PID ${process.pid}  |  Host ${os.hostname()}`);
  console.log(`[Startup] Platform: ${os.type()} ${os.arch()}  |  Memory: ${Math.round(os.totalmem() / 1e6)} MB`);
  console.log(div);

  // ── Environment loaded ────────────────────────────────────────────────────
  console.log(`[Startup] Environment loaded  (NODE_ENV=${process.env.NODE_ENV || "development"})`);

  // ── JWT ───────────────────────────────────────────────────────────────────
  const jwtSecretOk    = !isInsecureDefault(process.env.JWT_SECRET);
  const jwtRefreshOk   = !isInsecureDefault(process.env.JWT_REFRESH_SECRET);
  if (jwtSecretOk && jwtRefreshOk) {
    console.log("[Startup] JWT configured  ✓");
  } else {
    const msg = "JWT_SECRET / JWT_REFRESH_SECRET are using insecure default values";
    if (isProd) {
      errors.push(msg);
      console.error("[Startup] JWT configured  ✗  (insecure default — PRODUCTION BLOCKER)");
    } else {
      warnings.push(msg);
      console.warn("[Startup] JWT configured  ⚠  (using development default — safe for dev only)");
    }
  }

  // ── MongoDB ───────────────────────────────────────────────────────────────
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
    console.log(`[Startup] MongoDB configured  ✓  (${maskUri(mongoUri).split("@").pop() ?? "host hidden"})`);
  } else {
    const msg = "MONGODB_URI not set";
    if (isProd) {
      errors.push(msg);
      console.error("[Startup] MongoDB configured  ✗  (MONGODB_URI missing — PRODUCTION BLOCKER)");
    } else {
      warnings.push(msg + " — falling back to localhost");
      console.warn("[Startup] MongoDB configured  ⚠  (using localhost fallback — dev only)");
    }
  }

  // ── Redis ─────────────────────────────────────────────────────────────────
  const hasUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  const hasIoRedis  = !!process.env.REDIS_URL;
  if (hasUpstash) {
    console.log("[Startup] Redis configured  ✓  (Upstash REST)");
  } else if (hasIoRedis) {
    console.log("[Startup] Redis configured  ✓  (ioredis)");
  } else {
    const msg = "No Redis credentials — in-memory fallback active (data lost on restart)";
    warnings.push(msg);
    console.warn("[Startup] Redis configured  ⚠  (in-memory fallback — ltp/oi data will NOT persist across restarts)");
  }

  // ── CORS / Frontend URL ───────────────────────────────────────────────────
  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl && frontendUrl !== "*") {
    console.log(`[Startup] CORS origin  ✓  (${frontendUrl})`);
  } else {
    const msg = "FRONTEND_URL not set — CORS allows all origins; browser will reject credentialed requests";
    warnings.push(msg);
    if (isProd) {
      // Credentialed WebSocket/fetch requests will fail with origin=* in production browsers
      errors.push("FRONTEND_URL must be set in production — Socket.IO credentialed connections require explicit origin");
      console.error("[Startup] CORS origin  ✗  (FRONTEND_URL missing — credentialed requests will fail in browsers)");
    } else {
      console.warn("[Startup] CORS origin  ⚠  (allowing all origins — set FRONTEND_URL for production)");
    }
  }

  // ── Zebu broker (Module 1) ────────────────────────────────────────────────
  const zebuMissing = ZEBU_KEYS.filter((k) => !process.env[k]);
  if (zebuMissing.length === 0) {
    console.log("[Startup] Zebu broker (Module 1)  ✓  (all credentials present)");
  } else {
    warnings.push(`Zebu Module 1 incomplete — missing: ${zebuMissing.join(", ")}`);
    console.warn(`[Startup] Zebu broker (Module 1)  ⚠  (missing: ${zebuMissing.join(", ")})`);
  }

  // ── Zebu token expiry check ───────────────────────────────────────────────
  // Parse DDMONYY embedded in symbols like NIFTY23JUN26C22000 and warn if expired.
  // This only checks .env fallback tokens — runtime tokens are refreshed at login.
  const MON_MAP: Record<string, number> = {
    JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11,
  };
  const extractExpiry = (tokenEnv: string | undefined): Date | null => {
    if (!tokenEnv) return null;
    const m = tokenEnv.match(/([A-Z]+)(\d{2}[A-Z]{3}\d{2})[CP]/);
    if (!m) return null;
    const raw = m[2]; // e.g. "23JUN26"
    const day = parseInt(raw.slice(0, 2), 10);
    const mon = MON_MAP[raw.slice(2, 5)];
    const yr  = 2000 + parseInt(raw.slice(5, 7), 10);
    if (isNaN(day) || mon === undefined || isNaN(yr)) return null;
    return new Date(Date.UTC(yr, mon, day, 10, 0, 0)); // 15:30 IST = 10:00 UTC
  };

  const today = new Date();
  const ceExpiry = extractExpiry(process.env.ZEBU_NIFTY_CE_TOKENS);
  const peExpiry = extractExpiry(process.env.ZEBU_NIFTY_PE_TOKENS);

  if (ceExpiry && ceExpiry < today) {
    const label = ceExpiry.toISOString().slice(0, 10);
    warnings.push(`ZEBU_NIFTY_CE_TOKENS fallback expiry ${label} is in the past — auto-refresh at login will override this`);
    console.warn(`[Startup] Zebu CE tokens  ⚠  (fallback expiry ${label} EXPIRED — will auto-refresh at login)`);
  }
  if (peExpiry && peExpiry < today) {
    const label = peExpiry.toISOString().slice(0, 10);
    warnings.push(`ZEBU_NIFTY_PE_TOKENS fallback expiry ${label} is in the past — auto-refresh at login will override this`);
    console.warn(`[Startup] Zebu PE tokens  ⚠  (fallback expiry ${label} EXPIRED — will auto-refresh at login)`);
  }

  // ── Aetram broker (Module 2) ──────────────────────────────────────────────
  const aetramMissing = AETRAM_KEYS.filter((k) => !process.env[k]);
  if (aetramMissing.length === 0) {
    console.log("[Startup] Aetram broker (Module 2)  ✓  (all credentials present)");
  } else {
    warnings.push(`Aetram Module 2 incomplete — missing: ${aetramMissing.join(", ")}`);
    console.warn(`[Startup] Aetram broker (Module 2)  ⚠  (missing: ${aetramMissing.join(", ")})`);
  }

  console.log("[Startup] Broker services ready  (feeds start on user login, not at startup)");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(div);

  if (warnings.length > 0) {
    console.warn(`[Startup] ${warnings.length} warning(s):`);
    warnings.forEach((w) => console.warn(`  ⚠  ${w}`));
  }

  if (errors.length > 0) {
    console.error(`[Startup] ${errors.length} blocking error(s) — cannot start safely:`);
    errors.forEach((e) => console.error(`  ✗  ${e}`));
    if (isProd) {
      console.error("[Startup] Exiting. Fix the above errors and redeploy.");
      process.exit(1);
    } else {
      console.warn("[Startup] Continuing in development mode despite errors above.");
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log("[Startup] All systems go.");
  }

  console.log(`${div}\n`);
};
