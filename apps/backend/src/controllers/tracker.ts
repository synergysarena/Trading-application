import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { Module2Session } from "../models/Module2Session";
import {
  startTrackerSession,
  stopTrackerSession,
  updateTrackerStrikes,
  getSessionData,
  activeSessions
} from "../services/trackerService";
import {
  Module2SessionStartSchema,
  Module2StrikeUpdateSchema,
  Module2FiltersSchema,
  Module2SessionData
} from "@stock/shared";

// Start Module 2 Session
export const startSession = async (req: AuthenticatedRequest, res: Response) => {
  console.log("[MODULE2][TRACKER] Request received at backend /api/module2/session/start");
  try {
    const userId = req.user?.id;
    if (!userId) {
      console.error("[MODULE2][TRACKER] Unauthorized: No user ID");
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    console.log("[MODULE2][TRACKER] Authenticated module/session state:", { userId });

    const parseResult = Module2SessionStartSchema.safeParse(req.body);
    if (!parseResult.success) {
      console.error("[MODULE2][TRACKER] Validation failed:", parseResult.error.errors);
      return res.status(400).json({ error: "Validation failed", details: parseResult.error.errors });
    }

    const { sessionType, indexSymbol, expiryDate, selectedStrikes } = parseResult.data;
    
    console.log("[MODULE2][TRACKER] Symbol:", indexSymbol);
    console.log("[MODULE2][TRACKER] Expiry:", expiryDate);
    console.log("[MODULE2][TRACKER] Session type:", sessionType);
    console.log("[MODULE2][TRACKER] Selected strikes:", selectedStrikes);
    console.log("[MODULE2][TRACKER] Strike count:", selectedStrikes?.length);

    // Start new session
    console.log("[MODULE2][TRACKER] Calling startTrackerSession...");
    const session = await startTrackerSession(
      userId,
      sessionType,
      indexSymbol,
      expiryDate,
      selectedStrikes
    );

    console.log("[MODULE2][TRACKER] startTrackerSession returned:", session ? "Session Data" : "null/undefined");
    if (session) {
      console.log("[MODULE2][TRACKER] Tracker/session ID:", session.sessionId);
    }
    return res.status(201).json(session);
  } catch (error) {
    console.error("[MODULE2][TRACKER] Start Session Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// Stop Module 2 Session
export const stopSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { sessionId } = (req.body || {}) as { sessionId?: string };
    console.log(`[MODULE2-TRACKER] Stop request received for user=${userId} sessionId=${sessionId || "ALL"}`);

    if (sessionId) {
      // Stop strictly this targeted session
      await stopTrackerSession(sessionId);
      delete activeSessions[sessionId];
      Module2Session.findByIdAndDelete(sessionId).catch(() => {});
    } else {
      // Fallback: stop all sessions strictly belonging to this user
      const userActiveSessionIds = Object.keys(activeSessions).filter(
        (sId) => activeSessions[sId].userId === userId
      );
      for (const sId of userActiveSessionIds) {
        await stopTrackerSession(sId);
        delete activeSessions[sId];
      }
    }

    console.log(`[MODULE2-TRACKER] Session stop complete for user=${userId} sessionId=${sessionId || "ALL"}. Remaining total sessions: ${Object.keys(activeSessions).length}`);
    return res.status(200).json({ status: "success", message: "Session stopped successfully" });

  } catch (error) {
    console.error("[MODULE2-TRACKER] Stop Session Error:", error);
    return res.status(200).json({ status: "success", message: "Session stopped successfully" });
  }
};


// Get current active session for user
export const getCurrentSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Only return a session if it is actively running in memory
    const userActiveSession = Object.values(activeSessions).find(
      (s) => s.userId === userId
    );

    if (userActiveSession) {
      return res.status(200).json(userActiveSession);
    }

    return res.status(200).json(null);
  } catch (error) {
    console.error("Get Current Session Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// Update strikes list in the active session
export const updateStrikes = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parseResult = Module2StrikeUpdateSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: "Validation failed", details: parseResult.error.errors });
    }

    const { selectedStrikes } = parseResult.data;

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let doc = null;
    try {
      doc = await Module2Session.findOne({
        user_id: userId,
        created_at: { $gte: today }
      }).sort({ created_at: -1 });
    } catch (err) {
      console.warn("[Tracker] DB offline during updateStrikes. Checking memory cache.");
    }

    let sessionId: string | null = null;
    if (doc) {
      sessionId = doc._id.toString();
    } else {
      // Fallback: check in-memory activeSessions
      const userSessions = Object.values(activeSessions).filter(
        (s) => s.userId === userId && new Date(s.createdAt).getTime() >= today.getTime()
      );
      if (userSessions.length > 0) {
        sessionId = userSessions[userSessions.length - 1].sessionId;
      }
    }

    if (!sessionId) {
      return res.status(404).json({ error: "No active session found for today" });
    }

    const updatedSession = await updateTrackerStrikes(sessionId, selectedStrikes);
    return res.status(200).json(updatedSession);
  } catch (error) {
    console.error("Update Strikes Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// Update filters settings (Front-end stores them, but this updates backend state cache if required)
export const updateFilters = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parseResult = Module2FiltersSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: "Validation failed", details: parseResult.error.errors });
    }

    return res.status(200).json({
      message: "Filters updated successfully",
      filters: parseResult.data
    });
  } catch (error) {
    console.error("Update Filters Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// Export Grid as CSV
export const exportCSV = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let doc = null;
    try {
      doc = await Module2Session.findOne({
        user_id: userId,
        created_at: { $gte: today }
      }).sort({ created_at: -1 });
    } catch (err) {
      console.warn("[Tracker] DB offline during exportCSV. Checking memory cache.");
    }

    let sessionId: string | null = null;
    if (doc) {
      sessionId = doc._id.toString();
    } else {
      const userSessions = Object.values(activeSessions).filter(
        (s) => s.userId === userId && new Date(s.createdAt).getTime() >= today.getTime()
      );
      if (userSessions.length > 0) {
        sessionId = userSessions[userSessions.length - 1].sessionId;
      }
    }

    if (!sessionId) {
      return res.status(404).json({ error: "No active session found for today" });
    }

    const session = await getSessionData(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session data not found" });
    }

    const csvContent = buildCSV(session);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=session_${sessionId}.csv`);
    return res.status(200).send(csvContent);
  } catch (error) {
    console.error("CSV Export Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * Builds CSV string from active session data
 */
const buildCSV = (session: Module2SessionData): string => {
  let maxMinutes = 0;
  for (const state of Object.values(session.strikes)) {
    maxMinutes = Math.max(maxMinutes, state.grid.length);
  }

  const headers = [
    "Strike", "Day Open", "Day High", "Day Low", "Trend Badge", "Pct Change",
    "OI Buy (Latest)", "OI Sell (Latest)", "OI High", "OI Low"
  ];
  
  const firstStrikeKey = Object.keys(session.strikes)[0];
  const firstStrike = firstStrikeKey ? session.strikes[firstStrikeKey] : null;

  for (let m = 0; m < maxMinutes; m++) {
    const timeLabel = firstStrike?.grid[m]?.timestamp || `Min ${m}`;
    headers.push(timeLabel);
  }

  const csvRows = [headers.join(",")];

  for (const strike of session.selectedStrikes) {
    const s = session.strikes[strike];
    if (!s) continue;

    const row = [
      s.strike,
      s.dayOpen,
      s.dayHigh,
      s.dayLow,
      s.trendBadge,
      `${s.pctChange}%`,
      s.oiBuyLatest || 0,
      s.oiSellLatest || 0,
      s.oiHigh || 0,
      s.oiLow || 0
    ];

    for (let m = 0; m < maxMinutes; m++) {
      const cell = s.grid[m];
      if (cell) {
        let val = cell.ltp.toString();
        if (cell.isHigh) val += " (H)";
        if (cell.isLow) val += " (L)";
        row.push(val);
      } else {
        row.push("");
      }
    }
    csvRows.push(row.join(","));
  }

  return csvRows.join("\n");
};
