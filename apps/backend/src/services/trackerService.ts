import { Module2Session } from "../models/Module2Session";
import { Module2StrikeTick } from "../models/Module2StrikeTick";
import { readLive } from "./redisWriteBuffer";
import { broadcastTrackerUpdate } from "./socketService";
import {
  Module2SessionData,
  Module2StrikeState,
  Module2Cell,
  TrendBadgeState,
  formatISTTime,
  getMinutesSinceMarketOpenIST,
  normalizeCandleTimestamp,
} from "@stock/shared";
import { getModule2DataSource, logModule2InteractiveStatus } from "./module2InteractiveDataService";
import { resolveOptionStrikeToken, subscribeToInstruments, unsubscribeFromInstruments, getActiveSubscribedInstruments, setOnAetramReconnect } from "./aetramMarketDataService";

// In-memory cache for active tracker sessions to avoid database load
export const activeSessions: Record<string, Module2SessionData> = {};

let boundaryTimer: NodeJS.Timeout | null = null;

/**
 * Helper to resolve the futures symbol for a given index symbol
 */
const getFuturesSymbol = (index: string): string => {
  if (index === "NIFTY50") return "NIFTY-FUT";
  if (index === "BANKNIFTY") return "BANKNIFTY-FUT";
  if (index === "FINNIFTY") return "FINNIFTY-FUT";
  return `${index}-FUT`;
};

/**
 * Initializes the Module 2 tracking engine and schedules the minute boundary loop
 */
/**
 * Synchronizes active option strike subscriptions with AETRAM MarketData API
 */
export const syncAetramSubscriptions = async () => {
  const desiredMap = new Map<string, { segment: number; token: string }>();

  for (const session of Object.values(activeSessions)) {
    const resolvedList = await Promise.all(
      session.selectedStrikes.map(async (strike) => {
        try {
          const inst = await resolveOptionStrikeToken(session.indexSymbol, session.expiryDate, strike);
          return inst;
        } catch (err) {
          console.error(`[MODULE2-SUBSCRIPTION][INSTRUMENT_ERROR] Strike ${strike}:`, err);
          return null;
        }
      })
    );

    for (const inst of resolvedList) {
      if (inst) {
        const key = `${inst.segment}|${inst.token}`;
        desiredMap.set(key, inst);
      }
    }
  }

  const currentlySubscribed = getActiveSubscribedInstruments();
  const currentlySubscribedSet = new Set(currentlySubscribed.map((i: { segment: number; token: string }) => `${i.segment}|${i.token}`));
  const desiredKeys = new Set(desiredMap.keys());

  const toSubscribe: Array<{ segment: number; token: string }> = [];
  for (const [key, inst] of desiredMap.entries()) {
    if (!currentlySubscribedSet.has(key)) {
      toSubscribe.push(inst);
    }
  }

  const toUnsubscribe: Array<{ segment: number; token: string }> = [];
  for (const inst of currentlySubscribed) {
    const key = `${inst.segment}|${inst.token}`;
    if (!desiredKeys.has(key)) {
      toUnsubscribe.push(inst);
    }
  }

  console.log(`[MODULE2-SUBSCRIPTION] activeSessions=${Object.keys(activeSessions).length} totalDesired=${desiredMap.size} toSubscribe=${toSubscribe.length} toUnsubscribe=${toUnsubscribe.length}`);

  if (toUnsubscribe.length > 0) {
    await unsubscribeFromInstruments(toUnsubscribe);
  }

  if (toSubscribe.length > 0) {
    await subscribeToInstruments(toSubscribe);
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

  try {
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
 * Initializes the Module 2 tracking engine and schedules the minute boundary loop
 */
export const initTrackerEngine = async () => {
  logModule2InteractiveStatus();
  console.log("[MODULE2-TRACKER] Initialized. 0 active tracker sessions running (waiting for user Start).");

  // Register reconnect callback so subscriptions for active sessions (if any) are restored on WebSocket reconnect
  setOnAetramReconnect(() => syncAetramSubscriptions());

  // Schedule the minute boundary checker
  scheduleNextMinuteBoundary();
};

/**
 * Schedules execution precisely on clock minute boundaries (00 seconds)
 */
const scheduleNextMinuteBoundary = () => {
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
  const timestamp = new Date(norm.timestampMs);
  const minutesSinceStart = norm.minuteIndex;
  const timeString = norm.timeString;

  const sessionIds = Object.keys(activeSessions);
  if (sessionIds.length === 0) return;

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
      } catch (err) {
        // Ignore DB write errors
      }

      // 2. Process Options Strikes
      for (const strike of session.selectedStrikes) {
        // Fetch latest price & OI from Redis cache
        const rawPrice = await readLive(`ltp:${strike}`);
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
          } catch (err) {
            // Ignore DB connection errors in offline mode
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

        // Create new cell
        const cell: Module2Cell = {
          ltp,
          minute: minutesSinceStart,
          timestamp: timeString,
          isHigh,
          isLow,
          oi,
          oiDelta,
          oiBuy,
          oiSell
        };

        console.log(`[AGGREGATION][MINUTE] symbol=${strike} minute=${timeString} open=${strikeState.dayOpen} high=${strikeState.dayHigh} low=${strikeState.dayLow} close=${ltp}`);

        const existingCellIdx = strikeState.grid.findIndex((c) => c.minute === minutesSinceStart || c.timestamp === timeString);
        if (existingCellIdx >= 0) {
          strikeState.grid[existingCellIdx] = cell;
        } else {
          strikeState.grid.push(cell);
        }

        // Save to Database
        try {
          await Module2StrikeTick.create({
            session_id: sessionId,
            strike,
            minute_timestamp: timestamp,
            ltp_integer: ltp,
            is_day_high: cell.isHigh,
            is_day_low: cell.isLow,
            pct_from_open: strikeState.pctChange,
            is_downtrend_flagged: strikeState.isDowntrendActive,
            oi,
            oi_delta: oiDelta,
            oi_buy: oiBuy,
            oi_sell: oiSell
          });
        } catch (err: any) {
          // Suppress duplicate key or DB connection warnings
          if (err?.code !== 11000) {
            // non-duplicate error
          }
        }

        // Broadcast to connected clients
        console.log(`[SOCKET][BROADCAST] session=${sessionId} symbol=${strike} ltp=${ltp}`);
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
  console.log(`[MODULE2-TRACKER] START REQUEST userId=${userId} index=${indexSymbol} expiry=${expiryDate} strikes=${selectedStrikes.length}`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find previous sessions from today for this user, symbol, and expiry to restore historical strike data
  let previousSessionIds: any[] = [];
  const existingStrikeStartBoundaries: Record<string, string> = {};
  try {
    const previousDocs = await Module2Session.find({
      user_id: userId,
      index_symbol: indexSymbol,
      expiry_date: expiryDate,
      created_at: { $gte: today },
    }).select("_id strike_start_boundaries day_open_prices_json created_at").lean();

    previousSessionIds = previousDocs.map((d: any) => d._id);
    for (const pDoc of previousDocs) {
      if (pDoc.strike_start_boundaries) {
        for (const [s, b] of Object.entries(pDoc.strike_start_boundaries as Record<string, any>)) {
          if (!existingStrikeStartBoundaries[s] && b) {
            existingStrikeStartBoundaries[s] = typeof b === "string" ? b : new Date(b).toISOString();
          }
        }
      }
    }
  } catch (err: any) {
    console.warn("[MODULE2-TRACKER] Could not query previous sessions for history:", err?.message || err);
  }

  const dayOpenPrices: Record<string, number> = {};
  const strikes: Record<string, Module2StrikeState> = {};
  const strikeStartBoundaries: Record<string, string> = {};
  const norm = normalizeCandleTimestamp(Date.now());
  const initialMinutes = norm.minuteIndex;
  const initialTimeString = norm.timeString;
  const currentIsoString = new Date(norm.timestampMs).toISOString();

  for (const strike of selectedStrikes) {
    const rawPrice = await readLive(`ltp:${strike}`);
    const liveLtp = rawPrice ? parseFloat(rawPrice) : 0;

    const rawOi = await readLive(`oi:${strike}`);
    const liveOi = rawOi ? Math.floor(parseFloat(rawOi)) : 0;

    // 1. Query previously persisted Module2StrikeTick records for this strike from today's sessions
    let pastTicks: any[] = [];
    if (previousSessionIds.length > 0) {
      try {
        pastTicks = await Module2StrikeTick.find({
          session_id: { $in: previousSessionIds },
          strike,
          minute_timestamp: { $gte: today },
        }).sort({ minute_timestamp: 1 }).lean();
      } catch (dbErr) {
        console.warn(`[MODULE2-TRACKER] Failed to fetch past ticks for strike ${strike}:`, dbErr);
      }
    }

    // 2. Deduplicate past ticks by minute timestamp
    const seenMinutes = new Set<string>();
    const dedupedTicks: any[] = [];
    for (const t of pastTicks) {
      const cellNorm = normalizeCandleTimestamp(t.minute_timestamp);
      if (!seenMinutes.has(cellNorm.timeString)) {
        seenMinutes.add(cellNorm.timeString);
        dedupedTicks.push({ ...t, cellNorm });
      }
    }

    if (dedupedTicks.length > 0) {
      // Historical data exists from an earlier tracking session today
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
      // 3. New strike starting for the first time
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

  // Resolve Futures symbols and fetch details
  const futSymbol = getFuturesSymbol(indexSymbol);
  const rawFutPrice = await readLive(`ltp:${futSymbol}`);
  const rawFutOi = await readLive(`oi:${futSymbol}`);
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

  // Create session record in DB
  let sessionId: string;
  let createdAt: Date;
  try {
    const doc = await Module2Session.create({
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
    });
    sessionId = doc._id.toString();
    createdAt = doc.created_at;
  } catch (dbErr: any) {
    console.warn(`[MODULE2-TRACKER] DB save error (${dbErr?.message || dbErr}). Fallback to in-memory session.`);
    sessionId = "mock-session-" + Date.now() + "-" + Math.random().toString(36).substring(2, 9);
    createdAt = new Date();
  }

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

  // Trigger Aetram subscription synchronization (unions all strikes across all active sessions)
  try {
    await syncAetramSubscriptions();
  } catch (err) {
    console.error("[MODULE2-SUBSCRIPTION] Subscription sync failed on session start:", err);
  }

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
        oiSell: 0
      };

      session.dayOpenPrices[strike] = ltp;
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

  // Remove retired strikes from the active selection
  session.selectedStrikes = newStrikes;

  // Trigger Aetram subscription synchronization in the background
  syncAetramSubscriptions().catch((err) =>
    console.error("[TrackerEngine] Aetram subscription sync failed:", err)
  );

  // Update Database session configuration
  try {
    await Module2Session.findByIdAndUpdate(sessionId, {
      selected_strikes_json: newStrikes,
      day_open_prices_json: session.dayOpenPrices
    });
  } catch (dbErr) {
    console.warn("[TrackerEngine] MongoDB offline. Skipping DB update in updateTrackerStrikes.");
  }

  return session;
};

/**
 * Resumes an active session from the database (e.g. on server restart)
 */
export const resumeSession = async (sessionId: string): Promise<Module2SessionData | null> => {
  let doc = null;
  try {
    doc = await Module2Session.findById(sessionId);
  } catch (dbErr) {
    console.warn("[TrackerEngine] MongoDB offline. Cannot resume session from DB.");
    return null;
  }
  if (!doc) return null;

  const strikes: Record<string, Module2StrikeState> = {};
  const dayOpenPrices = doc.day_open_prices_json as Record<string, number>;

  // Load per-minute tick history from database to reconstruct the grid
  for (const strike of doc.selected_strikes_json) {
    const ticks = await Module2StrikeTick.find({ session_id: sessionId, strike }).sort({ minute_timestamp: 1 });

    const grid: Module2Cell[] = ticks.map((t: any) => {
      const cellNorm = normalizeCandleTimestamp(t.minute_timestamp);
      return {
        ltp: t.ltp_integer,
        minute: cellNorm.minuteIndex,
        timestamp: cellNorm.timeString,
        isHigh: t.is_day_high,
        isLow: t.is_day_low,
        oi: t.oi || 0,
        oiDelta: t.oi_delta || 0,
        oiBuy: t.oi_buy || 0,
        oiSell: t.oi_sell || 0
      };
    });

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
  const norm = normalizeCandleTimestamp(Date.now());
  const currentMinute = norm.minuteIndex;
  const timeString = norm.timeString;

  for (const sessionId of Object.keys(activeSessions)) {
    const session = activeSessions[sessionId];
    if (session.selectedStrikes.includes(symbol)) {
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
          oiSell: strikeState.oiSellLatest || 0
        };
        strikeState.grid.push(currentCell);
      }

      console.log(`[SOCKET][BROADCAST][TICK] session=${sessionId} symbol=${symbol} minute=${timeString} ltp=${ltp}`);
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
