import mongoose from "mongoose";
import { Module2Session } from "../models/Module2Session";
import { Module2StrikeTick } from "../models/Module2StrikeTick";
import { readLive, readLiveBatch } from "./redisWriteBuffer";
import { broadcastTrackerUpdate, broadcastTrackerPersistence } from "./socketService";
import {
  Module2SessionData,
  Module2StrikeState,
  Module2Cell,
  TrendBadgeState,
  formatISTTime,
  getMinutesSinceMarketOpenIST,
  normalizeCandleTimestamp,
  getCanonicalMinuteDate,
} from "@stock/shared";
import { getModule2DataSource, logModule2InteractiveStatus } from "./module2InteractiveDataService";
import { resolveOptionStrikeToken, subscribeToInstruments, unsubscribeFromInstruments, getActiveSubscribedInstruments, setOnAetramReconnect } from "./aetramMarketDataService";
import {
  persistMinuteSnapshots,
  Module2MinuteSnapshot,
  getModule2PersistenceMetrics,
} from "./module2PersistenceService";
import { isModule2TrackingMinuteAllowed } from "./module2MarketHours";
import { debugLog } from "../utils/logger";

// In-memory cache for active tracker sessions to avoid database load
export const activeSessions: Record<string, Module2SessionData> = {};

let boundaryTimer: NodeJS.Timeout | null = null;
let engineStopped = false;
// One-shot log guard so "market closed — paused" is printed once per close, not every minute.
let marketClosedBoundaryLogged = false;

/**
 * Raised when a tracker session cannot be durably created. The controller
 * translates this into a clean HTTP error — NO in-memory session is registered,
 * NO subscriptions are started, NO fake session id is invented.
 */
export class TrackerStartupError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = "TrackerStartupError";
  }
}

// ── Per-strike subscription / tick observability (Problem 13) ─────────────────
export interface StrikeSubscriptionStatus {
  sessionId: string;
  strike: string;
  resolved: boolean;
  subscribed: boolean;
  lastResolveError: string | null;
  lastTickAt: number | null; // epoch ms
  updatedAt: number;
}
const strikeStatus = new Map<string, StrikeSubscriptionStatus>();
const strikeStatusKey = (sessionId: string, strike: string) => `${sessionId}::${strike}`;

const upsertStrikeStatus = (
  sessionId: string,
  strike: string,
  patch: Partial<StrikeSubscriptionStatus>
) => {
  const key = strikeStatusKey(sessionId, strike);
  const existing = strikeStatus.get(key) || {
    sessionId,
    strike,
    resolved: false,
    subscribed: false,
    lastResolveError: null,
    lastTickAt: null,
    updatedAt: Date.now(),
  };
  strikeStatus.set(key, { ...existing, ...patch, updatedAt: Date.now() });
};

const clearStrikeStatusForSession = (sessionId: string) => {
  for (const key of Array.from(strikeStatus.keys())) {
    if (key.startsWith(`${sessionId}::`)) strikeStatus.delete(key);
  }
};

export const getStrikeSubscriptionStatuses = (sessionId?: string): StrikeSubscriptionStatus[] => {
  const all = Array.from(strikeStatus.values());
  return sessionId ? all.filter((s) => s.sessionId === sessionId) : all;
};

/**
 * Start of TODAY's IST trading session (09:15 IST = 03:45 UTC), always today's
 * boundary even before it has arrived. Mirrors module1DataCleanupService's
 * getTodayCalendarSessionOpenMs so Module 2 uses the same trading-day rule.
 */
const SESSION_OPEN_UTC_MINUTES = 3 * 60 + 45;
export const getTodayTradingSessionOpenMs = (): number => {
  const now = Date.now();
  const todayMidnightMs = now - (now % (24 * 60 * 60000));
  return todayMidnightMs + SESSION_OPEN_UTC_MINUTES * 60000;
};

/**
 * A persisted ACTIVE session is "stale" once a new trading day has begun — the
 * Node process restarting does NOT make a session stale, but a session left
 * ACTIVE from a previous trading day must be transitioned to STOPPED rather
 * than resumed.
 */
export const isSessionStale = (session: { started_at?: Date | null; created_at?: Date | null }): boolean => {
  const ref = session.started_at || session.created_at;
  if (!ref) return false;
  return new Date(ref).getTime() < getTodayTradingSessionOpenMs();
};

export const getModule2RuntimeStats = () => {
  const sessions = Object.values(activeSessions);
  const strikeStatuses = getStrikeSubscriptionStatuses();
  const now = Date.now();
  return {
    activeSessions: sessions.length,
    selectedStrikes: sessions.reduce((n, s) => n + s.selectedStrikes.length, 0),
    subscriptionFailures: strikeStatuses.filter((s) => !s.resolved || !s.subscribed).length,
    strikesWithoutRecentTick: strikeStatuses.filter(
      (s) => s.subscribed && (!s.lastTickAt || now - s.lastTickAt > 120_000)
    ).length,
    boundaryEngineRunning: boundaryTimer !== null && !engineStopped,
    persistence: getModule2PersistenceMetrics(),
  };
};

/**
 * Helper to resolve the futures symbol for a given index symbol
 */
const getFuturesSymbol = (index: string): string => {
  if (index === "NIFTY50") return "NIFTY-FUT";
  if (index === "BANKNIFTY") return "BANKNIFTY-FUT";
  if (index === "FINNIFTY") return "FINNIFTY-FUT";
  return `${index}-FUT`;
};

/** Server-local start of the calendar day — the same-day history window. */
const getStartOfCalendarDay = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const normalizeIndexVariants = (indexSymbol: string): string[] =>
  Array.from(
    new Set([
      indexSymbol,
      indexSymbol.toUpperCase(),
      indexSymbol.replace("50", ""),
      indexSymbol.endsWith("50") ? indexSymbol : `${indexSymbol}50`,
    ])
  );

export interface SameDayHistory {
  /** strike -> raw module2striketicks docs (all of today's sessions), time-ordered */
  ticksByStrike: Map<string, any[]>;
  /** every same-day session id that contributed history (as strings) */
  sessionIds: string[];
  /** merged strike -> ISO start boundary from all same-day sessions */
  strikeStartBoundaries: Record<string, string>;
}

/**
 * THE single source of Strike Tracker history.
 *
 * Loads every `module2striketicks` row for the given strikes across ALL of
 * today's sessions for this user/index/expiry — never just one `session_id`.
 * `startTrackerSession()` and `resumeSession()` both call this, so the grid a
 * user sees after clicking Start is byte-for-byte the same grid they see after
 * a browser refresh or a backend redeploy. (Before this, refresh only queried
 * the current `session_id` and silently dropped stitched cross-session
 * history.)
 *
 * MongoDB only. There is no Redis / in-memory branch here — a minute with no
 * durable document simply has no cell, and the frontend renders `—`.
 */
export const loadSameDayHistoryByStrike = async (params: {
  userId: string;
  indexSymbol: string;
  expiryDate: string;
  selectedStrikes: string[];
  alwaysIncludeSessionIds?: string[];
}): Promise<SameDayHistory> => {
  const { userId, indexSymbol, expiryDate, selectedStrikes, alwaysIncludeSessionIds = [] } = params;
  const ticksByStrike = new Map<string, any[]>();
  const strikeStartBoundaries: Record<string, string> = {};

  if (mongoose.connection.readyState !== 1 || selectedStrikes.length === 0) {
    return { ticksByStrike, sessionIds: alwaysIncludeSessionIds.map(String), strikeStartBoundaries };
  }

  const today = getStartOfCalendarDay();
  const sessionIds: any[] = [...alwaysIncludeSessionIds];

  try {
    const docs: any[] = await Promise.race([
      Module2Session.find({
        user_id: userId,
        index_symbol: { $in: normalizeIndexVariants(indexSymbol) },
        expiry_date: expiryDate,
        created_at: { $gte: today },
      })
        .select("_id strike_start_boundaries created_at")
        .lean(),
      new Promise<any[]>((_, rej) => setTimeout(() => rej(new Error("same-day session query timeout")), 2000)),
    ]);
    for (const d of docs) {
      sessionIds.push(d._id);
      for (const [s, b] of Object.entries((d.strike_start_boundaries || {}) as Record<string, any>)) {
        if (b && !strikeStartBoundaries[s]) {
          strikeStartBoundaries[s] = typeof b === "string" ? b : new Date(b).toISOString();
        }
      }
    }
  } catch (err: any) {
    console.warn("[MODULE2][HISTORY] Same-day session lookup failed:", err?.message || err);
  }

  // Build a $in list tolerant of both ObjectId and legacy string session ids.
  const idForms = new Map<string, any>();
  for (const id of sessionIds) {
    const key = String(id);
    if (!idForms.has(key)) idForms.set(key, id);
    if (typeof id === "string" && mongoose.isValidObjectId(id)) {
      idForms.set(key + "#oid", new mongoose.Types.ObjectId(id));
    }
  }
  const sessionIdsIn = Array.from(idForms.values());
  if (sessionIdsIn.length === 0) {
    return { ticksByStrike, sessionIds: [], strikeStartBoundaries };
  }

  try {
    const rows: any[] = await Promise.race([
      Module2StrikeTick.find({
        session_id: { $in: sessionIdsIn },
        strike: { $in: selectedStrikes },
        minute_timestamp: { $gte: today },
      })
        .sort({ minute_timestamp: 1 })
        .lean(),
      new Promise<any[]>((_, rej) => setTimeout(() => rej(new Error("same-day ticks query timeout")), 3000)),
    ]);
    for (const t of rows) {
      if (!ticksByStrike.has(t.strike)) ticksByStrike.set(t.strike, []);
      ticksByStrike.get(t.strike)!.push(t);
    }
  } catch (err: any) {
    console.warn("[MODULE2][HISTORY] Same-day ticks query failed:", err?.message || err);
  }

  return {
    ticksByStrike,
    sessionIds: Array.from(new Set(sessionIds.map(String))),
    strikeStartBoundaries,
  };
};

/** Dedupe raw tick docs to one per canonical clock minute (earliest wins), time-ordered. */
const dedupeTicksByMinute = (ticks: any[]): any[] => {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const t of [...ticks].sort(
    (a, b) => new Date(a.minute_timestamp).getTime() - new Date(b.minute_timestamp).getTime()
  )) {
    const cellNorm = normalizeCandleTimestamp(t.minute_timestamp);
    if (seen.has(cellNorm.timeString)) continue;
    seen.add(cellNorm.timeString);
    out.push({ ...t, cellNorm });
  }
  return out;
};

/** One-line provenance log so a "historical value on a fresh session" is never UNKNOWN. */
const logGridSource = (
  sessionId: string,
  strike: string,
  source: "MONGO" | "LIVE" | "NONE",
  detail: string
) => {
  console.log(`[MODULE2][GRID_SOURCE] session=${sessionId} strike=${strike} source=${source} ${detail}`);
};

/**
 * Initializes the Module 2 tracking engine and schedules the minute boundary loop
 */
/**
 * Synchronizes active option strike subscriptions with AETRAM MarketData API
 */
export const syncAetramSubscriptions = async (forceResubscribe = false): Promise<boolean> => {
  const desiredMap = new Map<string, { segment: number; token: string }>();
  // token key -> [{sessionId, strike}] so subscribe success/failure can be
  // attributed back to each selected strike (Problem 13).
  const tokenOwners = new Map<string, Array<{ sessionId: string; strike: string }>>();

  for (const session of Object.values(activeSessions)) {
    const resolvedList = await Promise.all(
      session.selectedStrikes.map(async (strike) => {
        try {
          const inst = await resolveOptionStrikeToken(session.indexSymbol, session.expiryDate, strike);
          if (inst) {
            upsertStrikeStatus(session.sessionId, strike, { resolved: true, lastResolveError: null });
          } else {
            upsertStrikeStatus(session.sessionId, strike, {
              resolved: false,
              subscribed: false,
              lastResolveError: "instrument not found / not authenticated",
            });
            console.warn(`[MODULE2][SUBSCRIPTION][STRIKE] session=${session.sessionId} strike=${strike} resolved=false subscribed=false error=instrument-not-resolved`);
          }
          return { strike, sessionId: session.sessionId, inst };
        } catch (err: any) {
          upsertStrikeStatus(session.sessionId, strike, {
            resolved: false,
            subscribed: false,
            lastResolveError: String(err?.message || err),
          });
          console.error(`[MODULE2][SUBSCRIPTION][STRIKE] session=${session.sessionId} strike=${strike} resolved=false error=${err?.message || err}`);
          return { strike, sessionId: session.sessionId, inst: null as any };
        }
      })
    );

    for (const { strike, sessionId, inst } of resolvedList) {
      if (inst) {
        const key = `${inst.segment}|${inst.token}`;
        desiredMap.set(key, inst);
        const owners = tokenOwners.get(key) || [];
        owners.push({ sessionId, strike });
        tokenOwners.set(key, owners);
      }
    }
  }

  const currentlySubscribed = forceResubscribe ? [] : getActiveSubscribedInstruments();
  const currentlySubscribedSet = new Set(currentlySubscribed.map((i: { segment: number; token: string }) => `${i.segment}|${i.token}`));
  const desiredKeys = new Set(desiredMap.keys());

  const toSubscribe: Array<{ segment: number; token: string }> = [];
  for (const [key, inst] of desiredMap.entries()) {
    if (!currentlySubscribedSet.has(key)) {
      toSubscribe.push(inst);
    }
  }

  const toUnsubscribe: Array<{ segment: number; token: string }> = [];
  if (!forceResubscribe) {
    for (const inst of currentlySubscribed) {
      const key = `${inst.segment}|${inst.token}`;
      if (!desiredKeys.has(key)) {
        toUnsubscribe.push(inst);
      }
    }
  }

  console.log(`[MODULE2-SUBSCRIPTION] activeSessions=${Object.keys(activeSessions).length} totalDesired=${desiredMap.size} currentSubscribed=${currentlySubscribed.length} toSubscribe=${toSubscribe.length} toUnsubscribe=${toUnsubscribe.length} forceResubscribe=${forceResubscribe}`);

  try {
    if (toUnsubscribe.length > 0) {
      await unsubscribeFromInstruments(toUnsubscribe);
    }

    if (toSubscribe.length > 0) {
      await subscribeToInstruments(toSubscribe);
    }

    // Attribute the current live-subscribed set back to each owning strike so
    // the diagnostics endpoint / health can show "resolved but not subscribed".
    const liveSet = new Set(
      getActiveSubscribedInstruments().map((i) => `${i.segment}|${i.token}`)
    );
    for (const [key, owners] of tokenOwners.entries()) {
      const subscribed = liveSet.has(key);
      for (const { sessionId, strike } of owners) {
        upsertStrikeStatus(sessionId, strike, { subscribed });
        if (!subscribed) {
          console.warn(`[MODULE2][SUBSCRIPTION][STRIKE] session=${sessionId} strike=${strike} resolved=true subscribed=false error=broker-subscribe-not-confirmed`);
        }
      }
    }
    return true;
  } catch (err: any) {
    for (const owners of tokenOwners.values()) {
      for (const { sessionId, strike } of owners) {
        upsertStrikeStatus(sessionId, strike, { subscribed: false });
      }
    }
    console.error(`[MODULE2-SUBSCRIPTION][ERROR] Subscription synchronization failed:`, err?.message || err);
    return false;
  }
};

export const stopTrackerSession = async (sessionId: string) => {
  console.log(`[MODULE2-TRACKER] STOPPING session=${sessionId}`);

  if (activeSessions[sessionId]) {
    delete activeSessions[sessionId];
  }

  for (const [sId, sess] of Object.entries(activeSessions)) {
    if (sId === sessionId || sess.sessionId === sessionId) {
      delete activeSessions[sId];
    }
  }

  clearStrikeStatusForSession(sessionId);

  try {
    // History is never deleted here — only the session lifecycle field changes.
    // module2striketicks / module2sessions documents remain until their TTL.
    await Module2Session.findByIdAndUpdate(sessionId, {
      status: "STOPPED",
      stopped_at: new Date(),
    });
  } catch (err: any) {
    console.warn("[MODULE2-TRACKER] Failed to mark session STOPPED in DB:", err?.message || err);
  }

  const remainingCount = Object.keys(activeSessions).length;
  console.log(`[MODULE2-TRACKER] STOP session=${sessionId} remainingActiveSessions=${remainingCount} minuteTimer=RUNNING`);

  // Trigger subscription synchronization non-blockingly to clean up unneeded strikes
  syncAetramSubscriptions().catch((err) => {
    console.error("[MODULE2-SUBSCRIPTION] Error in syncAetramSubscriptions after stop:", err);
  });
};

/**
 * Recovers ACTIVE tracker sessions from MongoDB into the in-memory engine after
 * a backend restart / Render redeploy. Without this, minute persistence stops
 * silently the moment the process restarts (Problem 4).
 *
 * Trading-day rule: a session left ACTIVE from a PREVIOUS trading day is stale
 * and is transitioned to STOPPED (never resumed). A session from the current
 * trading day is resumed with its full persisted grid — a process restart is
 * not a reason to stop it.
 */
export const recoverActiveSessions = async (): Promise<{ recovered: number; retired: number }> => {
  if (mongoose.connection.readyState !== 1) {
    console.warn("[MODULE2-TRACKER] Skipping ACTIVE session recovery — MongoDB not connected.");
    return { recovered: 0, retired: 0 };
  }

  let docs: any[] = [];
  try {
    docs = await Module2Session.find({ status: "ACTIVE" }).sort({ created_at: -1 }).lean();
  } catch (err: any) {
    console.error("[MODULE2-TRACKER] ACTIVE session recovery query failed:", err?.message || err);
    return { recovered: 0, retired: 0 };
  }

  let recovered = 0;
  let retired = 0;

  for (const doc of docs) {
    const sessionId = String(doc._id);
    try {
      if (isSessionStale(doc)) {
        await Module2Session.findByIdAndUpdate(sessionId, { status: "STOPPED", stopped_at: new Date() });
        retired += 1;
        console.log(`[MODULE2-TRACKER] Retired stale ACTIVE session=${sessionId} (started_at=${doc.started_at || doc.created_at}) — previous trading day.`);
        continue;
      }
      if (activeSessions[sessionId]) {
        recovered += 1;
        continue;
      }
      const resumed = await resumeSession(sessionId);
      if (resumed) {
        recovered += 1;
        console.log(`[MODULE2-TRACKER] Recovered ACTIVE session=${sessionId} user=${resumed.userId} strikes=${resumed.selectedStrikes.length} gridMinutes=${Object.values(resumed.strikes)[0]?.grid.length ?? 0}`);
      }
    } catch (err: any) {
      console.error(`[MODULE2-TRACKER] Failed to recover session=${sessionId}:`, err?.message || err);
    }
  }

  console.log(`[MODULE2-TRACKER] Recovery complete: recovered=${recovered} retired(stale)=${retired} totalActive=${Object.keys(activeSessions).length}`);
  return { recovered, retired };
};

/**
 * Initializes the Module 2 tracking engine and schedules the minute boundary loop
 */
export const initTrackerEngine = async () => {
  logModule2InteractiveStatus();
  engineStopped = false;

  // Ensure the module2striketicks indexes (esp. the { session_id, strike,
  // minute_timestamp } UNIQUE index that idempotent persistence relies on)
  // exist. createIndexes only creates — it never drops — so this is safe on a
  // collection that already has historical data.
  try {
    await Module2StrikeTick.createIndexes();
    console.log("[MODULE2-TRACKER] module2striketicks indexes ensured.");
  } catch (err: any) {
    console.error("[MODULE2-TRACKER] Failed to ensure module2striketicks indexes (will retry on next restart):", err?.message || err);
  }

  // Register reconnect callback so subscriptions for active sessions (if any) are restored on WebSocket reconnect
  setOnAetramReconnect(async () => {
    await syncAetramSubscriptions(true);
  });

  // Recover ACTIVE sessions from MongoDB so persistence survives a restart.
  try {
    await recoverActiveSessions();
  } catch (err: any) {
    console.error("[MODULE2-TRACKER] recoverActiveSessions threw:", err?.message || err);
  }

  console.log(`[MODULE2-TRACKER] Initialized. ${Object.keys(activeSessions).length} active tracker session(s) running.`);

  // Schedule the minute boundary checker
  scheduleNextMinuteBoundary();
};

/** Stops the boundary timer (graceful shutdown). Does NOT stop or STOP sessions. */
export const stopTrackerEngine = () => {
  engineStopped = true;
  if (boundaryTimer) {
    clearTimeout(boundaryTimer);
    boundaryTimer = null;
  }
  console.log("[MODULE2-TRACKER] Minute-boundary engine stopped (sessions left ACTIVE for recovery on next start).");
};

/**
 * Schedules execution precisely on clock minute boundaries (00 seconds)
 */
const scheduleNextMinuteBoundary = () => {
  if (engineStopped) return;
  const now = Date.now();
  const delay = 60000 - (now % 60000);

  boundaryTimer = setTimeout(async () => {
    try {
      await executeMinuteBoundary();
    } catch (error) {
      console.error("[MODULE2-TIMER] Error executing minute boundary:", error);
    }
    // Continuous scheduling — NEVER stops while server is running
    scheduleNextMinuteBoundary();
  }, delay);
};


/**
 * Executed on every minute boundary. Captures prices, updates grids, and broadcasts events.
 */
const executeMinuteBoundary = async () => {
  const norm = normalizeCandleTimestamp(Date.now());
  // Canonical minute boundary (UTC, seconds & ms zeroed) — THE persistence key.
  const timestamp = getCanonicalMinuteDate(norm.minuteStartMs);
  const minutesSinceStart = norm.minuteIndex;
  const timeString = norm.timeString;

  const sessionIds = Object.keys(activeSessions);
  if (sessionIds.length === 0) return;

  // Market closed → do NOT produce another per-minute row. Sessions, grids,
  // subscriptions and MongoDB history are all left untouched; the Strike
  // Tracker timeline simply freezes at the 15:30 IST closing snapshot and
  // resumes on the next trading day. (15:30:00 itself is allowed through so
  // the closing row is captured.)
  if (!isModule2TrackingMinuteAllowed()) {
    if (!marketClosedBoundaryLogged) {
      marketClosedBoundaryLogged = true;
      console.log(`[MODULE2-TRACKER] Market closed — minute-boundary snapshots paused at ${timeString} IST (${sessionIds.length} session(s) preserved).`);
    }
    return;
  }
  marketClosedBoundaryLogged = false;

  console.log(`[TIMELINE] Boundary trigger at ${timeString} IST (minuteIndex=${minutesSinceStart}). Processing ${sessionIds.length} sessions...`);

  for (const sessionId of sessionIds) {
    const session = activeSessions[sessionId];
    if (!session) continue;

    try {
      // 1. Calculate Futures OI Delta
      const futSymbol = getFuturesSymbol(session.indexSymbol);
      const rawFutPrice = await readLive(`ltp:${futSymbol}`);
      const rawFutOi = await readLive(`oi:${futSymbol}`);
      let futLtp = rawFutPrice ? parseFloat(rawFutPrice) : 0;
      let futOi = rawFutOi ? Math.floor(parseFloat(rawFutOi)) : 0;

      let futuresOI = session.futuresOI;
      if (!futuresOI) {
        futuresOI = {
          symbol: futSymbol,
          oiLatest: futOi,
          oiDelta: 0,
          oiBuy: 0,
          oiSell: 0,
          oiHigh: futOi,
          oiLow: futOi
        };
        session.futuresOI = futuresOI;
      }

      if (futOi === 0) {
        futOi = futuresOI.oiLatest || 0;
      }

      const prevFutOi = futuresOI.oiLatest || 0;
      const futOiDelta = prevFutOi > 0 ? futOi - prevFutOi : 0;
      const futOiBuy = futOiDelta > 0 ? futOiDelta : 0;
      const futOiSell = futOiDelta < 0 ? futOiDelta : 0;

      futuresOI.oiLatest = futOi;
      futuresOI.oiDelta = futOiDelta;
      futuresOI.oiBuy = futOiBuy;
      futuresOI.oiSell = futOiSell;
      futuresOI.oiHigh = futuresOI.oiHigh ? Math.max(futuresOI.oiHigh, futOi) : futOi;
      futuresOI.oiLow = (futuresOI.oiLow && futuresOI.oiLow > 0) ? Math.min(futuresOI.oiLow, futOi) : futOi;

      session.futuresOI = futuresOI;

      try {
        await Module2Session.findByIdAndUpdate(sessionId, {
          futures_oi_json: futuresOI
        });
      } catch (err: any) {
        console.warn(`[MODULE2][SESSION-META] session=${sessionId} futures_oi_json update failed: ${err?.message || err}`);
      }

      // 2. Process Options Strikes.
      // Snapshots for EVERY selected strike are collected here and persisted in
      // ONE idempotent bulkWrite after the loop — a strike that received no
      // tick this minute still gets a row (Problem 10). Persistence is fully
      // decoupled from the live broadcast below.
      const sessionSnapshots: Module2MinuteSnapshot[] = [];

      for (const strike of session.selectedStrikes) {
        // Fetch latest price & OI from Redis cache
        const rawPrice = await readLive(`ltp:${strike}`);
        const hadLivePrice = rawPrice != null && parseFloat(rawPrice) > 0;
        let ltp = rawPrice ? parseFloat(rawPrice) : 0;

        const rawOi = await readLive(`oi:${strike}`);
        let oi = rawOi ? Math.floor(parseFloat(rawOi)) : 0;

        let strikeState = session.strikes[strike];

        // If strike state doesn't exist, initialize it
        if (!strikeState) {
          const dayOpen = ltp || 0; // Capture Day Open baseline at first observation
          strikeState = {
            strike,
            dayOpen,
            dayHigh: dayOpen,
            dayLow: dayOpen,
            grid: [],
            trendBadge: "FLAT",
            isDowntrendActive: false,
            isDeepLoss: false,
            pctChange: 0,
            oiLatest: oi,
            oiBuyLatest: 0,
            oiSellLatest: 0,
            oiHigh: oi,
            oiLow: oi,
            oiMean: oi,
            // Internal running totals for mean calculation (not in shared interface)
            _oiRunningSum: oi,
            _oiRowCount: 1
          } as any;
          session.strikes[strike] = strikeState;
        }

        // Capture Day Open baseline at first observation!
        if (strikeState.dayOpen === 0 && ltp > 0) {
          strikeState.dayOpen = ltp;
          strikeState.dayHigh = ltp;
          strikeState.dayLow = ltp;
          session.dayOpenPrices[strike] = ltp;
          try {
            await Module2Session.findByIdAndUpdate(sessionId, {
              day_open_prices_json: session.dayOpenPrices
            });
          } catch (err: any) {
            console.warn(`[MODULE2][SESSION-META] session=${sessionId} day_open_prices_json update failed: ${err?.message || err}`);
          }
        }

        // If price from Redis is 0/missing, fallback to previous price
        if (ltp === 0 && strikeState.grid.length > 0) {
          const lastValid = [...strikeState.grid].reverse().find((c) => c.ltp > 0);
          ltp = lastValid ? lastValid.ltp : (strikeState.dayOpen || 0);
        } else if (ltp === 0) {
          ltp = strikeState.dayOpen || 0;
        }

        // If OI is 0, fallback to previous OI
        if (oi === 0 && strikeState.grid.length > 0) {
          oi = strikeState.grid[strikeState.grid.length - 1].oi || 0;
        } else if (oi === 0) {
          oi = strikeState.oiLatest || 0;
        }

        // Calculate OI Delta, Buy, Sell
        // First-row handling: at rowIndex 0 (no previous row), entire opening OI is treated as initial buy
        const isFirstRow = strikeState.grid.length === 0;
        let oiDelta = 0;
        let oiBuy = 0;
        let oiSell = 0;

        if (isFirstRow) {
          // At 9:15 AM first row: no previous to compare — treat all OI as initial buy
          oiBuy = oi;
          oiSell = 0;
          oiDelta = 0;
        } else {
          const prevOi = strikeState.grid[strikeState.grid.length - 1].oi || 0;
          oiDelta = prevOi > 0 ? oi - prevOi : 0;
          oiBuy = oiDelta > 0 ? oiDelta : 0;
          oiSell = oiDelta < 0 ? Math.abs(oiDelta) : 0;
        }

        // Update High/Low boundaries for Price
        if (ltp > 0) {
          strikeState.dayHigh = strikeState.dayHigh ? Math.max(strikeState.dayHigh, ltp) : ltp;
          strikeState.dayLow = (strikeState.dayLow && strikeState.dayLow > 0) ? Math.min(strikeState.dayLow, ltp) : ltp;
        }

        const isHigh = ltp > 0 && ltp === strikeState.dayHigh;
        const isLow = ltp > 0 && ltp === strikeState.dayLow;

        const denominator = strikeState.dayOpen || ltp;
        strikeState.pctChange = denominator > 0 ? Number((((ltp - denominator) / denominator) * 100).toFixed(2)) : 0;

        // Update boundaries for OI
        if (isFirstRow) {
          strikeState.oiHigh = oi;
          strikeState.oiLow = oi;
        } else {
          strikeState.oiHigh = strikeState.oiHigh ? Math.max(strikeState.oiHigh, oi) : oi;
          strikeState.oiLow = (strikeState.oiLow && strikeState.oiLow > 0) ? Math.min(strikeState.oiLow, oi) : oi;
        }
        strikeState.oiLatest = oi;
        strikeState.oiBuyLatest = oiBuy;
        strikeState.oiSellLatest = oiSell;

        // Update running OI sum and compute mean
        const s = strikeState as any;
        if (isFirstRow) {
          s._oiRunningSum = oi;
          s._oiRowCount = 1;
        } else {
          s._oiRunningSum = (s._oiRunningSum || 0) + oi;
          s._oiRowCount = (s._oiRowCount || 1) + 1;
        }
        strikeState.oiMean = s._oiRowCount > 0 ? Math.round(s._oiRunningSum / s._oiRowCount) : oi;

        // 3. Evaluate trend badge
        const previousBadge = strikeState.trendBadge;
        const recentLtpList = strikeState.grid.slice(-4).map(c => c.ltp);
        recentLtpList.push(ltp);

        let newBadge: TrendBadgeState = "FLAT";
        if (recentLtpList.length >= 5) {
          let higherHighs = 0;
          let lowerLows = 0;
          for (let i = 1; i < recentLtpList.length; i++) {
            if (recentLtpList[i] > recentLtpList[i - 1]) higherHighs++;
            if (recentLtpList[i] < recentLtpList[i - 1]) lowerLows++;
          }

          if (lowerLows >= 4) {
            newBadge = "H_TO_L";
          } else if (higherHighs >= 4) {
            newBadge = "L_TO_H";
          }
        }

        if (previousBadge === "H_TO_L" && newBadge === "FLAT" && recentLtpList.length >= 2 && recentLtpList[recentLtpList.length - 1] > recentLtpList[recentLtpList.length - 2]) {
          newBadge = "REVERSAL";
        } else if (previousBadge === "L_TO_H" && newBadge === "FLAT" && recentLtpList.length >= 2 && recentLtpList[recentLtpList.length - 1] < recentLtpList[recentLtpList.length - 2]) {
          newBadge = "REVERSAL";
        }

        strikeState.trendBadge = newBadge;

        // 4. Evaluate Call-Down Advisory Filter (CE options only)
        const isCE = strike.endsWith("CE");
        if (isCE) {
          if (ltp < strikeState.dayOpen * 0.85) {
            strikeState.isDeepLoss = true;
          }

          const recent3 = strikeState.grid.slice(-2).map(c => c.ltp);
          recent3.push(ltp);
          if (recent3.length >= 3 && recent3[0] > recent3[1] && recent3[1] > recent3[2]) {
            strikeState.isDowntrendActive = true;
          }

          if (recent3.length >= 3 && recent3[recent3.length - 1] > recent3[recent3.length - 2] && recent3[recent3.length - 2] > recent3[recent3.length - 3]) {
            strikeState.isDowntrendActive = false;
            strikeState.isDeepLoss = false;
          }
        }

        // ltp_missing = we could not obtain ANY legitimate price (no live tick,
        // no prior grid value, no baseline). A carried-forward real price is
        // NOT "missing" — that is the intended fallback ladder.
        const ltpMissing = !hadLivePrice && !(ltp > 0);

        // Create new cell. source="live" now; it becomes "mongo" the moment the
        // batch below persists this minute — the UI never treats a live cell as
        // durable history.
        const cell: Module2Cell = {
          ltp,
          minute: minutesSinceStart,
          timestamp: timeString,
          isHigh,
          isLow,
          oi,
          oiDelta,
          oiBuy,
          oiSell,
          source: "live",
          ltpMissing,
        };

        debugLog(`[AGGREGATION][MINUTE] symbol=${strike} minute=${timeString} open=${strikeState.dayOpen} high=${strikeState.dayHigh} low=${strikeState.dayLow} close=${ltp}`);

        const existingCellIdx = strikeState.grid.findIndex((c) => c.minute === minutesSinceStart || c.timestamp === timeString);
        if (existingCellIdx >= 0) {
          strikeState.grid[existingCellIdx] = cell;
        } else {
          strikeState.grid.push(cell);
        }

        // Collect the durable snapshot (persisted as one batch after the loop).
        sessionSnapshots.push({
          session_id: sessionId,
          strike,
          minute_timestamp: timestamp,
          ltp_integer: ltp,
          ltp_missing: ltpMissing,
          is_day_high: cell.isHigh,
          is_day_low: cell.isLow,
          pct_from_open: strikeState.pctChange,
          is_downtrend_flagged: strikeState.isDowntrendActive,
          oi,
          oi_delta: oiDelta,
          oi_buy: oiBuy,
          oi_sell: oiSell,
        });

        // Broadcast to connected clients — IMMEDIATELY, independent of the DB.
        debugLog(`[SOCKET][BROADCAST] session=${sessionId} symbol=${strike} ltp=${ltp}`);
        broadcastTrackerUpdate(sessionId, {
          strike,
          cell,
          state: {
            dayHigh: strikeState.dayHigh,
            dayLow: strikeState.dayLow,
            trendBadge: strikeState.trendBadge,
            isDowntrendActive: strikeState.isDowntrendActive,
            isDeepLoss: strikeState.isDeepLoss,
            pctChange: strikeState.pctChange,
            oiLatest: strikeState.oiLatest,
            oiBuyLatest: strikeState.oiBuyLatest,
            oiSellLatest: strikeState.oiSellLatest,
            oiHigh: strikeState.oiHigh,
            oiLow: strikeState.oiLow,
            oiMean: strikeState.oiMean
          },
          futuresOI: session.futuresOI
        });
      }

      // 3. Durable persistence — ONE idempotent bulkWrite for the whole minute.
      //    Errors are logged, classified, counted, and retried (transient only)
      //    inside the persistence service — never swallowed. The tracker keeps
      //    running regardless.
      const persistResult = await persistMinuteSnapshots(sessionSnapshots);
      const persistedOk = persistResult.failed === 0 && persistResult.attempted > 0;
      if (persistedOk) {
        console.log(
          `[MODULE2][PERSISTENCE][SUCCESS] session=${sessionId} minute=${timeString} strikes=${persistResult.succeeded}`
        );
        // A live cell whose minute is now durable is upgraded to source="mongo".
        const failedSet = new Set(persistResult.failures.map((f) => f.strike));
        for (const snap of sessionSnapshots) {
          if (failedSet.has(snap.strike)) continue;
          const c = session.strikes[snap.strike]?.grid.find((x) => x.timestamp === timeString);
          if (c) c.source = "mongo";
        }
      } else if (persistResult.attempted > 0) {
        console.error(
          `[MODULE2][PERSISTENCE][MINUTE] session=${sessionId} minute=${timeString} attempted=${persistResult.attempted} succeeded=${persistResult.succeeded} failed=${persistResult.failed} retries=${persistResult.retries}`
        );
      }
      // Tell the UI the true persistence outcome for this finalized minute
      // (the live cells were already broadcast above regardless).
      broadcastTrackerPersistence(sessionId, {
        minute: timeString,
        minuteTimestamp: timestamp.toISOString(),
        persisted: persistedOk,
        attempted: persistResult.attempted,
        succeeded: persistResult.succeeded,
        failed: persistResult.failed,
        failedStrikes: persistResult.failures.map((f) => f.strike),
      });
    } catch (sessionErr: any) {
      console.error(`[TrackerEngine] Error processing minute boundary for session=${sessionId}:`, sessionErr?.message || sessionErr);
    }
  }
};

/**
 * Starts a new Module 2 tracking session with persistent historical strike stitching
 */

export const startTrackerSession = async (
  userId: string,
  sessionType: "CE" | "PE" | "mixed",
  indexSymbol: string,
  expiryDate: string,
  selectedStrikes: string[]
): Promise<Module2SessionData> => {
  const startTime = Date.now();
  console.log(`[MODULE2-TRACKER] START REQUEST userId=${userId} index=${indexSymbol} expiry=${expiryDate} strikes=${selectedStrikes.length}`);

  // A tracker session MUST be durably persisted. If MongoDB is not available we
  // fail the start cleanly rather than creating a fake in-memory session that
  // can never persist its minute snapshots (Problem 2 / 3).
  if (mongoose.connection.readyState !== 1) {
    throw new TrackerStartupError(
      "Tracker cannot start — the database is currently unavailable. Please try again shortly.",
      "DB_UNAVAILABLE"
    );
  }

  const today = getStartOfCalendarDay();

  // 1+3. Load ALL of today's persisted history for these strikes from MongoDB —
  // across every same-day session for this user/index/expiry. This is the ONLY
  // source of historical minutes (no Redis, no in-memory). resumeSession() uses
  // the exact same call, so Start and a later refresh produce an identical grid.
  const history = await loadSameDayHistoryByStrike({ userId, indexSymbol, expiryDate, selectedStrikes });
  const pastTicksByStrike = history.ticksByStrike;
  const existingStrikeStartBoundaries = history.strikeStartBoundaries;
  const previousSessionIds = history.sessionIds;
  console.log(
    `[MODULE2][TRACKER][START] user=${userId} index=${indexSymbol} expiry=${expiryDate} strikes=${selectedStrikes.length} ` +
    `sameDaySessions=${previousSessionIds.length} strikesWithHistory=${pastTicksByStrike.size}`
  );

  // 2. Pre-fetch all live prices/OI (in-process mirror) concurrently in ONE batch call
  const futSymbol = getFuturesSymbol(indexSymbol);
  const keysToBatch = [
    ...selectedStrikes.map((s) => `ltp:${s}`),
    ...selectedStrikes.map((s) => `oi:${s}`),
    `ltp:${futSymbol}`,
    `oi:${futSymbol}`,
  ];
  const liveDataMap = await readLiveBatch(keysToBatch);

  const dayOpenPrices: Record<string, number> = {};
  const strikes: Record<string, Module2StrikeState> = {};
  const strikeStartBoundaries: Record<string, string> = {};
  const norm = normalizeCandleTimestamp(Date.now());
  const initialMinutes = norm.minuteIndex;
  const initialTimeString = norm.timeString;
  const currentIsoString = new Date(norm.timestampMs).toISOString();

  // 4. Process all strikes purely in-memory (0ms network calls in loop)
  for (const strike of selectedStrikes) {
    const rawPrice = liveDataMap.get(`ltp:${strike}`);
    const liveLtp = rawPrice ? parseFloat(rawPrice) : 0;

    const rawOi = liveDataMap.get(`oi:${strike}`);
    const liveOi = rawOi ? Math.floor(parseFloat(rawOi)) : 0;

    const pastTicks = pastTicksByStrike.get(strike) || [];

    // Deduplicate past ticks to one per canonical clock minute
    const dedupedTicks = dedupeTicksByMinute(pastTicks);

    if (dedupedTicks.length > 0) {
      const firstTs = dedupedTicks[0].cellNorm.timeString;
      const lastTs = dedupedTicks[dedupedTicks.length - 1].cellNorm.timeString;
      logGridSource(
        "(starting)",
        strike,
        "MONGO",
        `minutes=${dedupedTicks.length} range=${firstTs}-${lastTs} fromSameDaySessions=${previousSessionIds.length}`
      );

      // Historical data restored from today's persisted module2striketicks rows
      const historicalGrid: Module2Cell[] = dedupedTicks.map((t: any) => ({
        ltp: t.ltp_integer,
        minute: t.cellNorm.minuteIndex,
        timestamp: t.cellNorm.timeString,
        isHigh: t.is_day_high,
        isLow: t.is_day_low,
        oi: t.oi || 0,
        oiDelta: t.oi_delta || 0,
        oiBuy: t.oi_buy || 0,
        oiSell: t.oi_sell || 0,
        source: "mongo",
        ltpMissing: !!t.ltp_missing,
      }));

      const firstValidTick = dedupedTicks.find((t: any) => t.ltp_integer > 0);
      const dayOpen = firstValidTick ? firstValidTick.ltp_integer : (liveLtp || 0);
      dayOpenPrices[strike] = dayOpen;

      const dayHigh = Math.max(dayOpen, ...dedupedTicks.map((t: any) => t.ltp_integer || 0), liveLtp || 0);
      const positiveLows = [dayOpen, ...dedupedTicks.map((t: any) => t.ltp_integer || 0), liveLtp || 0].filter((p) => p > 0);
      const dayLow = positiveLows.length > 0 ? Math.min(...positiveLows) : dayOpen;

      const oiLatest = liveOi || (dedupedTicks.length > 0 ? dedupedTicks[dedupedTicks.length - 1].oi : 0);
      const oiHigh = Math.max(...dedupedTicks.map((t: any) => t.oi || 0), liveOi);
      const positiveOis = [...dedupedTicks.map((t: any) => t.oi || 0), liveOi].filter((o) => o > 0);
      const oiLow = positiveOis.length > 0 ? Math.min(...positiveOis) : oiLatest;
      const oiRunningSum = dedupedTicks.reduce((sum: number, t: any) => sum + (t.oi || 0), 0);
      const oiRowCount = dedupedTicks.length;
      const oiMean = oiRowCount > 0 ? Math.round(oiRunningSum / oiRowCount) : oiLatest;

      let trendBadge: TrendBadgeState = "FLAT";
      if (historicalGrid.length >= 5) {
        const recent = historicalGrid.slice(-5).map((c) => c.ltp);
        let up = 0;
        let down = 0;
        for (let i = 1; i < recent.length; i++) {
          if (recent[i] > recent[i - 1]) up++;
          if (recent[i] < recent[i - 1]) down++;
        }
        if (down >= 4) trendBadge = "H_TO_L";
        else if (up >= 4) trendBadge = "L_TO_H";
      }

      const lastTickDoc = dedupedTicks[dedupedTicks.length - 1];
      const isDowntrendActive = lastTickDoc?.is_downtrend_flagged || false;
      const currentLtpForCheck = liveLtp || (historicalGrid.length > 0 ? historicalGrid[historicalGrid.length - 1].ltp : dayOpen);
      const isDeepLoss = currentLtpForCheck > 0 && dayOpen > 0 ? currentLtpForCheck < dayOpen * 0.85 : false;
      const pctChange = dayOpen > 0 ? Number((((currentLtpForCheck - dayOpen) / dayOpen) * 100).toFixed(2)) : 0;

      // Append current minute cell if not already in historical grid
      const existingCurrentCell = historicalGrid.find((c) => c.timestamp === initialTimeString || c.minute === initialMinutes);
      if (!existingCurrentCell) {
        const lastHistOi = (historicalGrid.length > 0 ? historicalGrid[historicalGrid.length - 1].oi : 0) || 0;
        const oiDelta = lastHistOi > 0 && liveOi > 0 ? liveOi - lastHistOi : 0;
        const oiBuy = oiDelta > 0 ? oiDelta : 0;
        const oiSell = oiDelta < 0 ? Math.abs(oiDelta) : 0;
        historicalGrid.push({
          ltp: liveLtp,
          minute: initialMinutes,
          timestamp: initialTimeString,
          isHigh: liveLtp > 0 && liveLtp === dayHigh,
          isLow: liveLtp > 0 && liveLtp === dayLow,
          oi: liveOi,
          oiDelta,
          oiBuy,
          oiSell,
          source: "live",
        });
      }

      const firstTickTimestamp = dedupedTicks[0].minute_timestamp;
      strikeStartBoundaries[strike] = existingStrikeStartBoundaries[strike] || (firstTickTimestamp instanceof Date ? firstTickTimestamp.toISOString() : new Date(firstTickTimestamp).toISOString());

      strikes[strike] = {
        strike,
        dayOpen,
        dayHigh,
        dayLow,
        grid: historicalGrid,
        trendBadge,
        isDowntrendActive,
        isDeepLoss,
        pctChange,
        oiLatest,
        oiBuyLatest: historicalGrid.length > 0 ? historicalGrid[historicalGrid.length - 1].oiBuy : 0,
        oiSellLatest: historicalGrid.length > 0 ? historicalGrid[historicalGrid.length - 1].oiSell : 0,
        oiHigh,
        oiLow,
        oiMean,
        _oiRunningSum: oiRunningSum + (liveOi > 0 ? liveOi : 0),
        _oiRowCount: oiRowCount + 1,
      } as any;
    } else {
      // New strike — NO persisted history today. It starts from THIS minute.
      // Minutes before now have no cell → the frontend renders "—". Nothing is
      // ever copied from another strike or another session.
      logGridSource("(starting)", strike, "NONE", `noSameDayHistory startMinute=${initialTimeString}`);
      dayOpenPrices[strike] = liveLtp;

      const initialCell: Module2Cell = {
        ltp: liveLtp,
        minute: initialMinutes,
        timestamp: initialTimeString,
        isHigh: liveLtp > 0,
        isLow: liveLtp > 0,
        oi: liveOi,
        oiDelta: 0,
        oiBuy: liveOi,
        oiSell: 0,
        source: "live",
      };

      strikeStartBoundaries[strike] = currentIsoString;

      strikes[strike] = {
        strike,
        dayOpen: liveLtp,
        dayHigh: liveLtp,
        dayLow: liveLtp,
        grid: [initialCell],
        trendBadge: "FLAT",
        isDowntrendActive: false,
        isDeepLoss: false,
        pctChange: 0,
        oiLatest: liveOi,
        oiBuyLatest: 0,
        oiSellLatest: 0,
        oiHigh: liveOi,
        oiLow: liveOi,
        oiMean: liveOi,
        _oiRunningSum: liveOi,
        _oiRowCount: 1,
      } as any;
    }
  }

  // Resolve Futures symbols and fetch details from pre-fetched liveDataMap
  const rawFutPrice = liveDataMap.get(`ltp:${futSymbol}`);
  const rawFutOi = liveDataMap.get(`oi:${futSymbol}`);
  const futPrice = rawFutPrice ? parseFloat(rawFutPrice) : 0;
  const futOi = rawFutOi ? Math.floor(parseFloat(rawFutOi)) : 0;

  const futuresOI = {
    symbol: futSymbol,
    oiLatest: futOi,
    oiDelta: 0,
    oiBuy: 0,
    oiSell: 0,
    oiHigh: futOi,
    oiLow: futOi
  };

  // Create the session record in MongoDB. This MUST succeed and MUST yield a
  // real ObjectId — there is no fake-session fallback. A generous timeout
  // (8s) covers Atlas cold starts / brief failovers; anything longer is a real
  // outage and the start fails cleanly (Problem 2 / 3).
  let sessionId: string;
  let createdAt: Date;
  try {
    const timeoutPromise = new Promise<any>((_, reject) =>
      setTimeout(() => reject(new Error("MongoDB session create timeout (8000ms)")), 8000)
    );
    const doc: any = await Promise.race([
      Module2Session.create({
        user_id: userId,
        session_type: sessionType,
        index_symbol: indexSymbol,
        expiry_date: expiryDate,
        selected_strikes_json: selectedStrikes,
        day_open_prices_json: dayOpenPrices,
        futures_oi_json: futuresOI,
        status: "ACTIVE",
        started_at: new Date(),
        stopped_at: null,
        strike_start_boundaries: strikeStartBoundaries,
      }),
      timeoutPromise,
    ]);
    if (!doc?._id || !mongoose.isValidObjectId(doc._id)) {
      throw new Error("Module2Session.create returned no valid _id");
    }
    sessionId = doc._id.toString();
    createdAt = doc.created_at || new Date();
  } catch (dbErr: any) {
    console.error(`[MODULE2-TRACKER] START FAILED userId=${userId} — session persistence failed: ${dbErr?.message || dbErr}`);
    throw new TrackerStartupError(
      "Tracker could not be started because the session could not be saved. No tracking has begun — please try again.",
      "SESSION_PERSIST_FAILED"
    );
  }

  const elapsed = Date.now() - startTime;
  console.log(`[MODULE2-TRACKER] startTrackerSession completed in ${elapsed}ms for userId=${userId} sessionId=${sessionId}`);

  const sessionData: Module2SessionData = {
    sessionId,
    userId,
    dataSource: getModule2DataSource(),
    sessionType,
    indexSymbol,
    expiryDate,
    selectedStrikes,
    dayOpenPrices,
    strikes,
    status: "ACTIVE",
    startedAt: createdAt,
    stoppedAt: null,
    strikeStartBoundaries,
    createdAt,
    futuresOI
  };

  // Register in active sessions cache (each session keyed strictly by its unique sessionId)
  activeSessions[sessionId] = sessionData;

  const totalActive = Object.keys(activeSessions).length;
  console.log(`[MODULE2-TRACKER] START SUCCESS userId=${userId} session=${sessionId} activeUsers=${totalActive} minuteTimer=RUNNING`);

  // Trigger Aetram subscription synchronization asynchronously so the start HTTP request returns immediately without timing out
  syncAetramSubscriptions().catch((err) => {
    console.error("[MODULE2-SUBSCRIPTION] Subscription sync failed on session start:", err);
  });

  return sessionData;
};


/**
 * Swaps strikes dynamically within an active tracking session without losing history for others
 */
export const updateTrackerStrikes = async (
  sessionId: string,
  newStrikes: string[]
): Promise<Module2SessionData> => {
  const session = activeSessions[sessionId];
  if (!session) {
    throw new Error("Active session not found");
  }

  // Identify new strikes to initialize baselines
  const norm = normalizeCandleTimestamp(Date.now());
  const initialMinutes = norm.minuteIndex;
  const initialTimeString = norm.timeString;

  for (const strike of newStrikes) {
    if (!session.selectedStrikes.includes(strike)) {
      const rawPrice = await readLive(`ltp:${strike}`);
      const ltp = rawPrice ? parseFloat(rawPrice) : 0; // Capture baseline at first observation

      const rawOi = await readLive(`oi:${strike}`);
      const oi = rawOi ? Math.floor(parseFloat(rawOi)) : 0;

      const initialCell: Module2Cell = {
        ltp,
        minute: initialMinutes,
        timestamp: initialTimeString,
        isHigh: ltp > 0,
        isLow: ltp > 0,
        oi,
        oiDelta: 0,
        oiBuy: oi,
        oiSell: 0,
        source: "live"
      };

      session.dayOpenPrices[strike] = ltp;
      // A strike added mid-session starts NOW — record its own start boundary so
      // history restoration never back-fills it before this minute (Problem 15).
      if (!session.strikeStartBoundaries) session.strikeStartBoundaries = {};
      session.strikeStartBoundaries[strike] = new Date(norm.minuteStartMs).toISOString();
      session.strikes[strike] = {
        strike,
        dayOpen: ltp,
        dayHigh: ltp,
        dayLow: ltp,
        grid: [initialCell],
        trendBadge: "FLAT",
        isDowntrendActive: false,
        isDeepLoss: false,
        pctChange: 0,
        oiLatest: oi,
        oiBuyLatest: 0,
        oiSellLatest: 0,
        oiHigh: oi,
        oiLow: oi,
        oiMean: oi,
        _oiRunningSum: oi,
        _oiRowCount: 1
      } as any;
    }
  }

  // Remove retired strikes from the active selection. History for retired
  // strikes is NOT deleted — their module2striketicks rows remain until TTL.
  session.selectedStrikes = newStrikes;

  // Trigger Aetram subscription synchronization in the background
  syncAetramSubscriptions().catch((err) =>
    console.error("[TrackerEngine] Aetram subscription sync failed:", err)
  );

  // Update Database session configuration
  try {
    await Module2Session.findByIdAndUpdate(sessionId, {
      selected_strikes_json: newStrikes,
      day_open_prices_json: session.dayOpenPrices,
      strike_start_boundaries: session.strikeStartBoundaries || {},
    });
  } catch (dbErr: any) {
    console.warn(`[TrackerEngine] updateTrackerStrikes DB update failed: ${dbErr?.message || dbErr}`);
  }

  return session;
};

/**
 * Resumes an ACTIVE session from the database (server restart, browser refresh,
 * GET /session/current after the in-memory cache was lost). Reconstructs the
 * full grid from the durable module2striketicks history and re-registers the
 * session so minute persistence resumes.
 */
export const resumeSession = async (sessionId: string): Promise<Module2SessionData | null> => {
  if (mongoose.connection.readyState !== 1) {
    console.warn("[TrackerEngine] Cannot resume session — MongoDB not connected.");
    return null;
  }
  if (activeSessions[sessionId]) return activeSessions[sessionId];
  if (!mongoose.isValidObjectId(sessionId)) {
    console.warn(`[TrackerEngine] resumeSession called with non-ObjectId "${sessionId}" — ignored.`);
    return null;
  }

  let doc: any = null;
  try {
    doc = await Module2Session.findById(sessionId);
  } catch (dbErr: any) {
    console.error("[TrackerEngine] resumeSession DB query failed:", dbErr?.message || dbErr);
    return null;
  }
  if (!doc) return null;
  if (doc.status === "STOPPED") {
    console.log(`[TrackerEngine] resumeSession: session=${sessionId} is STOPPED — not resuming.`);
    return null;
  }
  if (isSessionStale(doc)) {
    console.log(`[TrackerEngine] resumeSession: session=${sessionId} is from a previous trading day — retiring.`);
    try {
      await Module2Session.findByIdAndUpdate(sessionId, { status: "STOPPED", stopped_at: new Date() });
    } catch { /* best-effort */ }
    return null;
  }

  const strikes: Record<string, Module2StrikeState> = {};
  const dayOpenPrices = doc.day_open_prices_json as Record<string, number>;

  // Load history via the SAME cross-session same-day source that
  // startTrackerSession() uses — so a refresh / restart shows the identical
  // grid, not just the current session_id's rows.
  const history = await loadSameDayHistoryByStrike({
    userId: String(doc.user_id),
    indexSymbol: doc.index_symbol,
    expiryDate: doc.expiry_date,
    selectedStrikes: doc.selected_strikes_json,
    alwaysIncludeSessionIds: [sessionId],
  });
  console.log(
    `[MODULE2][RECOVERY] session=${sessionId} user=${doc.user_id} strikes=${doc.selected_strikes_json.length} ` +
    `sameDaySessions=${history.sessionIds.length} strikesWithHistory=${history.ticksByStrike.size}`
  );

  // Load per-minute tick history from database to reconstruct the grid
  for (const strike of doc.selected_strikes_json) {
    const ticks = dedupeTicksByMinute(history.ticksByStrike.get(strike) || []);

    const grid: Module2Cell[] = ticks.map((t: any) => ({
      ltp: t.ltp_integer,
      minute: t.cellNorm.minuteIndex,
      timestamp: t.cellNorm.timeString,
      isHigh: t.is_day_high,
      isLow: t.is_day_low,
      oi: t.oi || 0,
      oiDelta: t.oi_delta || 0,
      oiBuy: t.oi_buy || 0,
      oiSell: t.oi_sell || 0,
      source: "mongo",
      ltpMissing: !!t.ltp_missing,
    }));
    if (grid.length > 0) {
      logGridSource(sessionId, strike, "MONGO", `minutes=${grid.length} range=${grid[0].timestamp}-${grid[grid.length - 1].timestamp}`);
    } else {
      logGridSource(sessionId, strike, "NONE", "noSameDayHistory");
    }

    const ltp = grid.length > 0 ? grid[grid.length - 1].ltp : (dayOpenPrices[strike] || 0);
    const dayHigh = ticks.reduce((max, t) => Math.max(max, t.ltp_integer), dayOpenPrices[strike] || 0);
    const dayLow = ticks.reduce((min, t) => Math.min(min, t.ltp_integer), dayOpenPrices[strike] || 0);
    const isDowntrendActive = grid.length > 0 ? ticks[ticks.length - 1].is_downtrend_flagged : false;
    const isDeepLoss = ltp > 0 && dayOpenPrices[strike] > 0 ? ltp < dayOpenPrices[strike] * 0.85 : false;

    // Estimate trend badge from reconstructed grid
    let trendBadge: TrendBadgeState = "FLAT";
    if (grid.length >= 5) {
      const recent = grid.slice(-5).map(c => c.ltp);
      let up = 0, down = 0;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i] > recent[i - 1]) up++;
        if (recent[i] < recent[i - 1]) down++;
      }
      if (down >= 4) trendBadge = "H_TO_L";
      else if (up >= 4) trendBadge = "L_TO_H";
    }

    const oiLatest = grid.length > 0 ? grid[grid.length - 1].oi : 0;
    const oiBuyLatest = grid.length > 0 ? grid[grid.length - 1].oiBuy : 0;
    const oiSellLatest = grid.length > 0 ? grid[grid.length - 1].oiSell : 0;
    const oiHigh = ticks.reduce((max, t: any) => Math.max(max, t.oi || 0), 0);
    const oiLow = ticks.reduce((min, t: any) => {
      const val = t.oi || 0;
      if (val === 0) return min;
      return min === 0 ? val : Math.min(min, val);
    }, 0);

    // Reconstruct running sum for mean calculation
    const oiRunningSum = ticks.reduce((sum, t: any) => sum + (t.oi || 0), 0);
    const oiRowCount = ticks.length;
    const oiMean = oiRowCount > 0 ? Math.round(oiRunningSum / oiRowCount) : oiLatest;
    const openPrice = dayOpenPrices[strike] || 0;

    strikes[strike] = {
      strike,
      dayOpen: openPrice,
      dayHigh,
      dayLow,
      grid,
      trendBadge,
      isDowntrendActive,
      isDeepLoss,
      pctChange: openPrice > 0 ? Number((((ltp - openPrice) / openPrice) * 100).toFixed(2)) : 0,
      oiLatest,
      oiBuyLatest,
      oiSellLatest,
      oiHigh: oiHigh || oiLatest,
      oiLow: oiLow || oiLatest,
      oiMean,
      _oiRunningSum: oiRunningSum,
      _oiRowCount: oiRowCount
    } as any;
  }

  // Restore futures details
  const futuresOI = (doc as any).futures_oi_json || {
    symbol: getFuturesSymbol(doc.index_symbol),
    oiLatest: 0,
    oiDelta: 0,
    oiBuy: 0,
    oiSell: 0,
    oiHigh: 0,
    oiLow: 0
  };

  const strikeStartBoundaries: Record<string, string> = {};
  const rawBoundaries = (doc.strike_start_boundaries || {}) as Record<string, any>;
  for (const [s, b] of Object.entries(rawBoundaries)) {
    if (b) strikeStartBoundaries[s] = typeof b === "string" ? b : new Date(b).toISOString();
  }

  const sessionData: Module2SessionData = {
    sessionId: doc._id.toString(),
    userId: doc.user_id.toString(),
    dataSource: getModule2DataSource(),
    sessionType: doc.session_type as any,
    indexSymbol: doc.index_symbol,
    expiryDate: doc.expiry_date,
    selectedStrikes: doc.selected_strikes_json,
    dayOpenPrices,
    strikes,
    status: "ACTIVE",
    startedAt: doc.started_at || doc.created_at,
    stoppedAt: doc.stopped_at || null,
    strikeStartBoundaries,
    createdAt: doc.created_at,
    futuresOI
  };

  activeSessions[sessionId] = sessionData;
  syncAetramSubscriptions().catch((err) =>
    console.error("[TrackerEngine] Aetram subscription sync failed on session resume:", err)
  );
  return sessionData;
};

/**
 * Resumes (or returns the in-memory) ACTIVE session for a user — used by
 * GET /session/current so a browser refresh / socket reconnect / backend
 * restart does not lose the user's tracker (Problem 5).
 */
export const resumeSessionForUser = async (userId: string): Promise<Module2SessionData | null> => {
  const inMemory = Object.values(activeSessions).find((s) => s.userId === userId);
  if (inMemory) return inMemory;

  if (mongoose.connection.readyState !== 1) return null;
  let doc: any = null;
  try {
    doc = await Module2Session.findOne({ user_id: userId, status: "ACTIVE" }).sort({ created_at: -1 }).lean();
  } catch (err: any) {
    console.error("[TrackerEngine] resumeSessionForUser query failed:", err?.message || err);
    return null;
  }
  if (!doc) return null;
  if (isSessionStale(doc)) {
    try {
      await Module2Session.findByIdAndUpdate(doc._id, { status: "STOPPED", stopped_at: new Date() });
    } catch { /* best-effort */ }
    console.log(`[TrackerEngine] resumeSessionForUser: retired stale session=${String(doc._id)} for user=${userId}.`);
    return null;
  }
  return await resumeSession(String(doc._id));
};

/**
 * Gets session data from cache or loads it from DB
 */
export const getSessionData = async (sessionId: string): Promise<Module2SessionData | null> => {
  if (activeSessions[sessionId]) {
    return activeSessions[sessionId];
  }
  return await resumeSession(sessionId);
};

/**
 * Helper to compute elapsed minutes since the baseline 9:15 AM (or session start)
 */
const getMinutesSinceStart = (): number => {
  return getMinutesSinceMarketOpenIST(Date.now());
};

/**
 * Real-time tick ingestion for Module 2 active tracker sessions.
 * Initializes Day Open baseline and broadcasts immediate updates when the first valid
 * tick arrives for a strike, ensuring UI updates instantly without waiting for minute boundaries.
 */
export const onLiveTickReceived = (symbol: string, ltp: number) => {
  if (ltp <= 0) return;
  // After market close, ignore any straggler ticks so the current-minute cell
  // and the timeline stay frozen at the 15:30 IST close. Sessions/grids are
  // untouched — the last real minute remains the last displayed minute.
  if (!isModule2TrackingMinuteAllowed()) return;
  const norm = normalizeCandleTimestamp(Date.now());
  const currentMinute = norm.minuteIndex;
  const timeString = norm.timeString;

  for (const sessionId of Object.keys(activeSessions)) {
    const session = activeSessions[sessionId];
    if (session.selectedStrikes.includes(symbol)) {
      upsertStrikeStatus(sessionId, symbol, { resolved: true, subscribed: true, lastTickAt: Date.now() });
      let strikeState = session.strikes[symbol];
      if (!strikeState) {
        strikeState = {
          strike: symbol,
          dayOpen: ltp,
          dayHigh: ltp,
          dayLow: ltp,
          grid: [],
          trendBadge: "FLAT",
          isDowntrendActive: false,
          isDeepLoss: false,
          pctChange: 0,
          oiLatest: 0,
          oiBuyLatest: 0,
          oiSellLatest: 0,
          oiHigh: 0,
          oiLow: 0,
          oiMean: 0,
          _oiRunningSum: 0,
          _oiRowCount: 0
        } as any;
        session.strikes[symbol] = strikeState;
      }

      if (strikeState.dayOpen === 0) {
        strikeState.dayOpen = ltp;
        strikeState.dayHigh = ltp;
        strikeState.dayLow = ltp;
        session.dayOpenPrices[symbol] = ltp;
        console.log(`[TRACKER][BASELINE] Initialized Day Open baseline for ${symbol}: ${ltp}`);
      } else {
        strikeState.dayHigh = strikeState.dayHigh > 0 ? Math.max(strikeState.dayHigh, ltp) : ltp;
        strikeState.dayLow = (strikeState.dayLow && strikeState.dayLow > 0) ? Math.min(strikeState.dayLow, ltp) : ltp;
      }

      const denominator = strikeState.dayOpen || ltp;
      strikeState.pctChange = denominator > 0 ? Number((((ltp - denominator) / denominator) * 100).toFixed(2)) : 0;

      // Update any initial 0 LTP cell in grid if this is the first live price
      for (const cell of strikeState.grid) {
        if (cell.ltp === 0 && ltp > 0) {
          cell.ltp = ltp;
          cell.isHigh = true;
          cell.isLow = true;
        }
      }

      // Find or create current active minute cell in grid
      let currentCell = strikeState.grid.find(c => c.timestamp === timeString || c.minute === currentMinute);
      if (currentCell) {
        currentCell.ltp = ltp;
        currentCell.isHigh = ltp === strikeState.dayHigh;
        currentCell.isLow = ltp === strikeState.dayLow;
      } else {
        currentCell = {
          ltp,
          minute: currentMinute,
          timestamp: timeString,
          isHigh: ltp === strikeState.dayHigh,
          isLow: ltp === strikeState.dayLow,
          oi: strikeState.oiLatest || 0,
          oiDelta: 0,
          oiBuy: strikeState.oiBuyLatest || 0,
          oiSell: strikeState.oiSellLatest || 0,
          source: "live"
        };
        strikeState.grid.push(currentCell);
      }

      if (process.env.MODULE2_DEBUG_TICKS === "true") {
        console.log(`[SOCKET][BROADCAST][TICK] session=${sessionId} symbol=${symbol} minute=${timeString} ltp=${ltp}`);
      }
      broadcastTrackerUpdate(sessionId, {
        strike: symbol,
        cell: currentCell,
        state: {
          ltp: ltp,
          dayOpen: strikeState.dayOpen,
          dayHigh: strikeState.dayHigh,
          dayLow: strikeState.dayLow,
          trendBadge: strikeState.trendBadge,
          isDowntrendActive: strikeState.isDowntrendActive,
          isDeepLoss: strikeState.isDeepLoss,
          pctChange: strikeState.pctChange,
          oiLatest: strikeState.oiLatest,
          oiBuyLatest: strikeState.oiBuyLatest,
          oiSellLatest: strikeState.oiSellLatest,
          oiHigh: strikeState.oiHigh,
          oiLow: strikeState.oiLow,
          oiMean: strikeState.oiMean
        },
        futuresOI: session.futuresOI
      });
    }
  }
};
  