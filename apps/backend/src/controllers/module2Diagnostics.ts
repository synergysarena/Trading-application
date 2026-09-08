import { Response } from "express";
import mongoose from "mongoose";
import { AuthenticatedRequest } from "../middleware/auth";
import { Module2Session } from "../models/Module2Session";
import { Module2StrikeTick } from "../models/Module2StrikeTick";
import {
  activeSessions,
  resumeSessionForUser,
  getStrikeSubscriptionStatuses,
  getModule2RuntimeStats,
} from "../services/trackerService";
import { getModule2PersistenceMetrics } from "../services/module2PersistenceService";
import { getISTMinuteBucket } from "@stock/shared";

/**
 * GET /api/module2/session/diagnostics
 *
 * READ-ONLY reconciliation of the requesting user's current tracker session:
 * selected strikes vs. what is actually in module2striketicks, per-strike doc
 * counts, first/last minute, missing minutes, duplicate logical minutes, plus
 * live subscription status and persistence health. Never writes anything.
 * Follows the same auth as every other tracker route.
 */
export const getModule2SessionDiagnostics = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const runtime = getModule2RuntimeStats();
    const persistence = getModule2PersistenceMetrics();

    // Resolve the target session: query param sessionId (must belong to the
    // user), else the user's current ACTIVE session.
    const requestedId = (req.query.sessionId as string || "").trim();
    let sessionDoc: any = null;

    if (mongoose.connection.readyState === 1) {
      if (requestedId && mongoose.isValidObjectId(requestedId)) {
        sessionDoc = await Module2Session.findOne({ _id: requestedId, user_id: userId }).lean();
      } else {
        sessionDoc =
          (await Module2Session.findOne({ user_id: userId, status: "ACTIVE" }).sort({ created_at: -1 }).lean()) ||
          (await Module2Session.findOne({ user_id: userId }).sort({ created_at: -1 }).lean());
      }
    }

    if (!sessionDoc) {
      // Fall back to in-memory (also triggers recovery) so the endpoint still
      // reports something useful right after a restart.
      const live = await resumeSessionForUser(userId);
      return res.status(200).json({
        session: live ? { sessionId: live.sessionId, status: live.status, selectedStrikes: live.selectedStrikes } : null,
        note: sessionDoc ? undefined : "No persisted session found for this user.",
        runtime,
        persistence,
        strikeSubscriptionStatus: getStrikeSubscriptionStatuses(live?.sessionId),
      });
    }

    const sessionId = String(sessionDoc._id);
    const selectedStrikes: string[] = sessionDoc.selected_strikes_json || [];
    const inMemory = !!activeSessions[sessionId];

    // Per-strike aggregation straight from the durable collection.
    // Match both ObjectId and string session_id so any legacy rows are included.
    const sessionMatch: any[] = [new mongoose.Types.ObjectId(sessionId), sessionId];
    const agg = await Module2StrikeTick.aggregate([
      { $match: { session_id: { $in: sessionMatch } } },
      {
        $group: {
          _id: "$strike",
          docs: { $sum: 1 },
          first: { $min: "$minute_timestamp" },
          last: { $max: "$minute_timestamp" },
          minuteKeys: {
            $addToSet: {
              $dateToString: { date: "$minute_timestamp", format: "%Y-%m-%d %H:%M", timezone: "Asia/Kolkata" },
            },
          },
          missingCount: { $sum: { $cond: [{ $eq: ["$ltp_missing", true] }, 1, 0] } },
        },
      },
    ]);

    const byStrike = new Map<string, any>(agg.map((a: any) => [a._id, a]));

    // The union of every minute captured for ANY strike in this session is the
    // best available "active minutes" baseline (gaps from stop/restart are not
    // in the union, so they are correctly NOT counted as missing).
    const unionMinutes = new Set<string>();
    for (const a of agg) for (const k of a.minuteKeys) unionMinutes.add(k);

    const subStatuses = getStrikeSubscriptionStatuses(sessionId);
    const subByStrike = new Map(subStatuses.map((s) => [s.strike, s]));

    // In-memory grid provenance (what the live UI is actually showing right now).
    const liveSession = activeSessions[sessionId];
    const gridSourceByStrike = new Map<string, { mongo: number; live: number; untagged: number; firstTs: string | null }>();
    if (liveSession) {
      for (const [strike, st] of Object.entries(liveSession.strikes || {})) {
        let mongo = 0, live = 0, untagged = 0;
        for (const c of (st as any).grid || []) {
          if (c.source === "mongo") mongo++;
          else if (c.source === "live") live++;
          else untagged++;
        }
        gridSourceByStrike.set(strike, {
          mongo, live, untagged,
          firstTs: (st as any).grid?.[0]?.timestamp ?? null,
        });
      }
    }

    const startedAtIST = sessionDoc.started_at ? getISTMinuteBucket(sessionDoc.started_at) : null;

    const rows = selectedStrikes.map((strike) => {
      const a = byStrike.get(strike);
      const minuteSet: Set<string> = new Set(a ? a.minuteKeys : []);
      const missingMinutes = Array.from(unionMinutes).filter((m) => !minuteSet.has(m)).sort();
      const duplicateLogicalMinutes = a ? a.docs - minuteSet.size : 0;
      const sub = subByStrike.get(strike);
      const gs = gridSourceByStrike.get(strike);
      const firstMinuteIST = a ? getISTMinuteBucket(a.first) : null;
      return {
        strike,
        selected: true,
        inMemory,
        subscribed: sub?.subscribed ?? false,
        resolved: sub?.resolved ?? false,
        lastTickAt: sub?.lastTickAt ? new Date(sub.lastTickAt).toISOString() : null,
        lastResolveError: sub?.lastResolveError ?? null,
        mongoDocs: a ? a.docs : 0,
        uniqueMinutes: minuteSet.size,
        duplicateLogicalMinutes,
        placeholderMinutes: a ? a.missingCount : 0,
        firstMinuteIST,
        lastMinuteIST: a ? getISTMinuteBucket(a.last) : null,
        // If the earliest persisted minute predates this session's start, that
        // history was restored from an EARLIER same-day session (legit stitching)
        // — never from Redis or fabricated.
        historyPredatesSessionStart: !!(firstMinuteIST && startedAtIST && firstMinuteIST < startedAtIST),
        liveGridCells: gs ? { fromMongo: gs.mongo, fromLive: gs.live, untagged: gs.untagged, firstColumn: gs.firstTs } : null,
        missingMinuteCount: missingMinutes.length,
        missingMinutes: missingMinutes.slice(0, 200),
      };
    });

    // Strikes with ticks that are NOT in the current selection (e.g. removed mid-session).
    const orphanRows = agg
      .filter((a: any) => !selectedStrikes.includes(a._id))
      .map((a: any) => ({
        strike: a._id,
        selected: false,
        mongoDocs: a.docs,
        uniqueMinutes: new Set(a.minuteKeys).size,
        firstMinuteIST: getISTMinuteBucket(a.first),
        lastMinuteIST: getISTMinuteBucket(a.last),
      }));

    const totalExpected = selectedStrikes.length * unionMinutes.size;
    const totalActual = rows.reduce((n, r) => n + r.uniqueMinutes, 0);

    // Which same-day sessions for this user/index/expiry exist — the legit
    // source of any "value before this session's start time".
    let sameDaySessions: any[] = [];
    if (mongoose.connection.readyState === 1) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      sameDaySessions = await Module2Session.find({
        user_id: userId,
        index_symbol: sessionDoc.index_symbol,
        expiry_date: sessionDoc.expiry_date,
        created_at: { $gte: startOfDay },
      })
        .select("_id status started_at stopped_at selected_strikes_json")
        .sort({ created_at: 1 })
        .lean();
    }

    const anyPredates = rows.some((r) => r.historyPredatesSessionStart);
    const anyUntagged = rows.some((r) => (r.liveGridCells?.untagged ?? 0) > 0);

    return res.status(200).json({
      historicalDataExplanation: {
        rule:
          "Historical minutes come ONLY from module2striketicks across today's sessions for this user/index/expiry. " +
          "Redis / in-memory state is never used to build historical cells.",
        valuesBeforeSessionStartArePresent: anyPredates,
        source: anyPredates ? "restored from earlier same-day session(s) — see sameDaySessions[]" : "none",
        untaggedGridCellsPresent: anyUntagged, // should be false for canonical sessions
        sameDaySessionCount: sameDaySessions.length,
      },
      sameDaySessions: sameDaySessions.map((s: any) => ({
        sessionId: String(s._id),
        status: s.status,
        startedAt: s.started_at,
        stoppedAt: s.stopped_at,
        strikeCount: (s.selected_strikes_json || []).length,
        isCurrent: String(s._id) === sessionId,
      })),
      session: {
        sessionId,
        status: sessionDoc.status,
        inMemory,
        userId: sessionDoc.user_id,
        indexSymbol: sessionDoc.index_symbol,
        expiryDate: sessionDoc.expiry_date,
        startedAt: sessionDoc.started_at,
        stoppedAt: sessionDoc.stopped_at,
        selectedStrikeCount: selectedStrikes.length,
        strikeStartBoundaries: sessionDoc.strike_start_boundaries || {},
      },
      reconciliation: {
        activeMinutesObserved: unionMinutes.size,
        expectedLogicalRecords: totalExpected,
        actualLogicalRecords: totalActual,
        discrepancy: totalExpected - totalActual,
      },
      strikes: rows,
      orphanStrikes: orphanRows,
      strikeSubscriptionStatus: subStatuses,
      runtime,
      persistence,
    });
  } catch (error: any) {
    console.error("[MODULE2][DIAGNOSTICS] endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
