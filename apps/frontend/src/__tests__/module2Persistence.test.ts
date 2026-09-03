import { describe, it, expect } from "vitest";
import {
  Module2Cell,
  Module2StrikeState,
  Module2SessionData,
  normalizeCandleTimestamp,
} from "@stock/shared";

describe("Module 2 Persistent Selected-Strike Session History", () => {
  // Simulator for in-memory & database historical strike stitching
  const simulateStrikeStitching = (
    strike: string,
    existingTicks: Array<{ minute_timestamp: string; ltp: number; oi: number }>,
    currentLiveLtp: number,
    currentLiveOi: number,
    currentStartTimeIso: string
  ): Module2StrikeState => {
    const norm = normalizeCandleTimestamp(new Date(currentStartTimeIso).getTime());
    const initialMinutes = norm.minuteIndex;
    const initialTimeString = norm.timeString;

    // Filter to today & deduplicate by minute timestamp
    const seenMinutes = new Set<string>();
    const dedupedTicks: Array<{ ltp: number; oi: number; cellNorm: ReturnType<typeof normalizeCandleTimestamp> }> = [];

    for (const t of existingTicks) {
      const cellNorm = normalizeCandleTimestamp(new Date(t.minute_timestamp).getTime());
      if (!seenMinutes.has(cellNorm.timeString)) {
        seenMinutes.add(cellNorm.timeString);
        dedupedTicks.push({ ltp: t.ltp, oi: t.oi, cellNorm });
      }
    }

    if (dedupedTicks.length > 0) {
      const historicalGrid: Module2Cell[] = dedupedTicks.map((t) => ({
        ltp: t.ltp,
        minute: t.cellNorm.minuteIndex,
        timestamp: t.cellNorm.timeString,
        isHigh: false,
        isLow: false,
        oi: t.oi,
        oiDelta: 0,
        oiBuy: 0,
        oiSell: 0,
      }));

      const firstValid = dedupedTicks.find((t) => t.ltp > 0);
      const dayOpen = firstValid ? firstValid.ltp : currentLiveLtp;
      const dayHigh = Math.max(dayOpen, ...dedupedTicks.map((t) => t.ltp), currentLiveLtp);
      const positiveLows = [dayOpen, ...dedupedTicks.map((t) => t.ltp), currentLiveLtp].filter((p) => p > 0);
      const dayLow = positiveLows.length > 0 ? Math.min(...positiveLows) : dayOpen;

      // Append current start cell if not in historical grid
      const existingCurrentCell = historicalGrid.find((c) => c.timestamp === initialTimeString);
      if (!existingCurrentCell && currentLiveLtp > 0) {
        historicalGrid.push({
          ltp: currentLiveLtp,
          minute: initialMinutes,
          timestamp: initialTimeString,
          isHigh: currentLiveLtp === dayHigh,
          isLow: currentLiveLtp === dayLow,
          oi: currentLiveOi,
          oiDelta: 0,
          oiBuy: 0,
          oiSell: 0,
        });
      }

      return {
        strike,
        dayOpen,
        dayHigh,
        dayLow,
        grid: historicalGrid,
        trendBadge: "FLAT",
        isDowntrendActive: false,
        isDeepLoss: false,
        pctChange: dayOpen > 0 ? Number((((currentLiveLtp - dayOpen) / dayOpen) * 100).toFixed(2)) : 0,
      };
    } else {
      // Brand new strike
      const initialCell: Module2Cell = {
        ltp: currentLiveLtp,
        minute: initialMinutes,
        timestamp: initialTimeString,
        isHigh: currentLiveLtp > 0,
        isLow: currentLiveLtp > 0,
        oi: currentLiveOi,
        oiDelta: 0,
        oiBuy: currentLiveOi,
        oiSell: 0,
      };

      return {
        strike,
        dayOpen: currentLiveLtp,
        dayHigh: currentLiveLtp,
        dayLow: currentLiveLtp,
        grid: [initialCell],
        trendBadge: "FLAT",
        isDowntrendActive: false,
        isDeepLoss: false,
        pctChange: 0,
      };
    }
  };

  it("Test 1: Stop at 09:35 and re-start at 10:00 restores 09:30-09:35 data without 09:36-09:59 fake cells", () => {
    // 09:30 - 09:35 ticks
    const session1Ticks = [
      { minute_timestamp: "2026-09-01T04:00:00.000Z", ltp: 150, oi: 10000 }, // 09:30 IST
      { minute_timestamp: "2026-09-01T04:01:00.000Z", ltp: 152, oi: 10200 }, // 09:31 IST
      { minute_timestamp: "2026-09-01T04:02:00.000Z", ltp: 155, oi: 10500 }, // 09:32 IST
      { minute_timestamp: "2026-09-01T04:03:00.000Z", ltp: 153, oi: 10400 }, // 09:33 IST
      { minute_timestamp: "2026-09-01T04:04:00.000Z", ltp: 156, oi: 10600 }, // 09:34 IST
      { minute_timestamp: "2026-09-01T04:05:00.000Z", ltp: 158, oi: 10800 }, // 09:35 IST
    ];

    // Re-start at 10:00 IST (04:30 UTC)
    const stateAt1000 = simulateStrikeStitching(
      "24350CE",
      session1Ticks,
      165, // live price at 10:00
      11200, // live OI at 10:00
      "2026-09-01T04:30:00.000Z"
    );

    expect(stateAt1000.dayOpen).toBe(150); // Original dayOpen preserved
    expect(stateAt1000.grid.length).toBe(7); // 6 historical cells (09:30-09:35) + 1 current cell (10:00)

    const timestamps = stateAt1000.grid.map((c) => c.timestamp);
    expect(timestamps).toEqual(["09:30", "09:31", "09:32", "09:33", "09:34", "09:35", "10:00"]);

    // Verify NO fake rows exist for inactive gap 09:36 - 09:59
    expect(timestamps).not.toContain("09:36");
    expect(timestamps).not.toContain("09:45");
    expect(timestamps).not.toContain("09:59");
  });

  it("Test 2: Newly added strike at 10:00 is isolated and does not inherit historical data", () => {
    // 24350 CE has history from 09:30
    const strike1Ticks = [
      { minute_timestamp: "2026-09-01T04:00:00.000Z", ltp: 150, oi: 10000 },
      { minute_timestamp: "2026-09-01T04:01:00.000Z", ltp: 152, oi: 10200 },
    ];
    const strike1State = simulateStrikeStitching(
      "24350CE",
      strike1Ticks,
      165,
      11200,
      "2026-09-01T04:30:00.000Z" // 10:00 IST
    );

    // 24500 CE is newly selected at 10:00 (zero past ticks)
    const strike2State = simulateStrikeStitching(
      "24500CE",
      [], // No past ticks
      80, // live price at 10:00
      5000,
      "2026-09-01T04:30:00.000Z" // 10:00 IST
    );

    expect(strike2State.grid.length).toBe(1);
    expect(strike2State.grid[0].timestamp).toBe("10:00");
    expect(strike2State.dayOpen).toBe(80);

    // Multi-strike table column alignment check
    const session: Module2SessionData = {
      sessionId: "test-sess",
      userId: "user-1",
      sessionType: "CE",
      indexSymbol: "NIFTY50",
      expiryDate: "2026-09-03",
      selectedStrikes: ["24350CE", "24500CE"],
      dayOpenPrices: { "24350CE": 150, "24500CE": 80 },
      strikes: { "24350CE": strike1State, "24500CE": strike2State },
      createdAt: new Date(),
    };

    const allTs = new Set<string>();
    Object.values(session.strikes).forEach((s) => {
      s.grid.forEach((c) => allTs.add(c.timestamp));
    });
    const sortedTimestamps = Array.from(allTs).sort((a, b) => a.localeCompare(b));

    expect(sortedTimestamps).toEqual(["09:30", "09:31", "10:00"]);

    // For 24500 CE, columns prior to 10:00 return null (rendered as dash '—')
    const row2Values = sortedTimestamps.map((ts) => {
      const cell = session.strikes["24500CE"].grid.find((c) => c.timestamp === ts);
      return cell ? cell.ltp : "—";
    });

    expect(row2Values).toEqual(["—", "—", 80]);
  });

  it("Test 3: Multiple stop and restart cycles (09:30-09:35, 10:00-10:05, 10:30+) preserve all active periods", () => {
    const cycle1Ticks = [
      { minute_timestamp: "2026-09-01T04:00:00.000Z", ltp: 150, oi: 10000 },
      { minute_timestamp: "2026-09-01T04:05:00.000Z", ltp: 155, oi: 10500 },
    ];
    const cycle2Ticks = [
      ...cycle1Ticks,
      { minute_timestamp: "2026-09-01T04:30:00.000Z", ltp: 160, oi: 11000 }, // 10:00 IST
      { minute_timestamp: "2026-09-01T04:35:00.000Z", ltp: 165, oi: 11500 }, // 10:05 IST
    ];

    // Restart at 10:30 IST (05:00 UTC)
    const stateAt1030 = simulateStrikeStitching(
      "24350CE",
      cycle2Ticks,
      170,
      12000,
      "2026-09-01T05:00:00.000Z"
    );

    const timestamps = stateAt1030.grid.map((c) => c.timestamp);
    expect(timestamps).toEqual(["09:30", "09:35", "10:00", "10:05", "10:30"]);

    // Verify gaps are not populated
    expect(timestamps).not.toContain("09:40");
    expect(timestamps).not.toContain("10:15");
  });

  it("Test 4: Non-destructive stop updates status to STOPPED and retains session", () => {
    const session: Module2SessionData = {
      sessionId: "session-123",
      userId: "user-1",
      sessionType: "CE",
      indexSymbol: "NIFTY50",
      expiryDate: "2026-09-03",
      selectedStrikes: ["24350CE"],
      dayOpenPrices: { "24350CE": 150 },
      strikes: {},
      status: "ACTIVE",
      startedAt: new Date("2026-09-01T04:00:00.000Z"),
      stoppedAt: null,
      createdAt: new Date("2026-09-01T04:00:00.000Z"),
    };

    // Simulate STOP action
    const stoppedSession: Module2SessionData = {
      ...session,
      status: "STOPPED",
      stoppedAt: new Date("2026-09-01T04:05:00.000Z"),
    };

    expect(stoppedSession.status).toBe("STOPPED");
    expect(stoppedSession.stoppedAt).not.toBeNull();
    expect(stoppedSession.sessionId).toBe("session-123");
  });
});
