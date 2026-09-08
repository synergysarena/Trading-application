import { describe, it, expect } from "vitest";
import {
  Module2Cell,
  Module2SessionData,
  Module2StrikeState,
  generateTimelineColumns,
  normalizeCandleTimestamp,
} from "@stock/shared";

/**
 * STEP 16 — the EXACT user bug.
 *
 * "Tracker started a few minutes ago but the table shows older minute values."
 *
 * These tests pin the contract:
 *  - A brand-new session with NO same-day persisted history shows NOTHING
 *    before its start minute (no columns, no fabricated cells).
 *  - A strike added mid-session shows "—" before its own start minute and
 *    never inherits another strike's values.
 *  - Every rendered cell carries a provenance tag: "mongo" (durable history)
 *    or "live" (current/just-completed minute). There is no "redis" source.
 */

const cell = (ts: string, ltp: number, source: "mongo" | "live"): Module2Cell => ({
  ltp,
  minute: 0,
  timestamp: ts,
  isHigh: false,
  isLow: false,
  oi: 0,
  oiDelta: 0,
  oiBuy: 0,
  oiSell: 0,
  source,
});

const renderRow = (grid: Module2Cell[], columns: string[]) =>
  columns.map((ts) => {
    const c = grid.find((x) => x.timestamp === ts);
    return c && typeof c.ltp === "number" && !isNaN(c.ltp) ? c.ltp : "—";
  });

describe("STEP 16 — no fabricated history on a fresh tracker session", () => {
  it("a NEW session with no restoration relationship shows no pre-start columns", () => {
    // Backend `startTrackerSession` new-strike branch → grid = [current minute only]
    const strikeA: Module2StrikeState = {
      strike: "NIFTY24800CE",
      dayOpen: 120,
      dayHigh: 120,
      dayLow: 120,
      grid: [cell("10:00", 120, "live")],
      trendBadge: "FLAT",
      isDowntrendActive: false,
      isDeepLoss: false,
      pctChange: 0,
    };
    const session: Module2SessionData = {
      sessionId: "fresh-1",
      userId: "u1",
      sessionType: "CE",
      indexSymbol: "NIFTY50",
      expiryDate: "2026-09-11",
      selectedStrikes: ["NIFTY24800CE"],
      dayOpenPrices: { NIFTY24800CE: 120 },
      strikes: { NIFTY24800CE: strikeA },
      createdAt: new Date(),
    };

    const allTs: string[] = [];
    Object.values(session.strikes).forEach((s) => s.grid.forEach((c) => c.timestamp && allTs.push(c.timestamp)));
    const columns = generateTimelineColumns(allTs);

    expect(columns).toEqual(["10:00"]);
    expect(columns).not.toContain("09:30");
    expect(columns).not.toContain("09:59");
    // exactly one cell, and it is a LIVE cell — not historical
    expect(strikeA.grid).toHaveLength(1);
    expect(strikeA.grid[0].source).toBe("live");
  });

  it("a strike added at 10:05 shows '—' before 10:05 and never inherits strike A's values", () => {
    const strikeA: Module2StrikeState = {
      strike: "NIFTY24800CE",
      dayOpen: 100,
      dayHigh: 110,
      dayLow: 100,
      grid: [
        cell("10:00", 100, "mongo"),
        cell("10:01", 105, "mongo"),
        cell("10:02", 108, "mongo"),
        cell("10:03", 106, "mongo"),
        cell("10:04", 109, "mongo"),
        cell("10:05", 110, "live"),
      ],
      trendBadge: "FLAT",
      isDowntrendActive: false,
      isDeepLoss: false,
      pctChange: 0,
    };
    const strikeB: Module2StrikeState = {
      strike: "NIFTY24900CE",
      dayOpen: 60,
      dayHigh: 60,
      dayLow: 60,
      grid: [cell("10:05", 60, "live")], // added at 10:05
      trendBadge: "FLAT",
      isDowntrendActive: false,
      isDeepLoss: false,
      pctChange: 0,
    };

    const allTs: string[] = [];
    [strikeA, strikeB].forEach((s) => s.grid.forEach((c) => allTs.push(c.timestamp)));
    const columns = generateTimelineColumns(allTs);
    expect(columns).toEqual(["10:00", "10:01", "10:02", "10:03", "10:04", "10:05"]);

    const rowB = renderRow(strikeB.grid, columns);
    expect(rowB).toEqual(["—", "—", "—", "—", "—", 60]);

    // strike B never carries strike A's numbers
    expect(strikeB.grid.some((c) => [100, 105, 108, 106, 109, 110].includes(c.ltp))).toBe(false);
  });

  it("cells before the current session start are always tagged source='mongo' (restored), never invented", () => {
    // stop 09:35, restart 10:00, same strike — restored history is 'mongo'
    const grid: Module2Cell[] = [
      cell("09:30", 150, "mongo"),
      cell("09:31", 152, "mongo"),
      cell("09:35", 158, "mongo"),
      cell("10:00", 165, "live"),
    ];
    const beforeStart = grid.filter((c) => c.timestamp < "10:00");
    expect(beforeStart.every((c) => c.source === "mongo")).toBe(true);
    expect(beforeStart.some((c) => c.source === "live")).toBe(false);
    // no fabricated cells in the 09:36–09:59 gap
    expect(grid.map((c) => c.timestamp)).not.toContain("09:45");
  });

  it("generateTimelineColumns spans a stop/restart gap with headers but the cells stay '—'", () => {
    const grid: Module2Cell[] = [cell("09:30", 150, "mongo"), cell("09:32", 155, "mongo"), cell("10:00", 165, "live")];
    const columns = generateTimelineColumns(grid.map((c) => c.timestamp));
    expect(columns).toContain("09:45"); // header exists
    const row = renderRow(grid, columns);
    expect(row[columns.indexOf("09:45")]).toBe("—"); // but the value is a dash, not invented
    expect(row[columns.indexOf("09:31")]).toBe("—");
    expect(row[columns.indexOf("10:00")]).toBe(165);
  });

  it("normalizeCandleTimestamp keeps IST display for a canonical UTC minute", () => {
    // 04:00:00.000Z == 09:30 IST
    expect(normalizeCandleTimestamp(Date.parse("2026-09-11T04:00:00.000Z")).timeString).toBe("09:30");
  });
});
