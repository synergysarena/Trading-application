import { Module2Session } from "../models/Module2Session";
import { Module2StrikeTick } from "../models/Module2StrikeTick";
import { readLive } from "./redisWriteBuffer";
import { broadcastTrackerUpdate } from "./socketService";
import { Module2SessionData, Module2StrikeState, Module2Cell, TrendBadgeState } from "@stock/shared";
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
  console.log("[MODULE2][TRACKER] syncAetramSubscriptions started");
  const desiredMap = new Map<string, { segment: number; token: string }>();

  for (const session of Object.values(activeSessions)) {
    const resolvedList = await Promise.all(
      session.selectedStrikes.map(async (strike) => {
        try {
          const inst = await resolveOptionStrikeToken(session.indexSymbol, session.expiryDate, strike);
          return inst;
        } catch (err) {
          console.error(`[MODULE2][TRACKER][INSTRUMENT] Error resolving Aetram strike ${strike}:`, err);
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

  console.log(`[AETRAM][SUBSCRIPTION] activeSessions=${Object.keys(activeSessions).length} desired=${desiredMap.size} added=${toSubscribe.length} removed=${toUnsubscribe.length}`);

  if (toUnsubscribe.length > 0) {
    await unsubscribeFromInstruments(toUnsubscribe);
  }

  if (toSubscribe.length > 0) {
    await subscribeToInstruments(toSubscribe);
  }
};

export const stopTrackerSession = async (sessionId: string) => {
  console.log(`[TrackerEngine] Stopping session ${sessionId}`);
  let found = false;

  if (activeSessions[sessionId]) {
    delete activeSessions[sessionId];
    found = true;
  }

  for (const [sId, sess] of Object.entries(activeSessions)) {
    if (sId === sessionId || sess.sessionId === sessionId) {
      delete activeSessions[sId];
      found = true;
    }
  }

  if (found) {
    console.log(`[TrackerEngine] Successfully removed session ${sessionId} from active memory.`);
  }

  // Trigger subscription synchronization non-blockingly
  syncAetramSubscriptions().catch((err) => {
    console.error("[TrackerEngine] Error in syncAetramSubscriptions after stop:", err);
  });
};

/**
 * Initializes the Module 2 tracking engine and schedules the minute boundary loop
 */
export const initTrackerEngine = async () => {
  logModule2InteractiveStatus();

  // Module 2 tracker sessions must NEVER automatically start on backend restart.
  // Sessions only run after explicit user action ("Start Active Session Tracker").
  console.log("[TrackerEngine] Initialized. 0 active tracker sessions running (waiting for explicit user Start).");

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
      console.error("[TrackerEngine] Error executing minute boundary:", error);
    }
    // Re-schedule
    scheduleNextMinuteBoundary();
  }, delay);
};

/**
 * Executed on every minute boundary. Captures prices, updates grids, and broadcasts events.
 */
const executeMinuteBoundary = async () => {
  const timestamp = new Date();
  const minutesSinceStart = getMinutesSinceStart();
  const timeString = timestamp.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });

  const sessionIds = Object.keys(activeSessions);
  if (sessionIds.length === 0) return;

  console.log(`[TrackerEngine] Boundary trigger at ${timeString}. Processing ${sessionIds.length} sessions...`);

  for (const sessionId of sessionIds) {
    const session = activeSessions[sessionId];

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
        oiSell = oiDelta < 0 ? oiDelta : 0;
      }

      // Update High/Low boundaries for Price
      if (ltp > 0) {
        strikeState.dayHigh = strikeState.dayHigh ? Math.max(strikeState.dayHigh, ltp) : ltp;
        strikeState.dayLow = (strikeState.dayLow && strikeState.dayLow > 0) ? Math.min(strikeState.dayLow, ltp) : ltp;
      }

      const denominator = strikeState.dayOpen || ltp;
      strikeState.pctChange = denominator > 0 ? Number((((ltp - denominator) / denominator) * 100).toFixed(2)) : 0;

      // Update boundaries for OI
      if (isFirstRow) {
        // First row: seed High and Low from initial OI value
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
        // Seed running sum on first row
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
      recentLtpList.push(ltp); // Include current tick to form 5-min lookback

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

      // Handle Trend Reversal Detection
      if (previousBadge === "H_TO_L" && newBadge === "FLAT" && recentLtpList.length >= 2 && recentLtpList[recentLtpList.length - 1] > recentLtpList[recentLtpList.length - 2]) {
        newBadge = "REVERSAL";
      } else if (previousBadge === "L_TO_H" && newBadge === "FLAT" && recentLtpList.length >= 2 && recentLtpList[recentLtpList.length - 1] < recentLtpList[recentLtpList.length - 2]) {
        newBadge = "REVERSAL";
      }

      strikeState.trendBadge = newBadge;

      // 4. Evaluate Call-Down Advisory Filter (CE options only)
      const isCE = strike.endsWith("CE");
      if (isCE) {
        // Deep Loss Check (>15% drop from baseline)
        if (ltp < strikeState.dayOpen * 0.85) {
          strikeState.isDeepLoss = true;
        }

        // Downtrend Check (3 consecutive minutes declining)
        const recent3 = strikeState.grid.slice(-2).map(c => c.ltp);
        recent3.push(ltp);
        if (recent3.length >= 3 && recent3[0] > recent3[1] && recent3[1] > recent3[2]) {
          strikeState.isDowntrendActive = true;
        }

        // Recovery Check (2 consecutive rising minutes clears all alerts)
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
        isHigh: ltp === strikeState.dayHigh,
        isLow: ltp === strikeState.dayLow,
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
      } catch (err) {
        // Suppress warning to avoid console spamming when DB is offline
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
  }
};

/**
 * Starts a new Module 2 tracking session
 */
export const startTrackerSession = async (
  userId: string,
  sessionType: "CE" | "PE" | "mixed",
  indexSymbol: string,
  expiryDate: string,
  selectedStrikes: string[]
): Promise<Module2SessionData> => {
  console.log("[MODULE2][TRACKER] startTrackerSession execution started");

  // Deactivate any previous active sessions for this user to prevent stale strike retention
  for (const [sId, sess] of Object.entries(activeSessions)) {
    if (sess.userId === userId) {
      console.log(`[TrackerEngine] Deactivating previous active session ${sId} for user ${userId}`);
      delete activeSessions[sId];
    }
  }

  // Capture Day Open prices and OI for each selected strike from Redis
  const dayOpenPrices: Record<string, number> = {};
  const strikes: Record<string, Module2StrikeState> = {};
  const initialMinutes = getMinutesSinceStart();
  const initialTimeString = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });

  for (const strike of selectedStrikes) {
    const rawPrice = await readLive(`ltp:${strike}`);
    const ltp = rawPrice ? parseFloat(rawPrice) : 0; // Capture baseline at first observation

    const rawOi = await readLive(`oi:${strike}`);
    const oi = rawOi ? Math.floor(parseFloat(rawOi)) : 0;

    dayOpenPrices[strike] = ltp;

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

    strikes[strike] = {
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
      futures_oi_json: futuresOI
    });
    sessionId = doc._id.toString();
    createdAt = doc.created_at;
  } catch (dbErr: any) {
    console.warn(`[TrackerEngine] DB save error (${dbErr?.message || dbErr}). Fallback to in-memory session.`);
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
    createdAt,
    futuresOI
  };

  // Add to local active sessions cache
  activeSessions[sessionId] = sessionData;

  // Trigger Aetram subscription synchronization
  try {
    await syncAetramSubscriptions();
  } catch (err) {
    console.error("[TrackerEngine] Aetram subscription sync failed:", err);
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
  const initialMinutes = getMinutesSinceStart();
  const initialTimeString = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });

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

    const grid: Module2Cell[] = ticks.map((t: any, idx) => ({
      ltp: t.ltp_integer,
      minute: idx,
      timestamp: t.minute_timestamp.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit"
      }),
      isHigh: t.is_day_high,
      isLow: t.is_day_low,
      oi: t.oi || 0,
      oiDelta: t.oi_delta || 0,
      oiBuy: t.oi_buy || 0,
      oiSell: t.oi_sell || 0
    }));

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
  const now = new Date();
  const start = new Date();
  start.setHours(9, 15, 0, 0);

  // If before 9:15 AM, return 0 (grid starts index 0)
  if (now.getTime() < start.getTime()) return 0;

  return Math.floor((now.getTime() - start.getTime()) / 60000);
};

/**
 * Real-time tick ingestion for Module 2 active tracker sessions.
 * Initializes Day Open baseline and broadcasts immediate updates when the first valid
 * tick arrives for a strike, ensuring UI updates instantly without waiting for minute boundaries.
 */
export const onLiveTickReceived = (symbol: string, ltp: number) => {
  if (ltp <= 0) return;
  const now = new Date();
  const currentMinute = getMinutesSinceStart();
  const timeString = now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });

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
