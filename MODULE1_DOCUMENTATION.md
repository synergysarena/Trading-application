# Module 1 — Complete Functional Documentation

**Scope:** Module 1 (the NIFTY options/futures/spot analytics worksheet), as it exists in the codebase today.
**Method:** every statement below was verified against the current source (file/line references given throughout). No content was carried forward from older Module 1 docs in this repo — those were treated only as a list of questions to re-verify, not as fact. Anything an older doc claimed that the code no longer does is *not* repeated here; anything the code does that no doc previously mentioned is included.
**Audience:** client, developers, future maintainers, QA.

---

## 1. Module 1 Overview

### 1.1 Purpose

Module 1 is a live, intraday analytics worksheet for one NIFTY-family index's derivatives. For a user‑selected Call (CE) and Put (PE) strike at a chosen expiry, it shows — per candle, side‑by‑side, updating live — the OHLC of:

1. The selected **Call option** premium
2. The selected **Put option** premium
3. The nearest active **Futures** contract (`NIFTY-FUT`)
4. The **Spot** index (`NIFTY-SPOT`)

and derives, for every candle: **MMA**, **TLA**, and **Ranking** (Call MMA vs Put MMA) for all four instruments, plus the indicator columns **SMC, FIB, RSI, EMA, VWAP**.

### 1.2 Goal

Answer, per timeframe and per candle: *"How is my chosen Call/Put strike behaving relative to the Future and Spot right now, and which side is currently dominant?"* Ranking is the module's headline output; RSI/EMA/VWAP/SMC/FIB are supporting context.

### 1.3 High-level workflow

1. User signs into the application (`Auth.tsx`, app-level JWT).
2. User opens Module 1 and, if no cached broker session exists, logs into their Zebu broker account (`Module1LoginPanel.tsx`).
3. The backend authenticates against Zebu (QuickAuth) and opens a live WebSocket feed to Zebu in the background.
4. The frontend socket joins the permanent `NIFTY-SPOT` / `NIFTY-FUT` rooms; live Spot/Future prices appear in the toolbar immediately.
5. The user picks Instrument → Symbol → Expiry → Call Strike → Put Strike. Once the selection is complete **and** the backend confirms live data (`market_ready`), the worksheet **auto‑generates** — no manual "Generate" click is needed in the current UI (the button exists in code but is hidden; see §16).
6. Historical (closed) candles are fetched and rendered as rows; the newest row is a "live" row that rebuilds every 500 ms from ticks until its time window closes, at which point a new live row starts.
7. Changing any selection (instrument, symbol, expiry, strike, timeframe) clears the table and restarts the flow.
8. At 15:45 IST on trading days, the worksheet auto-downloads an Excel snapshot once per day.

### 1.4 What Module 1 is *not*

- It is not a Smart Money Concepts (SMC) engine — the "SMC" column is a simple nearest-reference-level indicator, not BOS/CHoCH/FVG/Order Block/Liquidity/Premium-Discount logic (see §6.6).
- It does not currently expose an OI sidebar, ATM strike panel, alert panel, or price/volume charts — those existed in an earlier design iteration but are not part of the current `dashboard/index.tsx` component tree. The only OI-derived data surfaced today is the (hidden-by-default-but-toggleable) worksheet itself; there is no dedicated OI widget in the live UI.
- It does not let the user manually click "Generate"/"Reset", pick "Call only"/"Put only", or select a custom date range from the visible UI — those controls exist in the code (`display:"none"`) but are not reachable (see §16).

---

## 2. System Architecture

### 2.1 Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript, Vite, Zustand (state), TanStack React Query (expiry/strike fetch + status polling), Socket.IO client, `xlsx` (Excel export) |
| Backend | Node.js + Express + TypeScript, Socket.IO server, Mongoose (MongoDB), `ioredis`/Upstash REST (Redis), `ws` (raw WebSocket to the broker) |
| Database | MongoDB — candle storage (`FuturesOHLC`), pivot cache (`PivotLevels`), users/watchlists |
| Cache | Redis (Upstash REST, or `ioredis`, or an in-process `MockRedis` fallback if neither is reachable) — live LTP/OI mirror, JWT blacklist, custom-timeframe config, persisted broker session |
| Broker | Zebu (MYNT) — REST QuickAuth for login, raw WebSocket (Noren protocol) for the live tick feed |
| Realtime transport (backend↔frontend) | Socket.IO, JWT-authenticated |

Monorepo layout: `apps/backend`, `apps/frontend`, `packages/shared` (Zod schemas/types shared by both), managed as npm workspaces. `docker-compose.yml` provisions MongoDB 7.0 and Redis 7.2 containers alongside the two app containers for local/full-stack deployment.

### 2.2 Data flow (summary)

```
Zebu broker (WebSocket, Noren protocol)
   │  raw ticks (LTP deltas, OI)
   ▼
zebuMarketDataClient.ts  →  dataFeed.ts (processIncomingTick)
   │                             │
   │                             ├─→ redisWriteBuffer (in-memory mirror + throttled Redis persistence)
   │                             ├─→ module1OiService (per-second OI matrix, in-memory only)
   │                             └─→ ohlcAggregator.aggregateOHLC()  →  12 simultaneous timeframe candles
   │                                        │
   │                                        ├─→ in-memory finalized-candle cache (400/symbol/timeframe cap)
   │                                        └─→ batched MongoDB bulkWrite (FuturesOHLC, 45-day TTL)
   ▼
socketService.ts  — broadcasts `tick`, `market_ready`, `latest-oi`, `indicators`, `pivots`, `broker_status`
   ▼
Frontend useSocket.ts  →  useStore (global price/OI cache)  →  dashboard/index.tsx (row builder)
   │
   ├─→ REST: GET /api/market/ohlc/*, /ohlc-history/*, /ohlc-warmup/*, /market/status, /module1/expiries|strikes
   ▼
Worksheet.tsx (renders DashboardRow[] as the Excel-style table) → excelExport.ts (download)
```

### 2.3 Two independent pivot/indicator systems

The codebase contains **two separate, non-identical** pivot implementations that must not be conflated:

1. **Frontend, per-row, worksheet-facing** (`apps/frontend/src/calc/index.ts`, `pivotForBar`) — computes PP/R1‑R3/S1‑S3 from each row's own Future OHLC bar, client-side, using either a "4‑Bar" or "Classic" formula (user-selectable via the InfoBar toggle). Feeds the worksheet's (hidden) `pp/r1/r2/r3/s1/s2/s3` columns.
2. **Backend, server-side, symbol/timeframe-wide** (`apps/backend/src/services/pivotService.ts`, `apps/backend/src/utils/pivotEngine.ts`) — recomputes Classic/Camarilla/Fibonacci pivots on every finalized candle for every symbol/timeframe, persists them to MongoDB, and serves them via `GET /api/market/pivots/:symbol/:tf` and a `pivots` Socket.IO event. **This entire subsystem, along with its sibling `GET /module1/indicators/:symbol` endpoint and the `indicators` Socket.IO event, is fully implemented but never invoked by the current frontend** — nothing in the frontend calls `setModule1IndicatorRoom` or fetches `/module1/indicators` (confirmed by repo-wide search). Document it as present-but-dormant backend capability, not as a live feature.

---

## 3. Module Login & Session Management

Module 1 has **two independent authentication layers**: application-level login, and a separate per-module broker login. A user can be logged into the app but not into Module 1's broker session, and vice versa is not possible (Module 1 routes require app auth first).

### 3.1 Application-level login (`Auth.tsx` / `controllers/auth.ts`)

- `POST /auth/login` with `{username, password}` (validated by a shared Zod `LoginSchema`).
- Two backend credential sources: fixed env-var credentials (`APP_LOGIN_USERNAME`/`APP_LOGIN_PASSWORD`, for single-tenant deployments) take priority; otherwise a MongoDB `User` lookup with bcrypt comparison, falling back to an in-memory guest user if MongoDB is unreachable.
- **Optional OTP step**, gated by both a backend flag (`APP_OTP_ENABLED=true` + `APP_LOGIN_OTP=<code>`) and a frontend flag (`VITE_APP_OTP_ENABLED=true`). When enabled, `/auth/login` doesn't return a session yet — it returns a 5‑minute `loginToken`; the UI switches to an OTP screen; `POST /auth/verify-otp {loginToken, otp}` exchanges it for the real session.
- On success: `accessToken` (JWT, **8h** expiry) returned in the response body; `refreshToken` (JWT, **7 day** expiry) set as an `httpOnly`, `sameSite:"strict"` cookie.
- `POST /auth/refresh` (cookie-based) silently rotates both tokens; the frontend's `api.ts` calls this automatically on any `401` and retries the original request once.
- `POST /auth/logout` blacklists the current access token (both a Redis key and an in-process cache, so revocation is instant on the handling process) **and unconditionally calls `stopDataFeed()`** — logging out of the app also disconnects Module 1's live Zebu broker feed, even if the user was in Module 2 at the time.
- Registration (`POST /auth/register`) is disabled (403) whenever env-var auth is active.

### 3.2 Module 1 broker login (`Module1LoginPanel.tsx` / `controllers/brokerAuth.ts`)

This is the "Connect to Zebu Trading Account" screen shown whenever no cached Module 1 session token exists.

**Fields:** User ID (Zebu client ID), Password, "Factor 2 / TOTP" (PAN, DOB, or TOTP — whatever is registered with Zebu), and a "Remember Credentials" checkbox. There is **no client-side validation** (the form has `noValidate`); an empty submit is sent to the backend and its rejection is surfaced as the error message. **The "Remember Credentials" checkbox has no effect** — its state is held in local component state and never read anywhere else; document it as present-but-non-functional, not as a working feature.

**On submit** → `POST /auth/module1-broker-login {userId, password, factor2}`:
1. Backend hashes credentials for Zebu's QuickAuth API: `pwd = SHA256(password)`, `appkey = SHA256("${userId}|${MOD1_API_KEY}")` (this exact ordering is required — a different, more common Zebu-integration formula was explicitly ruled out in code comments as wrong).
2. POSTs `jData=<JSON>` (form-encoded, no `jKey` suffix) to Zebu's `QuickAuth` endpoint (15 s timeout).
3. On success, extracts `susertoken` and — **asynchronously, not awaited** — starts the backend's Zebu WebSocket feed (`startDataFeedWithCredentials`). The HTTP response to the login call does **not** wait for the feed to actually connect.
4. Issues a **`moduleToken`**: `jwt.sign({moduleId:"module1", userId, type:"module-access"}, JWT_SECRET, {expiresIn:"8h"})`.
5. Frontend stores it as `module1Token`, persisted to `sessionStorage` (`m1_token`). Presence of this token is what `ModuleWorkspace.tsx` uses to decide whether to show the login panel or the dashboard.

Because step 3 isn't awaited, a successful login response only proves Zebu accepted the credentials — it does *not* guarantee the live feed connected. If the WebSocket step fails afterward, the user sees "Connected" on the login screen but the dashboard will separately show `broker-disconnected`/`api-error` once it polls market status.

### 3.3 Session resume (reload / revisit)

`module1Token` surviving a page reload only means the **frontend** still considers itself authenticated — the actual Zebu WebSocket connection is a backend-process-scoped resource that does not survive a backend restart. `ModuleWorkspace.tsx`'s `useResumeModule1Session` hook fires **exactly once**, only when `module1Token` was *already present* on the component's very first render (i.e., a genuinely restored session, not a fresh login within the same page view): it calls `POST /auth/module1-resume-session` (no credentials) → backend's `resumeDataFeedFromPersistedSession()` reads a Redis-persisted `{userId, sessionToken}` (key `module1:broker-session`, 8h TTL, matching the JWT lifetime) and re-opens the Zebu WebSocket **without re-running QuickAuth**. If Zebu no longer accepts that `susertoken`, this fails gracefully — the dashboard's existing `StatusPanel` (`broker-disconnected`/`api-error`, both with a Retry button) handles it the same as any other feed failure.

### 3.4 Switch credentials

There is no "Switch Credentials" button inside `Module1LoginPanel.tsx` itself. It lives on the **Module Selection** screen (`ModuleSelection.tsx:210-222`): if a module token already exists, a "Switch credentials" link is shown under the launch button. Clicking it runs `useStore.setState({ module1Token: null })` and navigates back into the Module 1 route, which now shows the login panel again.

**Implementation nuance worth flagging:** this clears the token from the in-memory Zustand store only — it does **not** call `setModule1Token(null)` and therefore does **not** remove the `m1_token` key from `sessionStorage`. Since the store's initial state reads `sessionStorage.getItem("m1_token")` only once (at module load), this is invisible in the same browser tab/session; but if the tab were reloaded before a new login completed, the store would re-hydrate from the still-present `sessionStorage` value and the old session would resurface. Not a security issue (the JWT still has to be accepted by the backend), but a real, observable quirk.

### 3.5 Logout

There is **no dedicated "disconnect broker only" action for Module 1.** The only way to tear down the Zebu feed is the application-level logout (`POST /auth/logout`, available from both the module dashboard top bar and the Module Selection screen) — which also clears **both** `m1_token` and `m2_token` from `sessionStorage` and resets all Module 1/2 status flags, regardless of which module was open.

### 3.6 Session expiry (mid-session)

Detected by the backend inspecting Zebu's WebSocket connection-acknowledgement message for known session-expiry text patterns. On detection: the backend clears its in-memory Zebu client/credentials, stops auto-reconnecting (a `sessionExpired` flag suppresses further attempts), resets the Module 1 OI data source flag to `"SIMULATOR"`, and broadcasts a `session-expired` `broker_status` Socket.IO event. The frontend's `StatusPanel` then shows *"Broker Session Expired — please go to the login panel and reconnect"*; there is no automatic re-authentication — the user must submit their Zebu credentials again through `Module1LoginPanel`.

### 3.7 Broker reconnection

If the WebSocket drops unexpectedly (not a session expiry), the backend auto-reconnects with exponential backoff: **4s → 8s → 16s → 32s → 64s**, up to **5 attempts**, refreshing NFO instrument tokens before each attempt. Each attempt broadcasts a `reconnecting` status with an `"Attempt N/5"` detail string. After 5 failed attempts, stored credentials are cleared and a `broker-disconnected` status is broadcast — requiring the user to log in again.

### 3.8 Status indicators / online-offline states

`FeedStatus` (frontend `dashboard/store.ts`) is the single source of truth: `idle | connecting | live | interrupted | market-closed | auth-error | api-error | no-network | broker-disconnected | session-expired | reconnecting`. It's set from three places: (a) the initial `GET /api/market/status` check when generating, (b) network/timeout error handling in that same fetch, (c) the `broker_status` Socket.IO event and transport-level `disconnect` events. A full-screen `StatusPanel` overlay covers the worksheet for `market-closed / auth-error / session-expired / broker-disconnected / reconnecting / api-error / no-network / custom-pending`; the toolbar's small status pill shows a colored dot + label for every state, but with coarser granularity — `reconnecting`, `broker-disconnected`, and `session-expired` all collapse to a generic grey "Idle" pill even though the full-screen panel shows a specific message for each. This is existing behavior, not a bug to silently "fix."

### 3.9 Zebu OAuth callback (dormant, separate code path)

`GET /api/module1/zebu/oauth/callback` and `GET /api/module1/zebu/oauth/status` exist (`controllers/zebuOAuth.ts`) but are **not part of the live login flow**. The callback just caches an authorization code in memory and tells the caller the backend must be manually restarted to use it — this is an operational/manual procedure for a deployment mode where the backend authenticates to Zebu using only `.env` credentials, not the per-user credentialed login described in §3.2. It is not wired into any button or redirect in the UI.

---

## 4. Dashboard

The Module 1 screen (`Dashboard` in `apps/frontend/src/modules/dashboard/index.tsx`, rendered via `Module1.tsx`) is composed of, top to bottom:

### 4.1 InfoBar

A fixed 42px dark strip. Left: static "◆ SYNERGY · Trading Dashboard" title text. Right: a **PP** toggle — "4-Bar" / "Classic" — that switches which pivot-point formula the (hidden) PP/R1-R3/S1-S3 worksheet columns use (`setPivotMethod`, persisted to `localStorage` per user).

### 4.2 Configuration (ConfigRow)

A collapsible bar showing, left to right: live Spot price + up/down arrow, live Future price + up/down arrow, then the selection chain **Instrument → Symbol → Expiry Date → Call Strike → Put Strike**. Each dropdown is disabled until its parent is chosen; changing a parent clears its children. Expiry auto-selects the nearest valid expiry once the list loads. An invalid strike (no longer present after an expiry change) is automatically cleared.

Two things exist in the component but are **not visible in the current UI** (`style={{display:"none"}}`, per an explicit "hidden per client request" code comment):
- The **Option Type** selector (Call / Put / Call+Put) — the app is permanently locked to `"Call+Put"`.
- The **Generate** and **Reset** buttons, and the collapse-arrow button next to them.

The collapsed state (click the bar to toggle) shows a compact one-line summary: `SPOT <price> FUT <price> | <Instrument> › <Symbol> › <Expiry>`.

### 4.3 Timeframe / toolbar (TimeframeRow)

- **Timeframe pills:** `1m 2m 3m 5m 10m 15m 30m 45m` and, after a divider, `1h 2h 3h 4h`. A "📅 Custom" pill exists but is hidden (`display:"none"`) along with its entire date-range panel (interval selector + From/To datetime pickers + Apply/Clear) — reachable only if a developer removes the `display:"none"`.
- **Feed status pill** (see §3.8).
- **Download Excel** button — disabled when there are 0 rows; calls `exportModule1Excel(...)` directly (see §11).
- **Columns** button — opens a popover: a checkbox list of every toggleable column, grouped with dividers (Date & Time / Call / Put / Ranking / Future / Space / Spot / Indicators), each row draggable to reorder. A "Reset order" button appears once a custom order has been saved. Both hidden-columns and column-order are persisted to `localStorage`, scoped per logged-in user (`m1_cols_<userId>`, `m1_col_order_<userId>`).

### 4.4 Market status / worksheet area

Exactly one of two things renders below the toolbar:
- A full-screen **StatusPanel** (see §3.8) for `market-closed / auth-error / session-expired / broker-disconnected / reconnecting / api-error / no-network`, or a "Select a Date Range" prompt if `timeframe === "custom"` with no range applied yet (a state that is currently unreachable from the UI since the Custom pill is hidden).
- The **Worksheet** table (§5) — for every other feed status, including `idle`, `connecting`, `live`, and `interrupted`. The Worksheet has its own internal loading skeleton (animated shimmer rows) while `isLoading`, its own "No data yet" empty state, and a thin amber "⚠ Feed interrupted — reconnecting…" banner when `feedStatus === "interrupted"`.

### 4.5 Auto-generation (replaces the hidden Generate button)

`ConfigRow.tsx` runs an effect: once every required selection is made (`canGenerate`) **and** the backend has confirmed a live tick has been received (`marketDataReady`, set by the `market_ready` socket event) **and** the table isn't already generated, it calls `generate()` automatically. This is the actual mechanism that starts the worksheet — no user click required — and it re-arms itself (`autoGeneratedRef`) whenever the selection becomes incomplete again.

### 4.6 What's *not* present

There is no separate "Indicator Panel", "ATM Strike Panel", "Alert Panel", or price/volume chart component anywhere in the current dashboard tree — the entire UI is InfoBar + ConfigRow + TimeframeRow + Worksheet/StatusPanel. (An earlier design iteration had these; they are not part of the code today.)

---

## 5. Worksheet (Main Table)

`apps/frontend/src/modules/dashboard/Worksheet.tsx` renders one row per candle (chronological, oldest first, newest/live row last) as an Excel-style table with a two-row grouped header (group label, then column sub-label), sticky headers, a frozen Date & Time column, click‑drag range selection with Ctrl/Cmd‑C → tab-separated clipboard copy, and per-column resize handles.

### 5.1 Complete column registry

All columns are defined once in `ALL_COLS` and consumed identically by the live table and the Excel export, so the two are always in sync. Columns marked **hidden** are fully computed on every row but are never rendered and never appear in the Excel export (`INDICATOR_UI_HIDDEN` / `PIVOT_UI_HIDDEN` in `Worksheet.tsx:43-53`) — kept only so the underlying calculation pipeline and column-order mechanism stay wired for possible future re-exposure.

| id | Group | Label | Source | Format |
|---|---|---|---|---|
| `datetime` | Date & Time | Date & Time | `row.t` | `"DD Mon h:mm AM/PM"`, Asia/Kolkata, frozen column |
| `ce-o`/`ce-h`/`ce-l`/`ce-c` | Call | Open/High/Low/Close | `row.call` (CE OHLC bar) | Truncated integer, `en-IN` grouping; `—` if no data |
| `mma-c` | Call | Call MMA | `row.callMMA` | Same |
| `tla-c` | Call | Call TLA | `row.callTLA` | Same |
| `pe-o`/`pe-h`/`pe-l`/`pe-c` | Put | Open/High/Low/Close | `row.put` (PE OHLC bar) | Same as Call |
| `mma-p` | Put | Put MMA | `row.putMMA` | Same |
| `tla-p` | Put | Put TLA | `row.putTLA` | Same |
| `ranking` | Ranking | Ranking | `row.ranking` / `row.rankingWinner` | Truncated integer, `+`/`−` prefix vs previous row |
| `fut-o`/`fut-h`/`fut-l`/`fut-c` | Future | Open/High/Low/Close | `row.future` (NIFTY‑FUT OHLC) | Same |
| `fut-mma` | Future | Future MMA | `row.futureMMA` | Same |
| `fut-tla` | Future | Future TLA | `row.futureTLA` | Same |
| `space` | Space | *(blank)* | — | Always empty — a reserved spacer column, no data/logic |
| `spot-o`/`spot-h`/`spot-l`/`spot-c` | Spot | Open/High/Low/Close | `row.spot` (NIFTY‑SPOT OHLC) | Same |
| `spot-mma` | Spot | Spot MMA | `row.spotMMA` | Same |
| `spot-tla` | Spot | Spot TLA | `row.spotTLA` | Same |
| `smc` | Indicators | SMC | `row.smc` | Text label + value, e.g. `"SWH 25412.50"` |
| `fib` | Indicators | FIB | `row.fib` | Text label + value, e.g. `"61.8% 25380.10"` |
| `rsi` | Indicators | RSI | `row.rsi` | Truncated integer 0–100, or `—` |
| `ema` | Indicators | EMA | `row.emaScore` (**not** a raw EMA number) | `"CALL (+1)"` / `"PUT (-1)"` / `"NEUTRAL (0)"` |
| `vwap` | Indicators | VWAP | `row.vwap` | Truncated integer, or literal text `"VWAP Not Available"` |
| `ema200` **(hidden)** | Indicators | EMA200 | `row.ema200` | Truncated integer |
| `ema-score` **(hidden)** | Indicators | EMA Score | `row.emaScore` | −1 / 0 / +1 |
| `vwap-score` **(hidden)** | Indicators | VWAP Score | `row.vwapScore` | −1 / 0 / +1 |
| `total-score` **(hidden)** | Indicators | Total Score | `row.totalScore` | −2 … +2 |
| `rating` **(hidden)** | Indicators | Rating | `row.rating` | `Strong CALL / CALL / Neutral / PUT / Strong PUT` |
| `signal` **(hidden)** | Indicators | Signal | `row.signal` | `BUY CALL / WAIT / BUY PUT / STRONG BUY PUT` |
| `pp`/`r1`/`r2`/`r3`/`s1`/`s2`/`s3` **(hidden)** | Indicators | Pivot Points | `pivotForBar(pivotMethod, row.future)` | Computed on demand at render time, per row, per the InfoBar's 4‑Bar/Classic toggle |

**Type-based hiding** (independent of the above, and of the user-togglable Columns panel): if `type === "Call"`, all Put columns (`pe-*`, `mma-p`, `tla-p`) are removed; if `type === "Put"`, all Call columns are removed. Because the Option Type selector is hidden and the store defaults to `"Call+Put"` (§4.2), this branch is currently unreachable in the live UI — both sides always show.

### 5.2 Cell coloring

- **OHLC cells** (`ohlcColor`): High → solid green background, white text. Low → solid red background, white text. Close → green background if it equals the bar's high, red if it equals the low, light green ("bull" tint) if close > open, light red ("bear" tint) if close < open, plain white otherwise. Open → blue background, white text, unless it equals the high/low (then colored as that extreme).
- **MMA/TLA cells:** flat light-blue tint for Call, light-amber tint for Put — independent of value.
- **Ranking cell:** background always white; text is blue if `rankingWinner === "call"`, amber if `"put"`. Additionally, compared against the immediately preceding row, the text turns bold green with a `+` prefix if higher, bold red with a `−` prefix if lower, or default styling if flat/no prior row.
- Missing data (`NaN`/`null`) always renders as `—` and is never color-coded beyond the default.

### 5.3 SMC / Fibonacci inputs (see also §6.6)

Both are computed from a running **session high/low** of the Future series (never Call/Put), maintained incrementally: seeded from the historical bar loop, then extended live by folding in each finalized live bar's Future high/low. `SMC`'s four candidates are `SWH`/`SWL` (session high/low) and `PDH`/`PDL`. In the **historical** row builder, `PDH`/`PDL` are the *immediately preceding bar's* high/low (the very first bar of the session uses its own high/low) — not literally "previous day." In the **live** tick-updater, `PDH`/`PDL` are passed the *same* session-high/session-low values as `SWH`/`SWL`, so during live ticking the two label-pairs are numerically identical (redundant, but not a defect — just how the live path was wired).

### 5.4 Developer-only integrity check

A `useEffect` (dev builds only) scans every visible column's values across all current rows and logs a console warning + a red banner if a column (other than `datetime`, `smc`, `fib`, `vwap`, `ema` — which can legitimately repeat) shows the exact same value on every row, which historically indicated the row-builder had copied one static price into every row instead of using per-bar data.

### 5.5 Formula legend

The worksheet's status bar footer literally states, verbatim: *"MMA=(O+H+L−C)/4 · TLA=2×MMA−H · Ranking=max(CallMMA,PutMMA) · EMA=EMA20 vs EMA200 Spot signal · VWAP Σ(TP×Vol)/ΣVol Future · RSI Wilder(14)"*.

---

## 6. Indicator Section

### 6.1 SMC

**Purpose:** flag the nearest structurally-relevant price level to the current close/LTP.
**Formula:** among four candidates — Session High (`SWH`), Session Low (`SWL`), previous-bar High (`PDH`), previous-bar Low (`PDL`) — pick whichever has the smallest absolute distance to price; render as `"<LABEL> <value>"`.
**Data source:** Future OHLC series (session-cumulative high/low; previous bar's own high/low).
**Warm-up:** available from the very first row (falls back to that row's own high/low when there is no prior bar).
**Dependencies:** none beyond the Future bar series already used for RSI/session tracking.
**Edge cases:** during live ticking, `PDH`/`PDL` == `SWH`/`SWL` (§5.3). No fallback/placeholder text is defined for a truly empty session — in practice this can't happen because the row builder always seeds session-high/low from the first available bar.

**Important — what SMC is *not*:** there is no Break of Structure (BOS), Change of Character (CHoCH), Fair Value Gap (FVG), Order Block, Liquidity Sweep, or Premium/Discount-zone logic anywhere in this codebase. The "SMC" name refers only to the four-candidate nearest-level indicator described above. If genuine Smart Money Concepts analysis is required, it does not currently exist and would be new development, not a bug fix.

### 6.2 Fibonacci (FIB)

**Purpose:** show the nearest Fibonacci retracement level to the current close/LTP.
**Formula:** levels = `high − (high−low)×ratio` for ratios `[0.236, 0.382, 0.5, 0.618, 0.786]`; nearest to price wins; rendered as `"<pct>% <value>"`.
**Data source:** same session high/low (Future series) as SMC.
**Edge cases:** returns `null` (→ `—`) if `high <= low`.

### 6.3 RSI

**Purpose:** momentum oscillator, standard Wilder smoothing, period 14.
**Formula:** first 14 changes seed `avgGain`/`avgLoss` as a simple average; thereafter `avgGain = (avgGain×13 + gain)/14` (same for loss); `RSI = 100 − 100/(1+avgGain/avgLoss)`, or `100` if `avgLoss === 0`.
**Data source:** **Future closes only** — never option premiums, by explicit design (comment in `dashboard/index.tsx`: "RSI is always computed from Future closes — never option premiums").
**Warm-up:** null for the first 14 bars of whatever series is fed in; live continuation keeps a rolling 50-close buffer client-side.

### 6.4 EMA (the single visible "EMA" column)

**Important, per the client's own spec, verified in code:** the worksheet's **EMA** column does **not** show a raw EMA number. It shows the result of comparing EMA20 to EMA200 of the **Spot** close series: `"CALL (+1)"` if EMA20 > EMA200, `"PUT (-1)"` if EMA20 < EMA200, `"NEUTRAL (0)"` if equal, `—` if either isn't seeded yet. The underlying EMA20/EMA200 numeric values, and the score itself as a bare number, are computed every row but kept as **hidden** columns (`ema200`, `ema-score` — see §5.1), not separate visible columns.

- **EMA20 formula:** SMA-seeded (average of the first 20 closes), then `EMA = close×k + prevEMA×(1−k)`, `k = 2/21`.
- **EMA200 formula:** identical engine, `k = 2/201`, 200-period SMA seed.
- **Source:** Spot close (falls back to that bar's own close when a dedicated Spot bar is unavailable — the row builder never substitutes a different instrument's close).
- **Warm-up:** seeded from up to 200 **prior-session** Spot candles (`GET /api/market/ohlc-warmup/NIFTY-SPOT/:tf?count=200`), fetched purely to give EMA200 a value from the start of the trading session (not shown as worksheet rows). If fewer than 200 warm-up bars are available (a genuine limitation on coarser timeframes — see §17), EMA200 shows `—` until enough bars accumulate.
- **Live continuation:** each 500 ms tick provisionally recomputes EMA20/EMA200 against the forming bar's latest Spot price; on bar close, the continuation state (`prevEmaRef`/`prevEma200Ref`) is permanently rolled forward using that bar's final close.

### 6.5 VWAP

**Formula:** true volume-weighted VWAP, `Σ(TypicalPrice × Volume) / ΣVolume`, `TypicalPrice = (H+L+C)/3` — **not** a simple average of price.
**Source:** **Future bars only** (the tradable instrument with real broker-reported volume). NIFTY Spot is an index with no traded volume and is never used for VWAP.
**Reset:** cumulative for the current session/generate cycle only — resets to zero every time the worksheet is (re)generated.
**Live volume:** the raw ticks that reach the frontend carry LTP only, not volume, so the live row's running Future-bar volume is instead polled every 500 ms from the backend's authoritative forming-candle endpoint (`GET /api/market/futures/:symbol?timeframe=...` → `activeCandle.volume`), not re-derived from ticks client-side.
**Null vs `—`:** VWAP is `null` (rendered as the literal text `"VWAP Not Available"`, distinct from the generic `—`) until cumulative volume becomes greater than zero — it is never fabricated from unweighted price.

### 6.6 Indicator visibility summary

| Visible in UI/Excel | Computed but hidden |
|---|---|
| SMC, FIB, RSI, EMA (label), VWAP | EMA200, EMA Score, VWAP Score, Total Score, Rating, Signal, PP, R1‑R3, S1‑S3 |

---

## 7. Indicator Calculations (formula reference)

All formulas below are quoted from `apps/frontend/src/calc/index.ts` unless marked backend.

| Calculation | Formula | Notes |
|---|---|---|
| **MMA** | `(O + H + L + (−1×C)) / 4` | `MMA_CLOSE_SIGN = −1` is explicit in code as "as written by the client" — this makes MMA roughly half the price and lets TLA go negative, by design, not a bug. |
| **TLA** | `2×MMA − High` | Derived from the bar's own MMA + High, not re-derived independently. |
| **Ranking** | `max(CallMMA, PutMMA)`, tie → Call | If one side's option bar is entirely missing (`NaN`), the present side wins outright; if both are missing, ranking = 0 (never `NaN`/`undefined`). |
| **EMA(period)** | SMA-seeded, then `close×k + prevEMA×(1−k)`, `k=2/(period+1)` | Used at period 20 (visible EMA label) and 200 (hidden `ema200`). |
| **VWAP** | `Σ(((H+L+C)/3)×Volume) / ΣVolume` | Future bars only; session-cumulative; §6.5. |
| **RSI(14)** | Wilder smoothing (§6.3) | Future closes only. |
| **Fibonacci** | `high − (high−low)×ratio`, ratios `.236/.382/.5/.618/.786` | §6.2. |
| **Pivot Points ("4-Bar"/client)** | `PP=(O+H+L+C)/4`; `R1=2PP−L, R2=PP+(H−L), R3=H+2(PP−L)`; `S1=2PP−H, S2=PP−(H−L), S3=L−2(H−PP)` | Per-row, from that row's own Future bar. Hidden columns (§5.1). |
| **Pivot Points ("Classic")** | `PP=(H+L+C)/3`, same R/S derivation as above | Selected via the InfoBar 4-Bar/Classic toggle. |
| **EMA Score** | `compareScore(EMA20, EMA200)` → `+1 / −1 / 0 / null` | |
| **VWAP Score** | `compareScore(VWAP, EMA20)` → `+1 / −1 / 0 / null` | |
| **Total Score** | `EMA Score + VWAP Score` | `null` unless both scores exist; range `−2..+2`. |
| **Rating** | `+2→"Strong CALL", +1→"CALL", 0→"Neutral", −1→"PUT", −2→"Strong PUT"` | |
| **Signal** | `Strong CALL/CALL→"BUY CALL"`, `Neutral→"WAIT"`, `PUT→"BUY PUT"`, `Strong PUT→"STRONG BUY PUT"` | Intentionally asymmetric — Strong PUT gets its own distinct label; Strong CALL and CALL do not. |
| *(backend, dormant)* **Classic pivot** | `P=(H+L+C)/3; R1=2P−L,S1=2P−H; R2=P+(H−L),S2=P−(H−L); R3=H+2(P−L),S3=L−2(H−P)` | `pivotEngine.ts` — matches the frontend Classic formula exactly, but computed server-side per finalized candle for all symbols/timeframes; not consumed by the current UI. |
| *(backend, dormant)* **Camarilla pivot** | `range=H−L; R4/S4=C±range×1.1/2; R3/S3=C±range×1.1/4; R2/S2=C±range×1.1/6; R1/S1=C±range×1.1/12` | Backend-only, not surfaced anywhere in the frontend. |
| *(backend, dormant)* **Fibonacci pivot** | `P=(H+L+C)/3; R1/S1=P±0.382×range; R2/S2=P±0.618×range; R3/S3=P±1.0×range` | Backend-only. |

---

## 8. Market Data Pipeline

### 8.1 Broker connection

`zebuMarketDataClient.ts` opens a raw WebSocket to Zebu's Noren-protocol feed. Handshake: send `{t:"c", uid, actid, susertoken, source}` → wait for `{t:"ck", s:"OK"}` ack → **only then** send the subscribe frame (sending subscribe before the ack previously caused a live→reconnecting loop, per an in-code fix note). `onConnected()` — which flips the frontend out of "connecting" — fires only after this full sequence. Ticks are **deltas**: a message may carry only OI with no LTP; a `lastKnownLtp` map fills in the last-seen price so OI-only deltas still produce a usable tick rather than being dropped. Session expiry is detected by pattern-matching the connection-ack text.

### 8.2 Instruments subscribed

`NIFTY-SPOT` (fixed token) + the resolved Futures token + the resolved CE/PE option tokens for the user's selected strike/expiry. Additional instruments (e.g. a newly selected strike) can be subscribed onto an already-open connection at runtime without reconnecting.

### 8.3 OHLC aggregation

Every incoming tick for a futures/spot/option symbol is aggregated into **12 timeframes simultaneously**: `1m 2m 3m 5m 10m 15m 30m 45m 1h 2h 3h 4h`. Timeframes under 60 minutes bucket on fixed boundaries; 60-minute-and-above timeframes are explicitly anchored to the 09:15 IST session open so the first hourly+ bar always starts exactly at market open. A background 1‑second sweep force-finalizes any candle whose time window has passed even if no new tick arrived (keeps low-tick-rate instruments' candles from hanging open indefinitely).

Finalized candles are (a) kept in an in-memory cache (capped at 400 per symbol/timeframe) and (b) queued for a **batched** MongoDB `bulkWrite` upsert — this batching was a deliberate fix for an earlier per-candle-awaited-write design that caused out-of-memory incidents under tick bursts.

### 8.4 Historical fallback chain

`getOHLCBars` (`GET /api/market/ohlc/:symbol/:tf`) resolves data in three steps, so the worksheet is never left completely empty even moments after a server restart:
1. MongoDB, session-scoped (`bar_time >= today's 09:15 IST open`).
2. If that returns zero rows (empty collection or a Mongo error) → the in-memory finalized-candle cache.
3. Always additionally checks the currently-forming active candle and appends/seeds it if newer than the last returned bar.

### 8.5 Retention

`FuturesOHLC` documents carry a TTL index of **45 days** on `bar_time` — deliberately widened from an original 25-hour window specifically so higher timeframes (hourly+) retain enough history to seed EMA200 warm-up. Live worksheet reads stay session-scoped through explicit query filters elsewhere, so this longer retention never leaks stale prior-day rows into the table.

### 8.6 Redis / caching strategy

A three-tier Redis client (Upstash REST → `ioredis` → in-process `MockRedis`) backs an in-process "mirror" Map that is the **authoritative** live-value store (`readLive()` normally costs zero Redis round-trips). Only three keys are ever durably persisted back to Redis — `ltp:NIFTY-SPOT`, `ltp:NIFTY-FUT`, `oi:NIFTY-FUT` — at most once per 60 seconds each, purely so a restarted backend can warm up without waiting for the first tick; every persisted key carries a 25‑hour TTL.

### 8.7 Instrument tokens

`instrumentTokenService.ts` downloads Zebu's `NFO_symbols.txt.zip` instrument master on every broker login (cached 4h), filtered to NSE index F&O only: **NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY** (`FUTIDX`/`OPTIDX`). This is the same source the Module 1 Expiry/Strike dropdowns query — real instrument-master data, not a synthetic generator. ATM strike-band selection seeds from live Spot/Future price with a ±1000-point radius (widened to ±5000 if only a stale fallback price is available), and self-heals — re-subscribing the correct band — on the first genuine live tick of a session if it had started from a stale seed.

**Limitation:** BSE indices (SENSEX, BANKEX) and NIFTYNXT50 appear as selectable Symbols in the UI's static list (`tradingConfig.ts`) but have **no backing instrument-token data** — the NFO master this pipeline downloads is NSE-only, so selecting them will not produce live expiries/strikes/data.

### 8.8 Socket.IO events (backend → frontend, Module 1-relevant)

| Event | Trigger | Notes |
|---|---|---|
| `tick` | Every processed tick, to `market:<symbol>` room | Raw LTP relay |
| `market_ready` | First valid `NIFTY-FUT` tick (`ltp>0`) this session | Fires once; late joiners get an immediate replay |
| `latest-oi` | Every OI-bearing tick | Throttled to a 250ms minimum interval |
| `indicators` | Per active `indicators:<symbol>:<tf>:<method>` room | Throttled to 500ms/room; **dormant** — no current UI ever joins this room |
| `pivots` | On pivot recalculation | **Dormant**, same reason |
| `broker_status` | Connect / reconnect / disconnect / session-expiry | Carries `moduleId` so Module 2 (Aetram) status changes never overwrite Module 1's displayed status, and vice versa |

Client → server: `join:symbol`/`leave:symbol`, `subscribe:options` (resolves `{instrument, expiry, callStrike, putStrike, type}` to exact NFO tokens and subscribes them on the live broker connection — this is the mechanism that makes Call/Put OHLC populate for a newly-selected strike), `join:indicators`/`leave:indicators` (dormant, per above).

---

## 9. Historical Data

- **Closed-bar history:** `GET /api/market/ohlc/:symbol/:tf` (session-scoped) for the normal timeframe pills; `GET /api/market/ohlc-history/:symbol/:tf?from=&to=` for custom ranges (currently unreachable from the UI — §16).
- **EMA warm-up:** `GET /api/market/ohlc-warmup/NIFTY-SPOT/:tf?count=200` — up to 200 candles strictly **before** today's session open, fetched only to seed EMA20/EMA200 continuation; never rendered as worksheet rows.
- **Session filtering:** on the client, historical Future bars are filtered to `>= today's 09:15 IST session open` (or yesterday's, if the current time is before today's open) before being turned into rows.
- **Retention/TTL:** 45 days on `FuturesOHLC` (§8.5); no TTL at all on the backend `PivotLevels` collection (accumulates indefinitely — a real if minor difference worth knowing operationally).

---

## 10. WebSocket

Covered in detail in §8.8 (backend) — frontend side: `apps/frontend/src/hooks/useSocket.ts` connects with `auth:{token: accessToken}` (the **application** JWT, not the module token), `reconnectionAttempts:10`, `reconnectionDelay:3000ms` (Socket.IO's own client-side reconnect, layered on top of the backend's broker-level reconnect described in §3.7). On every connect/reconnect it re-joins `NIFTY-SPOT`/`NIFTY-FUT` (permanent), the currently-selected symbol, and re-emits `subscribe:options` for the active Call/Put strike selection so a reconnect doesn't silently drop option data. No explicit heartbeat handling beyond Socket.IO's own transport; connection loss is only reflected in the UI through `feedStatus` changes.

---

## 11. Export Features

`apps/frontend/src/modules/dashboard/excelExport.ts` builds an `.xlsx` workbook using the exact same `getVisibleColumns`/`getCellValue`/`rankingDisplayValue` functions the live table uses, so the exported file always matches what's on screen — same columns, same order, same text values, same 2-row grouped header (with merged group-label cells).

- **Hidden columns** (both user-hidden via the Columns panel, and the permanently-hidden indicator/pivot columns from §5.1) are excluded from the export, same as from the live table.
- **Filename:** `Module1_<SYMBOL>_<TimeframeLabel>_<YYYY-MM-DD>.xlsx`, date computed in IST from the first row's timestamp (e.g. `Module1_NIFTY_5Min_2026-07-15.xlsx`).
- **Manual trigger:** the "⬇ Download Excel" toolbar button (disabled when there are 0 rows).
- **Automatic end-of-day export:** a 60-second poll checks IST time; once it's ≥ 15:45 on a weekday, it exports once and sets a `localStorage` flag (`m1_eod_export_<userId>_<YYYY-MM-DD>`) so a page refresh later that same day doesn't trigger a second download.

---

## 12. Data Validation

| Situation | Behavior |
|---|---|
| No option tick yet this session | Call/Put OHLC cells render `—`; **never** falls back to another instrument's price |
| Future/Spot price older than 8 seconds (`FRESH_TTL_MS`) | That side's OHLC bar renders as fully missing (`—`) even though the raw last-known price still feeds Ranking/SMC/Fibonacci underneath |
| VWAP cumulative volume still zero | Renders literal text `"VWAP Not Available"` (distinct from generic `—`) |
| EMA20/EMA200 not yet seeded | `—` in warm-up state; the visible EMA column shows `—` until `emaScore` exists |
| Market closed (time-based check, Mon–Fri 09:00–15:45 IST) | Full-screen "Market Closed" panel, independent of actual broker connectivity |
| Broker not connected, user never logged into Module 1 | "Authentication Required" panel |
| Broker not connected, user **is** authenticated | "API Error" panel (distinguishes "never logged in" from "logged in but link down") |
| Zebu session expired mid-use | "Broker Session Expired" panel, no auto-retry |
| Network/timeout error on the history fetch | "No Internet Connection" or generic "API Error" panel, both with a Retry button |
| Zero rows generated | Worksheet's own "No data yet" empty state |

---

## 13. Performance Optimizations

**Backend:**
- Batched `bulkWrite` candle persistence off the tick hot path (replaced a prior per-candle awaited-write design that caused OOM under bursty ticks).
- In-memory finalized-candle cache (400-entry cap) serves normal reads without hitting MongoDB.
- In-process Redis "mirror" makes `readLive()` a zero-Redis-command hit in the common case; only 3 keys are ever durably persisted, at most once/60s each, specifically to bound Upstash's metered command usage.
- Negative caching of confirmed-absent Redis keys (60s) to avoid repeated lookups.
- `evaluateIndicators`/OI broadcasts are throttled (250ms/500ms — §8.8) rather than computed on every single tick.
- One-time startup dedupe (`ensureUniqueCandleIndex`) removes any pre-existing duplicate `(symbol,timeframe,bar_time)` rows before enforcing the unique index.

**Frontend:**
- `getVisibleColumns`/`getCellValue` are pure functions shared by the live table and Excel export — no duplicated formatting logic to drift out of sync.
- React Query's `staleTime: Infinity` on expiry/strike lookups — fetched once per unique selection, never silently re-fetched.
- Dev-only "frozen column" detector catches data-pipeline regressions (a column stuck at one repeated value) before they reach QA.
- `table-layout:fixed` with an explicit `<colgroup>` avoids column-width reflow as rows stream in.

---

## 14. API Reference

All routes below require the application `authenticate` middleware (Bearer JWT) unless noted otherwise.

### 14.1 Market data (`apps/backend/src/routes/market.ts`)

| Method | Path | Params | Response (shape) | Purpose |
|---|---|---|---|---|
| GET | `/api/watchlist` | — | `{symbols, columnPrefs}` | Per-user saved watchlist (falls back to an in-memory guest map if Mongo is down) |
| PUT | `/api/watchlist` | body: Zod `WatchlistSchema` | `{message, symbols, columnPrefs}` | Update watchlist |
| GET | `/api/market/spot/:symbol` | — | `{symbol, ltp, timestamp}` or 404 | Latest cached spot price |
| GET | `/api/market/futures/:symbol` | `?timeframe` (default `5m`) | `{symbol, ltp, activeCandle}` | Latest price + the currently-forming candle (incl. running volume, used for live VWAP) |
| GET | `/api/market/ohlc/:symbol/:tf` | `?limit` (default 400) | `OhlcBar[]` | Session-scoped historical bars, 3-step fallback (§8.4) |
| GET | `/api/market/ohlc-history/:symbol/:tf` | `?date=` or `?from=&to=` | `OhlcBar[]` | Arbitrary-range historical bars (custom timeframe mode) |
| GET | `/api/market/ohlc-warmup/:symbol/:tf` | `?count` (default 200) | `OhlcBar[]` | Bars strictly before today's session — EMA200 seed only |
| GET | `/api/market/pivots/:symbol/:tf` | — | `{symbol, timeframe, classic, camarilla, fibonacci}` | Backend pivot system (§2.3, dormant for Module 1's own UI) |
| GET | `/api/market/option-chain/:index` | — | `{index, spotPrice, atmStrike, strikes[]}` | Synthetic ±5-strike chain around ATM |
| POST | `/api/market/custom-timeframe` | body `{timeframe}` | `{message, timeframe, minutes}` | Registers a custom aggregation timeframe |
| GET | `/api/market/status` | — | `{status:"LIVE"\|"CLOSED", zebuConnected}` | Time-based market-hours check + live broker-connectivity flag |
| GET | `/api/module/status` | — | `{module1, module2}` | Coarse per-module connection status |
| GET | `/module1/indicators/:symbol` | `?timeframe`, `?method` | Indicator object or 404 | Dormant (§2.3) |
| GET | `/module1/latest-oi` | — (**no auth**) | OI snapshot | Current OI matrix row |
| GET | `/module1/expiries/:symbol` | — | `{symbol, expiries:[{id, expiry}]}` | Real NFO-master expiry list |
| GET | `/module1/strikes/:symbol/:expiryId` | — | `{symbol, expiryId, strikes:[{value}]}` | Real NFO-master strike list |

### 14.2 Authentication (`apps/backend/src/routes/auth.ts`)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | Disabled (403) when env-var auth mode is active |
| POST | `/auth/login` | Rate-limited (15/15min); may return `{otpRequired, loginToken}` instead of a session |
| POST | `/auth/verify-otp` | Exchanges `{loginToken, otp}` for a real session |
| POST | `/auth/refresh` | Cookie-based; rotates both tokens |
| POST | `/auth/logout` | Requires auth; blacklists JWT + calls `stopDataFeed()` |
| GET | `/auth/me` | Requires auth |
| POST | `/auth/module1-broker-login` | Rate-limited; issues `moduleToken` (§3.2) |
| POST | `/auth/module1-resume-session` | Rate-limited; no credentials required (§3.3) |
| POST | `/auth/module2-broker-login` | Module 2 — not part of Module 1 |
| GET | `/api/module1/zebu/oauth/callback`, `/status` | Dormant (§3.9) |

**Rate limiting:** 15 requests/15 minutes on the auth-sensitive routes listed above; a separate global limiter of 200 requests/15 minutes covers all `/api/*` routes.

---

## 15. Configuration

### 15.1 Environment variables (backend, `apps/backend/.env.example`)

| Variable | Purpose |
|---|---|
| `NODE_ENV`, `PORT`, `FRONTEND_URL` | App/runtime basics; `FRONTEND_URL` also drives CORS |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Must be strong random secrets — the app **refuses to start in production** with an insecure/placeholder value |
| `MONGODB_URI` | MongoDB connection string |
| `UPSTASH_REDIS_REST_URL`/`_TOKEN` (or `REDIS_URL`) | Redis backend (§8.6); falls back to an in-process mock if neither is reachable |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional email (not part of Module 1's core flow) |
| `ZEBU_USER_ID`, `ZEBU_API_KEY`, `ZEBU_VENDOR_CODE`, `ZEBU_TOTP_SECRET` | Zebu broker credentials/config |
| `ZEBU_NIFTY_FUT_TOKEN`, `ZEBU_NIFTY_SPOT_TOKEN` | Stable instrument tokens |
| `ZEBU_NIFTY_CE_TOKENS`, `ZEBU_NIFTY_PE_TOKENS` | **Fallback only** — real tokens are auto-downloaded from Zebu's NFO master on every login (§8.7) |
| `APP_OTP_ENABLED`, `APP_LOGIN_OTP` | App-level login OTP gate (§3.1) |
| `APP_LOGIN_USERNAME`, `APP_LOGIN_PASSWORD` | Fixed single-tenant login credentials, bypassing the MongoDB `User` collection |

### 15.2 Frontend (`apps/frontend/.env`)

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Backend REST base URL |
| `VITE_SOCKET_URL` | Backend Socket.IO URL (defaults to `VITE_API_URL` if unset) |
| `VITE_APP_OTP_ENABLED` | Must match the backend's `APP_OTP_ENABLED` for the OTP UI step to appear |

### 15.3 Supported timeframes

`1m 2m 3m 5m 10m 15m 30m 45m 1h 2h 3h 4h` — all 12 are aggregated server-side simultaneously (§8.3) and all are reachable as timeframe pills in the UI. A "Custom" range mode exists in code but is currently hidden from the UI (§16).

### 15.4 Supported instruments

The Instrument-type dropdown lists `OPTIDX, FUTIDX, INDEX, EQ, OPTSTK, FUTSTK, FUTCUR, OPTCUR, FUTCOM, OPTCOM`, but only `INDEX`/`FUTIDX`/`OPTIDX` currently have any symbols populated (`tradingConfig.ts`): `NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50, SENSEX, BANKEX`. Of those, only **NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY** have live instrument-token backing (§8.7) — SENSEX, BANKEX, and NIFTYNXT50 are selectable but will not resolve real expiries/strikes.

---

## 16. Business Rules

- Ranking always compares Call MMA vs Put MMA only; ties favor Call; a fully-missing side never blocks the other from winning.
- RSI, session high/low, and SMC/Fibonacci are always computed from the **Future** series — option premiums never feed them.
- VWAP is computed from Future bars only, and is `null` (not zero, not an unweighted average) until real volume exists.
- The visible EMA column is a categorical CALL/PUT/NEUTRAL signal, not a raw EMA value.
- The app is currently locked to `type = "Call+Put"` — the Option Type selector, Generate/Reset buttons, and Custom-timeframe pill all exist in code but are hidden (`display:"none"`) per an explicit "hidden per client request" comment; the worksheet auto-generates once the required selection is complete and the backend confirms live data.
- Excel export is always column-for-column, value-for-value identical to whatever is currently visible on screen, using the same hidden-columns/column-order state.
- Application logout always tears down the Module 1 broker connection too — there is no way to stay logged into the app while explicitly disconnecting only the broker.
- Session resume (on page reload with a cached token) only re-establishes the backend's broker WebSocket; it never re-runs full credentialed authentication.
- Historical rows are session-scoped (today's 09:15 IST open onward); only the dedicated EMA warm-up fetch reaches into prior sessions, and only to seed EMA continuation, never to populate visible rows.

---

## 17. Known Limitations

- **VWAP requires Future volume.** If the 500ms volume-polling call fails, VWAP simply keeps its last-known cumulative state rather than erroring — silent staleness, not a crash.
- **EMA200 needs 200 Spot closes.** The warm-up fetch pulls up to 200 prior-session bars, but on coarser timeframes (e.g. hourly) a full session may not produce anywhere near 200 candles even across the 45-day Mongo retention window, so EMA200 (and everything derived from it — EMA Score, Total Score, Rating, Signal) can legitimately show `—` for extended periods on those timeframes.
- **Indicators warm up silently** — RSI/EMA/EMA200/VWAP all render `—` or their specific placeholder text until enough data exists; this is expected behavior, not a bug.
- **Hard broker dependency.** No historical or live data of any kind is available without an active Module 1 Zebu login.
- **Hard session dependency.** Both the module JWT and the backend's persisted broker session expire after 8 hours; there is no silent module-level refresh — a fresh credentialed login is required.
- **Several UI controls are implemented but unreachable:** Option Type selector, Generate/Reset buttons, Custom timeframe pill and its whole date-range panel. Document current visible behavior only; do not describe these as available features to end users or QA.
- **"Remember Credentials" checkbox is a non-functional no-op.**
- **"Switch credentials" clears only the in-memory token**, not `sessionStorage` — a page reload before completing a new login can resurface the previous session (§3.4).
- **SMC is a simple nearest-reference-level indicator**, not a true Smart Money Concepts (BOS/CHoCH/FVG/Order Block/Liquidity/Premium-Discount) engine.
- **The server-side pivot/indicator subsystem is dormant** — fully built (`pivotService.ts`, `/module1/indicators`, `indicators`/`pivots` socket events) but never consumed by the current frontend.
- **`SpotTicks` MongoDB model is defined but unused** — no code path writes to it; live spot data flows entirely through the in-memory/Redis LTP mirror and `FuturesOHLC` candles instead.
- **`PivotLevels`'s `timeframe` enum only covers `1m/3m/5m/custom`**, not all 12 timeframes the backend actually aggregates — a finalized 15m/30m/45m/2h/3h/4h candle's pivot recalculation silently fails Mongoose validation and is never persisted (it still computes correctly and populates the in-memory cache, just isn't saved to Mongo for those timeframes).
- **BSE indices (SENSEX, BANKEX) and NIFTYNXT50** are selectable in the Symbol dropdown but have no backing NFO instrument-token data (§8.7) — they will not produce live expiries, strikes, or data.
- **The backend pivot service's final fallback is synthetic**, not real: if no live candle exists yet for a symbol/timeframe, it fabricates an artificial ±50-point High/Low range around the last known price rather than returning nothing.
- **Inconsistent product branding across the UI**, purely cosmetic: the dashboard's InfoBar reads "SYNERGY · Trading Dashboard", the app shell sidebar/login footer reads "TradePro" / "Pivot Intelligence v1.0" in different places. Not a functional issue, just current literal UI text worth being aware of.

---

## 18. Implementation Notes

- **Historical warm-up architecture:** EMA200 needs 200 prior closes before it can produce a value on day one of a session. Rather than requiring the user to wait, the row-builder fetches up to 200 prior-session Spot candles purely as calculation seed data (never rendered), so EMA200 can already have a value at market open on fine timeframes.
- **Session resume vs re-login:** a cached `module1Token` surviving a page reload only proves the *frontend* still thinks it's authenticated — the backend's live Zebu WebSocket is a separate, process-scoped resource that doesn't survive a backend restart. The dedicated resume endpoint (`/auth/module1-resume-session`) exists specifically to reconnect that backend resource without forcing the user through a full credentialed re-login every time they reopen the tab.
- **Why option OI is never warmed from Redis on restart:** a past incident froze stale OI values from an already-expired weekly options series (an in-code comment cites specific frozen OHLC values as evidence). The fix: futures OI *is* warmed from Redis on startup, but Call/Put option OI maps are deliberately left empty on every login/reconnect and rebuilt purely from fresh live ticks within seconds — trading a few seconds of empty OI for a guarantee that stale/expired-contract data can never leak into a new session.
- **Why candle persistence is batched:** an earlier design awaited a MongoDB write per finalized candle on the tick-processing hot path; under bursty tick volume this caused out-of-memory incidents. The current design queues finalized candles and drains them via a single batched `bulkWrite` on a separate cycle.
- **Why the in-memory Redis "mirror" exists:** an earlier per-tick or per-500ms Redis write pattern burned through Upstash's metered command quota. The mirror makes the in-process Map authoritative for all live reads, and only durably persists 3 specific keys, at most once a minute each, purely for restart-warmup.
- **Why hidden columns/controls were kept in code rather than deleted:** the EMA200/score/rating/signal/pivot columns and the Option Type/Generate/Reset/Custom-timeframe controls were all explicitly hidden per client direction, but their calculation logic, store wiring, and column-order plumbing were deliberately left intact rather than removed — re-exposing any of them later is a UI-only change, not new development.
- **Why "no cross-instrument fallback" for missing option data:** an earlier version silently substituted the Futures LTP into a Call/Put cell with no option tick yet, which could visually read as a real option price. The current row-builder renders a hard `—` instead — honest-missing over plausible-but-wrong.
- **Why the Excel export shares code with the live table:** `getVisibleColumns`/`getCellValue`/`rankingDisplayValue` are the single source of truth for both, specifically so a discrepancy between "what the screen shows" and "what the download contains" is structurally impossible rather than something that has to be kept in sync by hand.

---

*Verified against the codebase at `Stock-Trading-Consultancy-project` (commit `ce75817` and working tree as of 2026-07-15). Where the code and any prior documentation disagreed, the code's current behavior is what's documented here.*
