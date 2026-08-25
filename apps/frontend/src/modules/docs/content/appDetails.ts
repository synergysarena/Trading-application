import type { Section } from "./types";

// ── APPLICATION DETAILS — developer-facing documentation ──────────────────────
// Audience: developers / future maintainers. Internal file names, service
// names, endpoints and formulas are fair game here. Everything below is
// verified against the current implementation (backend + frontend source),
// not carried forward from older docs.

export const APP_DETAILS_SECTIONS: Section[] = [
  // ── 1. ARCHITECTURE ───────────────────────────────────────────────────────
  {
    id: "app-architecture",
    heading: "1 — System Architecture",
    blocks: [
      {
        type: "table",
        headers: ["Layer", "Technology"],
        rows: [
          ["Frontend", "React 19 + TypeScript, Vite, Zustand, TanStack React Query, Socket.IO client, xlsx"],
          ["Backend", "Node.js + Express + TypeScript, Socket.IO server, Mongoose, ioredis/Upstash REST, ws (raw broker WebSocket)"],
          ["Database", "MongoDB — FuturesOHLC (candles), PivotLevels (pivot cache), User, Watchlist"],
          ["Cache", "Redis — Upstash REST, or ioredis, or an in-process MockRedis fallback if neither is reachable"],
          ["Broker (Module 1)", "Zebu (MYNT) — REST QuickAuth login, raw WebSocket (Noren protocol) tick feed"],
          ["Realtime transport", "Socket.IO, JWT-authenticated, backend ↔ frontend"],
        ],
      },
      {
        type: "para",
        content:
          "Monorepo layout: apps/backend, apps/frontend, packages/shared (Zod schemas/types shared by both), managed as npm workspaces. docker-compose.yml provisions MongoDB 7.0 and Redis 7.2 containers alongside the two app containers.",
      },
      {
        type: "code",
        label: "Data flow (summary)",
        content:
          "Zebu broker (WebSocket, Noren protocol)\n" +
          "  -> zebuMarketDataClient.ts -> dataFeed.ts (processIncomingTick)\n" +
          "       -> redisWriteBuffer.ts (in-memory mirror + throttled Redis persistence)\n" +
          "       -> module1OiService.ts (per-second OI matrix, in-memory only)\n" +
          "       -> ohlcAggregator.ts (12 simultaneous timeframe candles)\n" +
          "            -> in-memory finalized-candle cache (400/symbol/timeframe cap)\n" +
          "            -> batched MongoDB bulkWrite (FuturesOHLC, 45-day TTL)\n" +
          "  -> socketService.ts (tick / market_ready / latest-oi / indicators / pivots / broker_status)\n" +
          "  -> frontend useSocket.ts -> useStore (global price/OI cache)\n" +
          "       -> modules/dashboard/index.tsx (row builder)\n" +
          "  -> Worksheet.tsx (renders DashboardRow[]) -> excelExport.ts",
      },
      {
        type: "note",
        content:
          "Two independent pivot/indicator systems exist. Frontend: apps/frontend/src/calc/index.ts's pivotForBar computes PP/R1-R3/S1-S3 per row from that row's own Future OHLC bar (4-Bar or Classic method, toggled in the InfoBar) — feeds the worksheet's hidden pivot columns. Backend: apps/backend/src/services/pivotService.ts + utils/pivotEngine.ts recompute Classic/Camarilla/Fibonacci pivots on every finalized candle for every symbol/timeframe, persist to MongoDB, and serve them via GET /api/market/pivots/:symbol/:tf and a pivots Socket.IO event — this entire subsystem, plus GET /module1/indicators/:symbol and the indicators event, is implemented but never invoked by the current frontend (no UI code calls setModule1IndicatorRoom or fetches /module1/indicators).",
      },
    ],
  },

  // ── 2. FRONTEND ───────────────────────────────────────────────────────────
  {
    id: "app-frontend",
    heading: "2 — Frontend Architecture",
    subsections: [
      {
        id: "app-fe-tree",
        heading: "2.1 Component tree",
        blocks: [
          {
            type: "code",
            content:
              "App.tsx\n" +
              "  Auth.tsx                      (/login — app-level sign in, optional OTP step)\n" +
              "  ModuleDashboardLayout          (socket init happens here, not at App root)\n" +
              "    ModuleTopBar / ModuleSidebar\n" +
              "    ModuleSelection.tsx           (/dashboard, /dashboard/home)\n" +
              "    ModuleWorkspace.tsx            (/dashboard/module-1, /dashboard/module-2)\n" +
              "      Module1LoginPanel.tsx OR Module1.tsx -> modules/dashboard/index.tsx (Dashboard)\n" +
              "        InfoBar / ConfigRow.tsx / TimeframeRow.tsx / Worksheet.tsx / StatusPanel\n" +
              "      Module2LoginPanel.tsx OR Module2Tabs (Module2.tsx / Module2Live.tsx)\n" +
              "    DocsPage                      (/dashboard/docs)",
          },
          {
            type: "para",
            content:
              "Module1.tsx is a 5-line wrapper that renders Dashboard from modules/dashboard/index.tsx — that file is the actual Module 1 orchestrator (toolbar, status handling, row-building effects).",
          },
        ],
      },
      {
        id: "app-fe-state",
        heading: "2.2 State management",
        blocks: [
          {
            type: "table",
            headers: ["Store", "File", "Holds"],
            rows: [
              ["Global app store", "store/useStore.ts", "App auth (user, accessToken), module tokens (module1Token/module2Token, sessionStorage-persisted), live price cache, OI metrics, marketDataReady flag, Module 2 tracker session"],
              ["Module 1 dashboard store", "modules/dashboard/store.ts", "Config selection chain, FeedStatus, rows: DashboardRow[], hiddenCols/colOrder (localStorage, per-user scoped), pivotMethod"],
            ],
          },
          {
            type: "para",
            content:
              "Both are Zustand stores. React Query is used only for expiry/strike lookups (staleTime: Infinity — fetched once per unique key) and for /api/market/status and /api/module/status polling (refetchInterval 15000ms / 10000ms respectively, in ModuleDashboardLayout).",
          },
        ],
      },
      {
        id: "app-fe-calc",
        heading: "2.3 Calculation engine",
        blocks: [
          {
            type: "para",
            content:
              "apps/frontend/src/calc/index.ts is a pure TypeScript module (no React imports) exporting: OHLCBar, DashboardRow (the row model), mmaBar/tlaFromMMA, computeRanking, computeEMASeries, computeVWAPSeries, computeRsiSeries, fibLevels/nearestFibLabel, smcNearest, compareScore/totalScoreFromParts/ratingFromTotalScore/signalFromRating, pivotForBar/clientPivot4Bar/classicPivot. Covered by apps/frontend/src/calc/index.test.ts.",
          },
        ],
      },
      {
        id: "app-fe-row-builder",
        heading: "2.4 Row builder (modules/dashboard/index.tsx)",
        blocks: [
          {
            type: "bullets",
            items: [
              "Effect 1 — fires on any selection change ([isGenerated, instrument, timeframe, customRange, reloadKey, generateKey, expiryDate, callStrike, putStrike, type]): checks /api/market/status, fetches Future/CE/PE/Spot OHLC in parallel plus a 200-bar Spot warm-up series, builds every historical row synchronously, seeds EMA/EMA200/VWAP continuation state (prevEmaRef, prevEma200Ref, vwapStateRef) and session high/low (swHighRef/swLowRef). reloadKey (useDashStore) replaces the old local retryKey state — it's bumped by the manual Retry button, by broker_status:\"live\" socket events while stuck in an error state, and by a periodic auto-retry (Effect 1b) so recovery never requires a manual refresh.",
              "Effect 1b — automatic recovery: while feedStatus is api-error/auth-error/no-network it bumps reloadKey every 5s, and every 60s while market-closed, so a stale point-in-time check or a tab left open across the market-open transition self-heals without user interaction.",
              "Effect 2 — a 500ms setInterval that builds/updates the live row: reads prices from useStore, polls GET /api/market/futures/:symbol?timeframe=... for the backend's authoritative running Future volume (used for live VWAP), finalizes the previous live bar into the running EMA/VWAP/RSI state when the timeframe boundary rolls over, and calls appendRow/updateLatestRow.",
              "Effect 3 — a 60s setInterval that triggers the automatic end-of-day Excel export once IST time passes 15:45 on a weekday, deduped via a per-user, per-day localStorage flag.",
              "FRESH_TTL_MS = 8000 — Future/Spot prices older than 8s are rendered as a missing bar (MISSING_BAR) rather than re-stamped, though the raw LTP still feeds ranking/SMC/Fibonacci.",
              "MISSING_BAR sentinel: {o,h,l,c: NaN} — propagates cleanly through mmaBar/tlaFromMMA without polluting neighbouring values; p0() renders NaN as \"—\".",
            ],
          },
        ],
      },
      {
        id: "app-fe-hidden",
        heading: "2.5 UI controls present in code but hidden",
        blocks: [
          {
            type: "warn",
            content:
              "The Option Type selector (Call/Put/Call+Put), the Generate and Reset buttons, the config-collapse arrow button, and the Custom timeframe pill (plus its entire date-range panel) are all implemented in ConfigRow.tsx / TimeframeRow.tsx but wrapped in style={{display:\"none\"}} per an explicit \"hidden per client request\" code comment. The store logic (setType, generate, reset, setCustomRange) remains fully wired — re-exposing any of these is a pure UI change, not new development. The app is functionally locked to type=\"Call+Put\" and auto-generate as a result.",
          },
        ],
      },
    ],
  },

  // ── 3. BACKEND ────────────────────────────────────────────────────────────
  {
    id: "app-backend",
    heading: "3 — Backend Architecture",
    subsections: [
      {
        id: "app-be-folders",
        heading: "3.1 Folder structure (apps/backend/src)",
        blocks: [
          {
            type: "table",
            headers: ["Folder", "Contents"],
            rows: [
              ["controllers/", "market.ts, brokerAuth.ts, zebuOAuth.ts, auth.ts, module2*.ts, tracker.ts"],
              ["routes/", "market.ts, auth.ts, module2.ts, tracker.ts"],
              ["services/", "dataFeed.ts, zebuMarketDataClient.ts, ohlcAggregator.ts, module1OiService.ts, pivotService.ts, redisWriteBuffer.ts, socketService.ts, instrumentTokenService.ts, zebuOAuthService.ts, monitoringService.ts, plus Module 2-only services (marketDataPipelineService.ts, minuteAggregationService.ts, candleHistoryService.ts, candleArchiveService.ts, subscriptionService.ts, etc.)"],
              ["models/ + schemas/", "FuturesOHLC, PivotLevels, User, Watchlist, SpotTicks (Mongoose models + Zod-adjacent schema definitions)"],
              ["middleware/", "auth.ts (JWT + blacklist check)"],
              ["utils/", "token.ts (JWT issuance/secret resolution), pivotEngine.ts (pivot formulas), startupCheck.ts, fixDb.ts"],
              ["config/", "db.ts (Mongo connection), redis.ts (3-tier Redis client resolution)"],
            ],
          },
        ],
      },
      {
        id: "app-be-module1-vs-2",
        heading: "3.2 Module 1 vs Module 2 services — do not conflate",
        blocks: [
          {
            type: "warn",
            content:
              "marketDataPipelineService.ts, minuteAggregationService.ts, marketDataSessionService.ts, marketDataWebSocketService.ts, marketDataCacheService.ts, marketBroadcastService.ts, marketDataEvents.ts, candleHistoryService.ts, candleArchiveService.ts, subscriptionService.ts, subscriptionSyncService.ts, instrumentService.ts, instrumentValidation.ts, redisService.ts, and cacheStore.ts are all Module 2 (Symphony XTS/Aetram) infrastructure — verifiable from their own doc-comments (\"Module 2 Redis Connection Manager\", \"Symphony XTS / AETRAM\"). Module 1's actual pipeline is dataFeed.ts, zebuMarketDataClient.ts, ohlcAggregator.ts, redisWriteBuffer.ts, module1OiService.ts, pivotService.ts, instrumentTokenService.ts, socketService.ts (shared with Module 2, but Module 1-relevant events are documented in section 9).",
          },
        ],
      },
      {
        id: "app-be-server",
        heading: "3.3 Startup / shutdown (server.ts)",
        blocks: [
          {
            type: "bullets",
            items: [
              "runStartupCheck() runs first: validates JWT_SECRET, JWT_REFRESH_SECRET, MONGODB_URI, FRONTEND_URL against a fixed insecure-defaults list; exits the process (process.exit(1)) in production if any are missing/insecure, only warns in development.",
              "No broker authentication happens at server startup — deliberately removed. Both Module 1's Zebu feed and Module 2's Aetram feed only start in response to their respective POST /auth/module{1,2}-broker-login calls.",
              "helmet() and cors({origin: FRONTEND_URL || \"*\", credentials:true}) applied server-wide. Global rate limiter: 200 requests/15min on all /api/* routes.",
              "GET /health folds in monitoringService.getMonitoringStatus() plus a throttled (max once/60s) MongoDB/Redis connectivity check.",
              "Graceful shutdown (SIGTERM/SIGINT, 15s force-kill timeout) calls stopDataFeed() and stopMonitoringLoop().",
            ],
          },
        ],
      },
    ],
  },

  // ── 4. DATABASE ───────────────────────────────────────────────────────────
  {
    id: "app-database",
    heading: "4 — Database (MongoDB)",
    blocks: [
      {
        type: "table",
        headers: ["Collection", "Key fields", "Indexes"],
        rows: [
          ["FuturesOHLC", "symbol, timeframe, bar_open/high/low/close, bar_time, volume", "Unique compound {symbol,timeframe,bar_time}; TTL on bar_time, 45 days"],
          ["PivotLevels", "symbol, date, timeframe (enum: 1m|3m|5m|custom only), method (classic|camarilla|fibonacci), pivot, r1-r4, s1-s4, computed_at", "Compound {symbol,timeframe,computed_at desc}; no TTL — accumulates indefinitely"],
          ["User", "username (unique), password (bcrypt cost 12), name, status (active|inactive)", "username indexed"],
          ["Watchlist", "user_id (ref User), symbols_json, column_prefs_json", "user_id indexed"],
          ["SpotTicks", "symbol, ltp, timestamp, volume", "TTL on timestamp, 24h — defined but no code path writes to it (unused model)"],
        ],
      },
      {
        type: "warn",
        content:
          "PivotLevels.timeframe only allows 1m/3m/5m/custom, but ohlcAggregator.ts finalizes candles for 12 timeframes. A finalized 15m/30m/45m/2h/3h/4h candle's pivot recalculation silently fails Mongoose validation on PivotLevelsModel.create — the error is swallowed by pivotService.ts's try/catch, so pivots still compute correctly and populate the in-memory cache, they're just never persisted to Mongo for those timeframes.",
      },
      {
        type: "para",
        content:
          "One-time startup migration (ensureUniqueCandleIndex): deduplicates any pre-existing (symbol,timeframe,bar_time) collisions in FuturesOHLC (keeping the most recently-written document by ObjectId order) before enforcing the unique index — must run after Mongo connects and before live ticks start persisting.",
      },
    ],
  },

  // ── 5. REDIS ───────────────────────────────────────────────────────────────
  {
    id: "app-redis",
    heading: "5 — Redis / Caching Strategy",
    blocks: [
      {
        type: "para",
        content:
          "config/redis.ts resolves a three-tier client behind a Proxy so every call site sees one dynamic reference regardless of backend: Upstash REST client (if UPSTASH_REDIS_REST_URL/TOKEN set) -> standard ioredis (REDIS_URL, default redis://127.0.0.1:6379) -> in-process MockRedis (Map-backed, setTimeout-based expiry) if both fail.",
      },
      {
        type: "fields",
        fields: [
          {
            label: "In-process mirror",
            text: "redisWriteBuffer.ts keeps an in-process \"mirror\" Map that is the authoritative live-value store. readLive() is a zero-Redis-command hit in the common case.",
          },
          {
            label: "What actually gets persisted",
            text: "Only 3 keys are ever durably written back to Redis: ltp:NIFTY-SPOT, ltp:NIFTY-FUT, oi:NIFTY-FUT — at most once per 60,000ms each (PERSIST_MIN_INTERVAL_MS), and only if the value changed. Purely for restart-warmup durability.",
          },
          {
            label: "Flush cadence",
            text: "FLUSH_INTERVAL_MS = 500 — a setInterval drains the dirty map via one pipelined SETEX batch.",
          },
          {
            label: "TTL",
            text: "MARKET_TTL_SECONDS = 90000 (25h) on every persisted key.",
          },
          {
            label: "Negative caching",
            text: "Absent keys are cached as \"confirmed absent\" for 60,000ms (ABSENT_CACHE_MS) to avoid repeated GETs for missing keys.",
          },
          {
            label: "Legacy key hygiene",
            text: "sweepLegacyMarketKeys() is a one-time startup pass that stamps a 25h TTL onto any legacy ltp:*/oi:* key written without one (guarded by a maint:ttl_sweep_done marker, re-runs after 7 days).",
          },
          {
            label: "Other Redis uses",
            text: "JWT blacklist (blacklist:<token>, TTL = token's remaining lifetime), custom-timeframe config (config:custom_timeframe, no TTL — durable), persisted broker session (module1:broker-session, 8h TTL).",
          },
        ],
      },
      {
        type: "note",
        content: "Documented worst-case steady-state write load: about 4 keys/minute during market hours.",
      },
    ],
  },

  // ── 6. AUTHENTICATION ─────────────────────────────────────────────────────
  {
    id: "app-auth",
    heading: "6 — Authentication",
    subsections: [
      {
        id: "app-auth-app",
        heading: "6.1 Application-level auth (controllers/auth.ts)",
        blocks: [
          {
            type: "bullets",
            items: [
              "Two parallel credential sources: env-var (APP_LOGIN_USERNAME/APP_LOGIN_PASSWORD, plaintext compare, synthetic user id __app_env_user__) takes priority; otherwise MongoDB User lookup + bcrypt.compare, falling back to an in-memory guest user (username \"guest\") if MongoDB is unreachable.",
              "Optional OTP gate: APP_OTP_ENABLED=true + APP_LOGIN_OTP=<code> server-side, VITE_APP_OTP_ENABLED=true client-side. When enabled, /auth/login returns {otpRequired:true, loginToken} (5-minute JWT, type:\"otp-pending\") instead of a session; POST /auth/verify-otp {loginToken, otp} exchanges it for the real session.",
              "Registration (POST /auth/register) is disabled (403) whenever env-var auth mode is active.",
            ],
          },
          {
            type: "warn",
            content:
              "Inconsistency: auth.ts's OTP-pending token signing (lines ~67,114,160) reads process.env.JWT_SECRET directly with its own inline insecure-placeholder fallback string, bypassing utils/token.ts's resolveSecret() production-fatal check. In practice runStartupCheck() would already have exited the process if JWT_SECRET were unset in production, so this is latent rather than currently exploitable, but the two code paths are inconsistent and worth unifying.",
          },
        ],
      },
      {
        id: "app-auth-tokens",
        heading: "6.2 Token issuance (utils/token.ts)",
        blocks: [
          {
            type: "table",
            headers: ["Token", "Expiry", "Signing"],
            rows: [
              ["accessToken", "8h", "jwt.sign({userId}, JWT_SECRET)"],
              ["refreshToken", "7d", "jwt.sign({userId}, JWT_REFRESH_SECRET), httpOnly + sameSite:strict cookie"],
              ["moduleToken (module1)", "8h", "jwt.sign({moduleId:\"module1\", userId, type:\"module-access\"}, JWT_SECRET)"],
              ["loginToken (OTP-pending)", "5min", "jwt.sign({sub, type:\"otp-pending\", username, name}, JWT_SECRET)"],
            ],
          },
          {
            type: "para",
            content:
              "resolveSecret(envKey, label) rejects a fixed list of insecure placeholder strings. If insecure/unset and NODE_ENV===\"production\", it throws fatally. In development it falls back to a deterministic dev-only-<envkey>-not-for-production string so tokens survive dev-server restarts.",
          },
        ],
      },
      {
        id: "app-auth-middleware",
        heading: "6.3 authenticate middleware (middleware/auth.ts)",
        blocks: [
          {
            type: "para",
            content:
              "Two-tier revocation check to minimize per-request Redis load: (1) an in-memory revokedTokens: Map<token, revokedUntilMs> checked first, zero I/O, populated synchronously on logout within the same process; (2) a clearedTokens: Set<token> negative-cache — once a token is checked against Redis and found not blacklisted, it's never re-checked for the life of that Set (capped at 5000 entries, cleared entirely once exceeded). Only on first sighting does it hit redis.get(\"blacklist:<token>\"). A Redis error is swallowed (with a warning) in development but rethrown in production.",
          },
          {
            type: "note",
            content: "The negative-cache tradeoff means a token blacklisted by a different process (e.g. after a restart, or in a multi-instance deployment) is only caught if this process hadn't already cached it as \"cleared\" — explicitly accepted in-code as fine for a single-instance deployment.",
          },
        ],
      },
      {
        id: "app-auth-broker",
        heading: "6.4 Module 1 broker login (controllers/brokerAuth.ts)",
        blocks: [
          {
            type: "steps",
            steps: [
              { n: 1, text: "Validate userId + password (required); factor2 optional." },
              { n: 2, text: "Hash credentials for Zebu QuickAuth: pwd = SHA256(password); appkey = SHA256(\"${userId}|${MOD1_API_KEY}\") — this exact ordering is required, a different common Zebu-integration formula is explicitly wrong per an in-code comment." },
              { n: 3, text: "POST jData=<JSON> (form-encoded, no jKey suffix, no encodeURIComponent) to Zebu's QuickAuth endpoint, 15000ms axios timeout." },
              { n: 4, text: "HTTP failure -> 502; Zebu rejects (stat !== \"Ok\" or no susertoken) -> 401." },
              { n: 5, text: "On success, asynchronously (not awaited) calls startDataFeedWithCredentials(userId, sessionToken) — the login HTTP response does not wait for the WebSocket to actually connect." },
              { n: 6, text: "Issues moduleToken (see 6.2) using the strict JWT_SECRET from utils/token.ts (not auth.ts's loose inline-fallback pattern). Returns 200 {moduleToken, moduleId:\"module1\", userId}." },
            ],
          },
          {
            type: "warn",
            content:
              "A successful login response only proves Zebu accepted the credentials — it does not guarantee the WebSocket step (5) actually connected, since that call isn't awaited. A downstream failure surfaces later via broker-disconnected/api-error status, not via the login response itself.",
          },
        ],
      },
      {
        id: "app-auth-oauth",
        heading: "6.5 Zebu OAuth callback (dormant)",
        blocks: [
          {
            type: "para",
            content:
              "GET /api/module1/zebu/oauth/callback and /status (controllers/zebuOAuth.ts) exist but are not part of the live login flow. The callback caches an authorization code in memory and requires a manual backend restart to exchange it — an operational procedure for a deployment mode where the backend authenticates using only .env credentials, not per-user login. zebuOAuthService.resolveZebuSessionToken()/getCachedZebuSessionToken() have no importers outside zebuOAuthService.ts/zebuOAuth.ts — confirmed dormant via repo-wide search.",
          },
        ],
      },
      {
        id: "app-auth-ratelimit",
        heading: "6.6 Rate limiting",
        blocks: [
          {
            type: "para",
            content:
              "authRateLimiter: 15 requests/15min on /register, /login, /verify-otp, /module1-broker-login, /module2-broker-login, /module1-resume-session. Global limiter: 200 requests/15min on all /api/* routes (note: auth routes are mounted at both /auth and /api/auth — only the /api/auth mount is additionally covered by the global limiter).",
          },
        ],
      },
    ],
  },

  // ── 7. SESSION MANAGEMENT ─────────────────────────────────────────────────
  {
    id: "app-session",
    heading: "7 — Session Management / Lifecycle",
    blocks: [
      {
        type: "table",
        headers: ["Endpoint", "Auth required?", "Purpose"],
        rows: [
          ["POST /auth/module1-broker-login", "App JWT", "Full credentialed Zebu login (section 6.4). Issues moduleToken."],
          ["POST /auth/module1-resume-session", "App JWT, no broker credentials", "Reconnects the backend's Zebu WebSocket from a Redis-persisted session (module1:broker-session, 8h TTL) without re-running QuickAuth. Returns \"already-live\" | \"resumed\" | \"no-session\"."],
          ["POST /auth/logout", "App JWT", "Blacklists the JWT AND unconditionally calls stopDataFeed() — application logout always disconnects the Module 1 broker feed too."],
        ],
      },
      {
        type: "fields",
        fields: [
          {
            label: "Frontend resume trigger",
            text: "ModuleWorkspace.tsx's useResumeModule1Session hook fires exactly once, only when module1Token was already present on the component's very first render (a genuinely restored session, e.g. page reload) — never for a token just set by a fresh login within the same mount.",
          },
          {
            label: "\"Switch credentials\"",
            text: "ModuleSelection.tsx:210-222 runs useStore.setState({ module1Token: null }) directly — this clears the in-memory Zustand state but does NOT call setModule1Token(null), so it does not remove the m1_token key from sessionStorage. Since the store's initial state only reads sessionStorage once at module load, a reload before completing a new login would resurface the old token.",
          },
          {
            label: "No dedicated broker-only logout",
            text: "Confirmed by grep of routes/auth.ts and controllers/brokerAuth.ts — no endpoint disconnects Zebu without also blacklisting the app JWT via /auth/logout.",
          },
          {
            label: "Session expiry detection",
            text: "zebuMarketDataClient.ts pattern-matches the Zebu WS connection-ack text (isSessionExpiredMessage: matches emsg/s against \"session expired\", \"invalid session\", \"token expired\", \"susertoken\", \"not_ok\", \"login\", \"unauthorized\", \"invalid user\") and invokes onSessionExpired() instead of the generic reconnect path.",
          },
          {
            label: "Reconnect backoff",
            text: "handleFeedDisconnect (dataFeed.ts): delay = 4000 * 2^attempts (4s/8s/16s/32s/64s), MAX_RECONNECT_ATTEMPTS = 5. Refreshes NFO instrument tokens before each attempt. After exhausting attempts, clears stored credentials and broadcasts broker-disconnected.",
          },
        ],
      },
    ],
  },

  // ── 8. API REFERENCE ──────────────────────────────────────────────────────
  {
    id: "app-api",
    heading: "8 — API Reference",
    subsections: [
      {
        id: "app-api-market",
        heading: "8.1 Market data (routes/market.ts) — all require authenticate unless noted",
        blocks: [
          {
            type: "endpoints",
            endpoints: [
              { method: "GET", path: "/api/watchlist", response: "{symbols, columnPrefs}", purpose: "Per-user saved watchlist; in-memory fallback if Mongo down" },
              { method: "PUT", path: "/api/watchlist", params: "body: WatchlistSchema (zod)", response: "{message, symbols, columnPrefs}", purpose: "Update watchlist" },
              { method: "GET", path: "/api/market/spot/:symbol", response: "{symbol, ltp, timestamp} or 404", purpose: "Latest cached spot price" },
              { method: "GET", path: "/api/market/futures/:symbol", params: "?timeframe (default 5m)", response: "{symbol, ltp, activeCandle}", purpose: "Latest price + forming candle (incl. running volume, used for live VWAP)" },
              { method: "GET", path: "/api/market/ohlc/:symbol/:tf", params: "?limit (default 400)", response: "OhlcBar[]", purpose: "Session-scoped historical bars, 3-step fallback (section 9)" },
              { method: "GET", path: "/api/market/ohlc-history/:symbol/:tf", params: "?date= or ?from=&to=", response: "OhlcBar[]", purpose: "Arbitrary-range historical bars (custom timeframe mode)" },
              { method: "GET", path: "/api/market/ohlc-warmup/:symbol/:tf", params: "?count (default 200)", response: "OhlcBar[]", purpose: "Bars strictly before today's session — EMA200 seed only" },
              { method: "GET", path: "/api/market/pivots/:symbol/:tf", response: "{symbol, timeframe, classic, camarilla, fibonacci}", purpose: "Backend pivot system — dormant for Module 1's own UI" },
              { method: "GET", path: "/api/market/option-chain/:index", response: "{index, spotPrice, atmStrike, strikes[]}", purpose: "Synthetic +/-5-strike chain around ATM" },
              { method: "POST", path: "/api/market/custom-timeframe", params: "body {timeframe}", response: "{message, timeframe, minutes}", purpose: "Registers a custom aggregation timeframe" },
              { method: "GET", path: "/api/market/status", response: "{status:\"LIVE\"|\"CLOSED\", zebuConnected}", purpose: "Time-based market-hours check + live broker-connectivity flag" },
              { method: "GET", path: "/api/module/status", response: "{module1, module2}", purpose: "Coarse per-module connection status" },
              { method: "GET", path: "/module1/indicators/:symbol", params: "?timeframe, ?method", response: "Indicator object or 404", purpose: "Dormant (section 1)" },
              { method: "GET", path: "/module1/latest-oi", auth: "none", response: "OI snapshot", purpose: "Current OI matrix row" },
              { method: "GET", path: "/module1/expiries/:symbol", response: "{symbol, expiries:[{id, expiry}]}", purpose: "Real NFO-master expiry list" },
              { method: "GET", path: "/module1/strikes/:symbol/:expiryId", response: "{symbol, expiryId, strikes:[{value}]}", purpose: "Real NFO-master strike list" },
            ],
          },
        ],
      },
      {
        id: "app-api-auth",
        heading: "8.2 Authentication (routes/auth.ts)",
        blocks: [
          {
            type: "endpoints",
            endpoints: [
              { method: "POST", path: "/auth/register", purpose: "Disabled (403) when env-var auth mode is active" },
              { method: "POST", path: "/auth/login", purpose: "Rate-limited; may return {otpRequired, loginToken} instead of a session" },
              { method: "POST", path: "/auth/verify-otp", purpose: "Exchanges {loginToken, otp} for a real session" },
              { method: "POST", path: "/auth/refresh", purpose: "Cookie-based; rotates both tokens" },
              { method: "POST", path: "/auth/logout", auth: "App JWT", purpose: "Blacklists JWT + calls stopDataFeed()" },
              { method: "GET", path: "/auth/me", auth: "App JWT", purpose: "Current user" },
              { method: "POST", path: "/auth/module1-broker-login", purpose: "Rate-limited; issues moduleToken (section 6.4)" },
              { method: "POST", path: "/auth/module1-resume-session", purpose: "Rate-limited; no credentials required (section 7)" },
              { method: "POST", path: "/auth/module2-broker-login", purpose: "Module 2 — not part of Module 1" },
              { method: "GET", path: "/api/module1/zebu/oauth/callback, /status", purpose: "Dormant (section 6.5)" },
            ],
          },
        ],
      },
    ],
  },

  // ── 9. WEBSOCKET FLOW ─────────────────────────────────────────────────────
  {
    id: "app-websocket",
    heading: "9 — WebSocket Lifecycle",
    subsections: [
      {
        id: "app-ws-broker",
        heading: "9.1 Backend <-> Zebu broker (raw WebSocket, Noren protocol)",
        blocks: [
          {
            type: "steps",
            steps: [
              { n: 1, text: "Open WS to Zebu's feed endpoint (ZEBU_WS_URL / CLIENT_API_URL)." },
              { n: 2, text: "Send {t:\"c\", uid, actid, susertoken, source} on open." },
              { n: 3, text: "Wait for {t:\"ck\", s:\"OK\"} ack — subscription is NOT sent before this ack (sending early previously caused a live->reconnecting loop, fixed and documented in-code)." },
              { n: 4, text: "onConnected() fires only after the ack + subscribe send — this is what flips the frontend out of \"connecting\"." },
              { n: 5, text: "Ticks are deltas: only changed fields are sent. A lastKnownLtp map fills in the last-seen price so an OI-only delta still produces a usable tick rather than being dropped (a delta with no price ever seen for that symbol is dropped)." },
              { n: 6, text: "Runtime subscription: subscribeTokens() adds instruments to an already-open connection via a new {t:\"t\", k:...} frame without reconnecting; requests made before the initial ack queue in pendingExtra and flush right after." },
            ],
          },
          {
            type: "para",
            content:
              "Heartbeat: h message type is logged only, no explicit ping/pong handling beyond that. Per-minute stats logging (\"Feed:STATS\") every 60s: message count, tick count, instrument count, last tick.",
          },
        ],
      },
      {
        id: "app-ws-frontend",
        heading: "9.2 Backend <-> Frontend (Socket.IO)",
        blocks: [
          {
            type: "table",
            headers: ["Event", "Direction", "Notes"],
            rows: [
              ["tick", "server -> client", "Raw LTP relay, to market:<symbol> room"],
              ["market_ready", "server -> client", "Fires once, first valid NIFTY-FUT tick (ltp>0) this session; late joiners get an immediate replay"],
              ["latest-oi", "server -> client", "Throttled to 250ms minimum interval (OI_EMIT_MIN_INTERVAL_MS)"],
              ["indicators", "server -> client", "Throttled 500ms/room (INDICATOR_EVAL_MIN_INTERVAL_MS); dormant — no current UI joins this room"],
              ["pivots", "server -> client", "Dormant, same reason"],
              ["broker_status", "server -> client", "Carries moduleId so Module 1/2 status changes never overwrite each other"],
              ["join:symbol / leave:symbol", "client -> server", "market:<symbol> room, raw tick relay"],
              ["subscribe:options", "client -> server", "Resolves {instrument, expiry, callStrike, putStrike, type} to exact NFO tokens and runtime-subscribes them on the live broker connection"],
              ["join:indicators / leave:indicators", "client -> server", "indicators:<symbol>:<tf>:<method> room; dormant"],
              ["join:tracker / leave:tracker", "client -> server", "Module 2 option-tracker rooms"],
            ],
          },
          {
            type: "para",
            content:
              "Auth: socket.handshake.auth.token / query.token, verified via verifyAccessToken (the application JWT, not the module token); connection rejected if missing/invalid. Frontend client config: reconnectionAttempts:10, reconnectionDelay:3000ms (useSocket.ts) — layered on top of the backend's own broker-level reconnect (section 7).",
          },
          {
            type: "note",
            content:
              "resetMarketReady() clears the market_ready latch on every new broker connection so a reconnecting client doesn't get a false-positive replay from a stale previous session before real ticks arrive.",
          },
        ],
      },
    ],
  },

  // ── 10. MARKET DATA PIPELINE ──────────────────────────────────────────────
  {
    id: "app-pipeline",
    heading: "10 — Market Data Pipeline",
    subsections: [
      {
        id: "app-pipe-aggregation",
        heading: "10.1 OHLC aggregation (ohlcAggregator.ts)",
        blocks: [
          {
            type: "bullets",
            items: [
              "Every tick for a futures/spot/option symbol is aggregated into 12 timeframes simultaneously: 1m,2m,3m,5m,10m,15m,30m,45m,1h,2h,3h,4h.",
              "getBoundaryTime: timeframes < 60min align to fixed clock boundaries; >= 60min are explicitly anchored to 09:15 IST session open.",
              "A proactive setInterval every 1000ms force-finalizes any active candle whose boundary has passed even without a new tick (re-checks candle identity after the await to avoid a double-finalize race).",
              "finaliseCandle(): snapshots the candle, updates the in-memory finalizedCandlesCache[symbol][timeframe] (capped at 400 via .shift()), pushes onto persistQueue.",
              "drainPersistQueue(): a single serialized worker batches all queued candles into ONE FuturesOHLC.bulkWrite() upsert ({ordered:false}), keyed on (symbol, timeframe, bar_time); retries individual E11000 duplicate-key races. Prunes bars older than 45 days once per (symbol,timeframe) per session day. Fires onCandleFinalized serially per candle (triggers pivotService.recalculatePivots).",
              "This batching replaced a prior per-candle awaited-Mongo-op design that caused OOM incidents under tick bursts (per in-code reference to a prior validation report).",
            ],
          },
        ],
      },
      {
        id: "app-pipe-fallback",
        heading: "10.2 Historical read fallback (getOHLCBars, controllers/market.ts)",
        blocks: [
          {
            type: "steps",
            steps: [
              { n: 1, text: "Query FuturesOHLC for {symbol, timeframe, bar_time >= sessionOpen}, sorted descending, deduped by exact bar_time, limited to fetchLimit (default 400), reversed to ascending." },
              { n: 2, text: "If step 1 returned zero bars (empty collection OR a caught Mongo error) -> fall back to getCachedOHLCBars(symbol, tf, fetchLimit), the in-memory finalized-candle cache (also session-scoped via getTodaySessionOpenMs())." },
              { n: 3, text: "Always additionally checks getActiveCandle(symbol, tf): seeds it as the sole element if bars is still empty, or appends it if newer than the last returned bar. Guarantees the matrix has at least the currently-forming candle even before any candle has closed this session." },
            ],
          },
        ],
      },
      {
        id: "app-pipe-instruments",
        heading: "10.3 Instrument tokens (instrumentTokenService.ts)",
        blocks: [
          {
            type: "bullets",
            items: [
              "Downloads Zebu's NFO_symbols.txt.zip on every broker login, cached CACHE_TTL_MS = 4h.",
              "Filters to NSE_INDEX_SYMBOLS = [NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY] x FUTIDX/OPTIDX only — BSE instruments (SENSEX, BANKEX) are not in this NSE-only master despite appearing in the frontend's static Symbol list.",
              "ATM seed priority: ltp:NIFTY-SPOT -> ltp:NIFTY-FUT (basis-adjusted proxy) -> hardcoded fallback. atmIsReliable flag distinguishes a real-price seed from the fallback.",
              "Strike radius: +/-1000 around ATM when the seed is reliable, widened to +/-5000 when it's a stale fallback.",
              "getAvailableExpiries(symbol) / getAvailableStrikes(symbol, expiryIso) power the Module 1 Expiry/Strike dropdown endpoints directly off cached NFO rows — no synthetic generation.",
              "resolveOptionInstrument() / recomputeOptionBandFromLivePrice() power on-demand/self-healing subscription (socketService.ts's subscribe:options handler, and dataFeed.ts's ATM self-heal on the first genuine live tick if it started from a stale seed).",
            ],
          },
        ],
      },
      {
        id: "app-pipe-oi",
        heading: "10.4 module1OiService.ts — OI matrix",
        blocks: [
          {
            type: "bullets",
            items: [
              "Purely in-memory, tick-driven; not persisted to MongoDB (only a Redis-mirrored oi:NIFTY-FUT scalar for restart warm-up).",
              "createOrUpdateLatestRow buckets by whole second; c_tl/p_tl = sum of OI across all currently-tracked CE/PE strike symbols; c_mn/p_mn = running average; c_hig/c_low/p_hig/p_low = running max/min; c_buy/c_sell/p_buy/p_sell/f_buy/f_sell = positive/negative delta vs the previous row (change-in-OI, not real traded volume).",
              "Row history capped at 240 rows (per-second buckets -> a rolling ~4-minute window).",
              "callSignal threshold cascade (500-lot threshold) -> STRONG_BULL/MILD_BULL/STRONG_BEAR/MILD_BEAR/DIVERGENCE/NEUTRAL. putSignal is always the mechanical inverse via a fixed lookup table (PUT_INVERSE), never independently computed from put-side deltas.",
              "dataSource: \"LIVE_MARKET_API\"|\"SIMULATOR\" — \"SIMULATOR\" only means not currently broker-backed; values freeze at last-known rather than being replaced with generated numbers. No literal buildFallbackOiMetrics() function exists — the equivalent behavior is getLatestModule1OiMetrics() synthesizing an all-zero row via createOrUpdateLatestRow(new Date()) when nothing has arrived yet.",
              "resetModule1OiMaps() clears both OI maps + latestFuturesOi on every login/reconnect, specifically so stale option OI from an expired weekly series can never leak into a new session (a past incident froze OI at stale values from an expired contract).",
              "Option-side OI (CE/PE maps) is deliberately never warmed from Redis at startup — only latestFuturesOi is (from oi:NIFTY-FUT) — for the same stale-expired-contract reason.",
            ],
          },
        ],
      },
      {
        id: "app-pipe-pivot-backend",
        heading: "10.5 Backend pivot service (pivotService.ts, utils/pivotEngine.ts)",
        blocks: [
          {
            type: "table",
            headers: ["Method", "Formula"],
            rows: [
              ["Classic", "P=(H+L+C)/3; R1=2P-L,S1=2P-H; R2=P+(H-L),S2=P-(H-L); R3=H+2(P-L),S3=L-2(H-P)"],
              ["Camarilla", "range=H-L; R4/S4=C+/-range*1.1/2; R3/S3=C+/-range*1.1/4; R2/S2=C+/-range*1.1/6; R1/S1=C+/-range*1.1/12 (no P value returned)"],
              ["Fibonacci", "P=(H+L+C)/3; R1/S1=P+/-0.382*range; R2/S2=P+/-0.618*range; R3/S3=P+/-1.0*range"],
            ],
          },
          {
            type: "para",
            content:
              "initPivotService() registers onCandleFinalized so every finalized candle (any timeframe, any symbol) triggers recalculatePivots(). getPivotLevels() resolves in 3 tiers: in-memory latestPivots cache -> latest PivotLevels Mongo document -> compute on the fly from the latest finalized FuturesOHLC candle's H/L/C (also persists/caches the result). A final fallback if even that candle doesn't exist: reads live cached LTP (hardcoded 22100 if unavailable) and synthesizes an artificial H/L/C as {currentPrice+50, currentPrice-50, currentPrice} — a genuine \"never return null\" synthetic fallback, not real historical-range-derived pivots.",
          },
          {
            type: "para",
            content:
              "getCallIndicator/getPutIndicator (pivotEngine.ts): divergence check first (div = |spot-ltp|/spot*100; if >0.5% -> DIVERGENCE_WARNING/SENTIMENT_ALERT, short-circuiting), otherwise a 6-branch cascade against P/R1/S1 (near-threshold bands R1*0.998/S1*1.002, equality tolerance |ltp-P|/P<0.001) producing one of 7 states per side. evaluateIndicators() ties hasDivergenceWarning to the same 0.5% threshold, so they're always in sync by construction.",
          },
        ],
      },
    ],
  },

  // ── 11. ENVIRONMENT VARIABLES ─────────────────────────────────────────────
  {
    id: "app-env",
    heading: "11 — Environment Variables",
    subsections: [
      {
        id: "app-env-backend",
        heading: "11.1 Backend (apps/backend/.env.example)",
        blocks: [
          {
            type: "table",
            headers: ["Variable", "Purpose"],
            rows: [
              ["NODE_ENV, PORT, FRONTEND_URL", "App/runtime basics; FRONTEND_URL also drives CORS"],
              ["JWT_SECRET, JWT_REFRESH_SECRET", "Must be strong random secrets — app refuses to start in production with an insecure/placeholder value"],
              ["MONGODB_URI", "MongoDB connection string"],
              ["UPSTASH_REDIS_REST_URL / _TOKEN (or REDIS_URL)", "Redis backend — falls back to an in-process mock if neither reachable"],
              ["RESEND_API_KEY, EMAIL_FROM", "Transactional email (not part of Module 1's core flow)"],
              ["ZEBU_USER_ID, ZEBU_API_KEY, ZEBU_VENDOR_CODE, ZEBU_TOTP_SECRET", "Zebu broker credentials/config"],
              ["ZEBU_NIFTY_FUT_TOKEN, ZEBU_NIFTY_SPOT_TOKEN", "Stable instrument tokens"],
              ["ZEBU_NIFTY_CE_TOKENS, ZEBU_NIFTY_PE_TOKENS", "Fallback only — real tokens auto-downloaded from Zebu's NFO master on every login"],
              ["APP_OTP_ENABLED, APP_LOGIN_OTP", "App-level login OTP gate"],
              ["APP_LOGIN_USERNAME, APP_LOGIN_PASSWORD", "Fixed single-tenant login credentials, bypassing the MongoDB User collection"],
            ],
          },
        ],
      },
      {
        id: "app-env-frontend",
        heading: "11.2 Frontend (apps/frontend/.env)",
        blocks: [
          {
            type: "table",
            headers: ["Variable", "Purpose"],
            rows: [
              ["VITE_API_URL", "Backend REST base URL"],
              ["VITE_SOCKET_URL", "Backend Socket.IO URL (defaults to VITE_API_URL if unset)"],
              ["VITE_APP_OTP_ENABLED", "Must match the backend's APP_OTP_ENABLED for the OTP UI step to appear"],
            ],
          },
        ],
      },
    ],
  },

  // ── 12. DEPLOYMENT ────────────────────────────────────────────────────────
  {
    id: "app-deployment",
    heading: "12 — Deployment",
    blocks: [
      {
        type: "bullets",
        items: [
          "docker-compose.yml provisions 4 services: mongodb (mongo:7.0-jammy), redis (redis:7.2-alpine), backend (apps/backend/Dockerfile), frontend (apps/frontend/Dockerfile).",
          "Backend scripts: npm run build (tsc), npm run start (node dist/server.js), npm run dev (ts-node-dev --respawn --transpile-only).",
          "Frontend scripts: npm run dev (vite), npm run build (tsc && vite build), npm run test (vitest run).",
          "render.yaml exists at repo root for Render.com deployment.",
          "Monorepo managed via npm workspaces (packages/*, apps/*); packages/shared holds Zod schemas/types consumed by both apps.",
        ],
      },
    ],
  },

  // ── 13. SECURITY ──────────────────────────────────────────────────────────
  {
    id: "app-security",
    heading: "13 — Security",
    blocks: [
      {
        type: "bullets",
        items: [
          "JWT secrets: resolveSecret() refuses insecure/placeholder values in production (fatal exit via runStartupCheck at boot, and again defensively at first token operation).",
          "Refresh tokens: httpOnly, sameSite:\"strict\", secure (prod only) cookie, 7-day maxAge — never exposed to client-side JS.",
          "Logout blacklists the access token both durably (Redis, TTL = remaining token lifetime) and in-process (instant same-process revocation).",
          "helmet() applied server-wide; CORS restricted to FRONTEND_URL with credentials:true.",
          "Rate limiting: 15/15min on auth-sensitive routes, 200/15min global on /api/*.",
          "No user enumeration: inactive users get the same generic \"Invalid username or password\" message as a wrong password.",
          "Broker credentials (Zebu userId/password) are submitted directly to the backend per login — not stored client-side beyond the resulting moduleToken in sessionStorage.",
        ],
      },
      {
        type: "warn",
        content:
          "\"Switch credentials\" clears the module token from in-memory Zustand state only, not sessionStorage (section 7) — not a security hole (the JWT still must be accepted by the backend) but a real, observable session-state quirk worth fixing if it causes confusion.",
      },
    ],
  },

  // ── 14. PERFORMANCE OPTIMIZATIONS ─────────────────────────────────────────
  {
    id: "app-performance",
    heading: "14 — Performance Optimizations",
    subsections: [
      {
        id: "app-perf-backend",
        heading: "14.1 Backend",
        blocks: [
          {
            type: "bullets",
            items: [
              "Batched bulkWrite candle persistence off the tick hot path (fixed a prior OOM-causing per-candle-awaited-write design).",
              "In-memory finalized-candle cache (400-entry cap per symbol/timeframe) serves normal reads without hitting MongoDB.",
              "In-process Redis mirror bounds Upstash's metered command usage — only 3 keys ever durably persisted, at most once/60s each.",
              "Negative caching (60s) of confirmed-absent Redis keys.",
              "latest-oi/indicators broadcasts throttled (250ms/500ms) rather than emitted on every single tick.",
              "monitoringService.getMonitoringStatus() reads memory-first (avoids ~100K Redis commands/month for data the tick pipeline already holds in-process).",
            ],
          },
        ],
      },
      {
        id: "app-perf-frontend",
        heading: "14.2 Frontend",
        blocks: [
          {
            type: "bullets",
            items: [
              "getVisibleColumns/getCellValue are pure functions shared by the live table and Excel export — no duplicated formatting logic to drift out of sync.",
              "React Query staleTime: Infinity on expiry/strike lookups — fetched once per unique selection.",
              "Dev-only \"frozen column\" detector (Worksheet.tsx) — warns if any column (excluding datetime/smc/fib/vwap/ema) shows an identical value across every visible row, catching data-pipeline regressions before QA.",
              "table-layout:fixed with an explicit <colgroup> avoids column-width reflow as rows stream in.",
            ],
          },
        ],
      },
      {
        id: "app-perf-warmup",
        heading: "14.3 EMA / VWAP warm-up pipeline",
        blocks: [
          {
            type: "para",
            content:
              "GET /api/market/ohlc-warmup/NIFTY-SPOT/:tf?count=200 fetches up to 200 candles strictly before today's session open, purely to seed EMA20/EMA200 continuation (prevEmaRef/prevEma200Ref) so a value can exist from the start of the trading session. This data is never turned into worksheet rows. VWAP has no warm-up — it is deliberately session-cumulative only, resetting to zero on every (re)generate, since it's a same-day reference by definition.",
          },
        ],
      },
    ],
  },

  // ── 15. DATA RETENTION ────────────────────────────────────────────────────
  {
    id: "app-retention",
    heading: "15 — Data Retention",
    blocks: [
      {
        type: "table",
        headers: ["Data", "Retention / TTL"],
        rows: [
          ["FuturesOHLC candles", "45 days (bar_time TTL index) — widened from an original 25h specifically to support EMA200 warm-up on higher timeframes"],
          ["In-memory finalized-candle cache", "400 entries per symbol/timeframe (not time-based)"],
          ["Persisted Redis LTP/OI keys", "25h (MARKET_TTL_SECONDS)"],
          ["JWT blacklist entries", "Remaining lifetime of the blacklisted token"],
          ["Persisted broker session (module1:broker-session)", "8h, matching moduleToken's lifetime"],
          ["PivotLevels documents", "No TTL — accumulates indefinitely"],
          ["SpotTicks", "24h TTL defined, but the collection is unused (no writers)"],
          ["Live worksheet display", "Always session-scoped (today's 09:15 IST open onward) regardless of underlying storage retention"],
        ],
      },
    ],
  },

  // ── 16. KNOWN LIMITATIONS ─────────────────────────────────────────────────
  {
    id: "app-limitations",
    heading: "16 — Known Limitations",
    blocks: [
      {
        type: "bullets",
        items: [
          "VWAP depends on a 500ms polling call to the backend's running-volume endpoint; if that call fails, VWAP silently keeps its last-known cumulative state rather than erroring.",
          "EMA200 needs 200 Spot closes; on coarser timeframes a single session may never accumulate that many candles even with warm-up, so EMA200 (and everything derived from it) can legitimately show \"-\" for extended periods.",
          "Hard broker + session dependency — no data without an active Zebu login; both the module JWT and the Redis-persisted broker session expire after 8h with no silent refresh.",
          "Several UI controls are implemented but hidden (Option Type selector, Generate/Reset, Custom timeframe) — see section 2.5.",
          "\"Remember Credentials\" checkbox on the Module 1 login form is a non-functional no-op.",
          "\"Switch credentials\" clears only the in-memory token, not sessionStorage (section 7/13).",
          "SMC is a simple nearest-reference-level indicator, not a Smart Money Concepts (BOS/CHoCH/FVG/Order Block/Liquidity/Premium-Discount) engine.",
          "The server-side pivot/indicator subsystem (pivotService.ts, /module1/indicators, indicators/pivots socket events) is fully built but never consumed by the current frontend.",
          "SpotTicks MongoDB model is defined but has no writers anywhere in the codebase.",
          "PivotLevels.timeframe enum (1m/3m/5m/custom) doesn't cover all 12 aggregated timeframes — pivot persistence silently fails validation for 15m/30m/45m/2h/3h/4h (still computes/caches correctly in-memory, just isn't saved to Mongo).",
          "BSE indices (SENSEX, BANKEX) and NIFTYNXT50 are selectable in the frontend's static Symbol list but have no backing NFO instrument-token data (NSE-only master).",
          "The backend pivot service's final fallback fabricates an artificial +/-50-point H/L/C range around the last known price when no real candle exists yet — not real historical-range-derived pivots.",
          "Inconsistent product branding across the UI (\"SYNERGY · Trading Dashboard\" / \"TradePro\" / \"Pivot Intelligence v1.0\" in different places) — cosmetic only.",
        ],
      },
    ],
  },

  // ── 17. TECHNICAL NOTES ───────────────────────────────────────────────────
  {
    id: "app-notes",
    heading: "17 — Technical Notes",
    blocks: [
      {
        type: "fields",
        fields: [
          {
            label: "Why candle persistence is batched",
            text: "An earlier design awaited a MongoDB write per finalized candle on the tick-processing hot path; under bursty tick volume this caused out-of-memory incidents. The current design queues finalized candles and drains them via a single batched bulkWrite on a separate cycle.",
          },
          {
            label: "Why option OI is never warmed from Redis on restart",
            text: "A past incident froze stale OI values from an already-expired weekly options series. The fix: futures OI IS warmed from Redis on startup, but Call/Put option OI maps are deliberately left empty on every login/reconnect and rebuilt purely from fresh live ticks within seconds — trading a few seconds of empty OI for a guarantee that stale/expired-contract data can never leak into a new session.",
          },
          {
            label: "Why the in-memory Redis mirror exists",
            text: "An earlier per-tick or per-500ms Redis write pattern burned through Upstash's metered command quota. The mirror makes the in-process Map authoritative for all live reads, and only durably persists 3 specific keys, at most once a minute each, purely for restart-warmup.",
          },
          {
            label: "Why hidden columns/controls were kept in code rather than deleted",
            text: "The EMA200/score/rating/signal/pivot columns and the Option Type/Generate/Reset/Custom-timeframe controls were explicitly hidden per client direction, but their calculation logic, store wiring, and column-order plumbing were deliberately left intact rather than removed — re-exposing any of them later is a UI-only change, not new development.",
          },
          {
            label: "Why there's no cross-instrument fallback for missing option data",
            text: "An earlier version silently substituted the Futures LTP into a Call/Put cell with no option tick yet, which could visually read as a real option price. The current row-builder renders a hard \"-\" instead — honest-missing over plausible-but-wrong.",
          },
          {
            label: "Why the Excel export shares code with the live table",
            text: "getVisibleColumns/getCellValue/rankingDisplayValue are the single source of truth for both, specifically so a discrepancy between \"what the screen shows\" and \"what the download contains\" is structurally impossible rather than something kept in sync by hand.",
          },
          {
            label: "Why EMA200 warm-up fetches prior-session candles",
            text: "EMA200 needs 200 prior closes before it can produce a value. Rather than requiring the user to wait through 200 live candles, the row-builder fetches up to 200 prior-session Spot candles purely as calculation seed data (never rendered), so EMA200 can already have a value at market open on fine timeframes.",
          },
          {
            label: "Why session resume exists as a separate endpoint from login",
            text: "A cached module1Token surviving a page reload only proves the frontend still thinks it's authenticated — the backend's live Zebu WebSocket is a separate, process-scoped resource that doesn't survive a backend restart. POST /auth/module1-resume-session reconnects that backend resource without forcing the user through a full credentialed re-login every time they reopen the tab.",
          },
        ],
      },
      {
        type: "bullets",
        items: [
          "Future improvement candidates (not implemented): re-exposing the hidden Option Type/Custom-timeframe/Generate-Reset controls; wiring the frontend to the existing-but-dormant server-side pivot/indicator subsystem instead of maintaining two parallel pivot implementations; extending PivotLevels.timeframe to cover all 12 aggregated timeframes; adding NFO instrument-token coverage for BSE indices (SENSEX/BANKEX) so they function, or removing them from the Symbol list if they won't be supported; fixing \"Switch credentials\" to also clear sessionStorage.",
        ],
      },
    ],
  },
];
