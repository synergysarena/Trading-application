import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Server } from "socket.io";
import dotenv from "dotenv";

// Load configuration parameters — must be first so all subsequent imports see env vars.
// On Render (production) there is no .env file; env vars are injected by the platform.
dotenv.config();

import { runStartupCheck } from "./utils/startupCheck";

import { connectDB } from "./config/db";
import { ensureUniqueCandleIndex } from "./models/FuturesOHLC";
import { cleanupPreviousModule1SessionData, startModule1DailyCleanupScheduler } from "./services/module1DataCleanupService";
import redis from "./config/redis";
import { sweepLegacyMarketKeys } from "./services/redisWriteBuffer";
import authRouter from "./routes/auth";
import marketRouter from "./routes/market";
import trackerRouter from "./routes/tracker";
import module2Router from "./routes/module2";
import systemRouter from "./routes/system";
import { getZebuOAuthStatusEndpoint, zebuOAuthCallback } from "./controllers/zebuOAuth";
import { initPivotService } from "./services/pivotService";
import { initSocketServer } from "./services/socketService";
import { initTrackerEngine } from "./services/trackerService";
import { initSubscriptionSync } from "./services/subscriptionSyncService";
import { initMarketDataCache } from "./services/marketDataCacheService";
import { initMinuteAggregation } from "./services/minuteAggregationService";
import { connectRedis as connectModule2Redis } from "./services/redisService";
import { initCandleHistory } from "./services/candleHistoryService";
import { initCandleArchive } from "./services/candleArchiveService";
import { initMarketBroadcast } from "./services/marketBroadcastService";
import { initModule1OiService } from "./services/module1OiService";
import { startMonitoringLoop, stopMonitoringLoop, getMonitoringStatus } from "./services/monitoringService";
import { stopDataFeed } from "./services/dataFeed";
import { stopSessionManager } from "./services/module1SessionService";

const app = express();
const server = http.createServer(app);

// Trust reverse proxy headers (required for express-rate-limit on Render / Heroku / etc.)
app.set("trust proxy", 1);

// CORS allowed origins with credential support for Socket.IO & Express
const corsOriginDelegate = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean | string) => void
) => {
  // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
  if (!origin) {
    return callback(null, true);
  }

  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl) {
    const allowed = frontendUrl.split(",").map((s) => s.trim());
    if (allowed.includes(origin) || allowed.includes("*")) {
      return callback(null, origin);
    }
  }

  // In development / local testing, allow any localhost or 127.0.0.1 port
  if (process.env.NODE_ENV !== "production") {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, origin);
    }
  }

  // Return origin to satisfy Access-Control-Allow-Credentials: true
  return callback(null, origin);
};

const corsOptions: cors.CorsOptions = {
  origin: corsOriginDelegate,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
};

// Configure socket server base.
// transports: ["websocket", "polling"] enables high-speed WebSocket with robust polling fallback.
// pingInterval/pingTimeout keep the connection alive through proxy timeouts.
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 60000,
});

// Security & utility middlewares
app.use(helmet());

app.use(cors(corsOptions));

app.use(express.json());

// Global Rate Limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  // Module 1's live dashboard polls GET /api/market/futures/:symbol every
  // 500ms (Dashboard Effect 2, index.tsx) for the active candle's running
  // volume — ~120 requests/minute by design, already gated behind auth. That
  // alone exhausts this shared 200-per-15-min budget in under 100 seconds of
  // any session, after which the NEXT unrelated call (e.g. /api/market/status
  // on a timeframe change) gets a 429 the frontend correctly — but
  // confusingly — surfaces as a fatal "API Error", even though nothing is
  // actually wrong. Excluded here rather than raising `max` globally, so
  // every other route keeps the exact same protection it had before.
  // req.originalUrl (not req.path) — this middleware is mounted at "/api/",
  // and Express rebases req.path relative to the mount point for plain
  // middleware, so matching the always-absolute originalUrl avoids any
  // ambiguity about that rebasing.
  skip: (req) => req.originalUrl.startsWith("/api/market/futures/"),
});

app.use("/api/", globalLimiter);

app.get("/api/module1/zebu/oauth/callback", zebuOAuthCallback);
app.get("/api/module1/zebu/oauth/status", getZebuOAuthStatusEndpoint);

// Module 1 Config Endpoint
app.get("/module1/config", (_req, res) => {
  res.json({
    symbols: ["NIFTY-FUT", "NIFTY-SPOT"],
    timeframes: ["1m", "3m", "5m"],
    pivotMethods: ["classic", "camarilla", "fibonacci"],
    defaultSymbol: "NIFTY-FUT",
    defaultTimeframe: "5m",
    defaultMethod: "classic",
  });
});

app.get("/api/module1/config", (_req, res) => {
  res.json({
    symbols: ["NIFTY-FUT", "NIFTY-SPOT"],
    timeframes: ["1m", "3m", "5m"],
    pivotMethods: ["classic", "camarilla", "fibonacci"],
    defaultSymbol: "NIFTY-FUT",
    defaultTimeframe: "5m",
    defaultMethod: "classic",
  });
});



// Mount authentication router
app.use("/auth", authRouter);
app.use("/api/auth", authRouter);

// Mount market and tracker routers
app.use("/api", marketRouter);
app.use("/api", systemRouter);
app.use("/system", systemRouter);
app.use("/api/module2", trackerRouter);
app.use("/api/module2", module2Router);
// Dual mount (same pattern as /auth ↔ /api/auth) so Module 2 auth endpoints are
// reachable at both /module2/auth/* and /api/module2/auth/*.
app.use("/module2", module2Router);

// Health Check Endpoint
// Redis PING is throttled to once per 60s: uptime monitors hit /health every
// 30-60s, and an unthrottled ping burned ~2 commands/min of quota around the
// clock for a status that cannot meaningfully change faster than this.
let _redisHealthStatus = "unknown";
let _redisHealthCheckedAt = 0;
app.get("/health", async (_req, res) => {
  const mongoStatus = mongooseConnectionStatus();

  if (Date.now() - _redisHealthCheckedAt > 60_000) {
    _redisHealthCheckedAt = Date.now();
    try {
      await redis.ping();
      _redisHealthStatus = "connected";
    } catch (err) {
      _redisHealthStatus = "error";
    }
  }
  const redisStatus = _redisHealthStatus;

  const monitoring = await getMonitoringStatus();

  const { isMarketDataAuthenticated } = require("./services/marketDataSessionService");
  const { getStatus: getWsStatus } = require("./services/marketDataWebSocketService");
  const wsStatus = getWsStatus ? getWsStatus() : null;

  res.json({
    backend: "healthy",
    status: monitoring.status === "OK" ? "healthy" : "warning",
    timestamp: new Date().toISOString(),
    services: {
      mongodb: mongoStatus,
      redis: redisStatus,
      aetramRest: isMarketDataAuthenticated() ? "authenticated" : "ready",
      aetramMarketSocket: wsStatus ? wsStatus.state.toLowerCase() : "unknown",
    },
    monitoring,
  });
});

// Mongoose connection status resolver
function mongooseConnectionStatus() {
  const states: Record<number, string> = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };

  const mongoose = require("mongoose");
  return states[mongoose.connection.readyState] || "unknown";
}

// Global Error Handler
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled Application Error:", err);

    res.status(500).json({
      error: "Internal Server Error",
      message: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
);

const PORT = process.env.PORT || 5001;

const startServer = async () => {
  // ── Step 0: Startup validation ────────────────────────────────────────────
  // Validates all required environment variables and logs structured startup
  // status for each service. Exits with code 1 in production if critical
  // variables are missing (JWT_SECRET, FRONTEND_URL).
  runStartupCheck();

  // ── Step 1: Connect databases ─────────────────────────────────────────────
  // All services that use MongoDB or Redis must wait until these are ready.

  let dbReady = false;
  try {
    await connectDB();
    dbReady = true;
    console.log("[Server] MongoDB connected.");
    try {
      // Dedupe legacy candles + build the unique (symbol, timeframe, bar_time)
      // index before any live tick can persist a candle.
      await ensureUniqueCandleIndex();
    } catch (error: any) {
      console.error("[Server] Candle index sync failed (will retry on next restart):", error?.message || error);
    }
    try {
      // Storage-lifecycle requirement: MongoDB must hold ONLY the current
      // trading session's Module 1 market data. Purge everything from before
      // today's session on every boot — covers the "server restarted this
      // morning" case — then start the rollover scheduler for a server that
      // stays running across a midnight boundary without restarting.
      await cleanupPreviousModule1SessionData();
      startModule1DailyCleanupScheduler();
    } catch (error: any) {
      console.error("[Server] Module 1 daily cleanup failed (will retry on next restart):", error?.message || error);
    }
  } catch (error: any) {
    console.error("[Server] MongoDB connection failed:", error?.message || error);
    if (process.env.NODE_ENV === "production") {
      // In production crash fast — Render will restart the service.
      // A running server with no database is worse than a clean restart.
      console.error("[Server] Aborting: MongoDB is required in production.");
      throw error;
    }
    console.warn("[Server] Running in development mode — continuing with in-memory fallbacks.");
  }

  try {
    await redis.ping();
    console.log("[Server] Redis connected.");
    // One-time hygiene: stamp the 25h TTL on legacy no-TTL market keys so the
    // pre-existing key space converges to the same daily lifecycle as MongoDB.
    // Guarded by a marker key — runs once, not on every deploy.
    void sweepLegacyMarketKeys().catch(() => { });
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      // Redis uses an in-memory fallback (see config/redis.ts) — log but continue.
      // The fallback loses data on restart; all ltp/oi prices must be re-populated
      // from live ticks. This is acceptable for market-hours operation.
      console.warn("[Server] Redis unreachable — continuing with in-memory fallback. LTP/OI data will not persist across restarts.");
    } else {
      console.warn("[Server] Redis unavailable in development mode — using in-memory fallback.");
    }
  }

  // ── Step 2: Initialize infrastructure (no DB queries here) ───────────────
  initPivotService();
  initSocketServer(io);
  // Reuses the exact same io instance above — registers its own independent
  // "connection" listener rather than a second Socket.IO server.
  initMarketBroadcast(io);
  initSubscriptionSync();
  initMarketDataCache();
  initMinuteAggregation();

  // Module 2's own Redis connection (candle history) — independent of the
  // Module 1 client above. A failed/absent connection degrades gracefully;
  // it never blocks startup.
  try {
    await connectModule2Redis();
  } catch (err) {
    console.warn("[Server] Module 2 Redis connection warning:", err);
  }
  initCandleHistory();

  // ── Step 3: Initialize services ──────────────────────────────────────────
  try {
    initTrackerEngine();
  } catch (err) {
    console.warn("[Server] TrackerEngine init warning:", err);
  }

  // Services strictly requiring database connection
  if (dbReady) {
    try {
      initCandleArchive();
    } catch (err) {
      console.warn("[Server] CandleArchive init warning:", err);
    }
  } else {
    console.warn("[Server] Skipping CandleArchive init — DB not ready.");
  }

  // Warm up in-memory OI state from Redis (safe to run even if Redis is offline)
  try {
    await initModule1OiService();
  } catch (err) {
    console.warn("[Server] Module1OiService init warning:", err);
  }

  // ── Step 4: Start monitoring ──────────────────────────────────────────────
  startMonitoringLoop();

  // ── Step 5: Start HTTP + WebSocket server ────────────────────────────────
  server.listen(PORT, () => {
    console.log(
      `[Server] TradePro backend ready on port ${PORT} (${process.env.NODE_ENV || "development"}).`
    );
    console.log("[Server] Broker data feeds will start after user authentication.");
    console.log(`[Server] CORS origin: ${process.env.FRONTEND_URL || "dynamic (credentials supported)"}`);
  });

  // ── NOTE: Broker authentication is NOT performed here ────────────────────
  // initDataFeed()              ← REMOVED: starts after Module 1 user login
  // initAetramMarketDataService() ← REMOVED: starts after Module 2 user login
  // Data feeds begin only when the user authenticates via:
  //   POST /auth/module1-broker-login
  //   POST /auth/module2-broker-login
};

startServer().catch((error) => {
  console.error("Fatal: Backend server failed to start:", error);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Render sends SIGTERM before terminating containers. Close cleanly so in-flight
// requests finish and connections drain before the process exits.
const shutdown = (signal: string) => {
  console.log(`[Server] Received ${signal}. Shutting down gracefully…`);
  server.close(async () => {
    console.log("[Server] HTTP server closed.");
    stopMonitoringLoop();
    stopSessionManager();
    stopDataFeed(true);
    try {
      const mongoose = require("mongoose");
      await mongoose.connection.close();
      console.log("[Server] MongoDB connection closed.");
    } catch { }
    console.log("[Server] Shutdown complete.");
    process.exit(0);
  });

  // Force-kill if graceful shutdown takes more than 15 seconds
  setTimeout(() => {
    console.error("[Server] Graceful shutdown timed out — forcing exit.");
    process.exit(1);
  }, 15000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server, io };
