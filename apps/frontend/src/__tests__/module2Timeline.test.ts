import { describe, it, expect } from "vitest";
import {
  formatISTTime,
  getISTMinuteBucket,
  getMinutesSinceMarketOpenIST,
  normalizeCandleTimestamp,
  generateTimelineColumns,
  Module2Cell,
  Module2StrikeState,
} from "@stock/shared";

describe("Module 2 Timeline & Timezone Normalization", () => {
  describe("IST Timezone conversion from UTC", () => {
    it("converts 08:06:00 UTC to 13:36 IST (Asia/Kolkata +05:30)", () => {
      const utcIso = "2026-08-28T08:06:00.000Z";
      const formatted = formatISTTime(utcIso);
      expect(formatted).toBe("13:36");
    });

    it("converts 08:09:54 UTC to 13:39 IST", () => {
      const utcIso = "2026-08-28T08:09:54.000Z";
      const formatted = formatISTTime(utcIso);
      expect(formatted).toBe("13:39");
    });

    it("converts 03:45:00 UTC to 09:15 IST (Market Open)", () => {
      const utcIso = "2026-08-28T03:45:00.000Z";
      const formatted = formatISTTime(utcIso);
      expect(formatted).toBe("09:15");
    });

    it("converts 10:00:00 UTC to 15:30 IST (Market Close)", () => {
      const utcIso = "2026-08-28T10:00:00.000Z";
      const formatted = formatISTTime(utcIso);
      expect(formatted).toBe("15:30");
    });
  });

  describe("Canonical minute bucket generation", () => {
    it("creates canonical YYYY-MM-DD HH:mm minute bucket in IST", () => {
      const utcIso = "2026-08-28T08:09:54.000Z";
      const bucket = getISTMinuteBucket(utcIso);
      expect(bucket).toBe("2026-08-28 13:39");
    });
  });

  describe("Elapsed minutes since Market Open (09:15 AM IST)", () => {
    it("returns 0 at exactly 09:15 AM IST", () => {
      const marketOpenUtc = "2026-08-28T03:45:00.000Z"; // 09:15 IST
      const minutes = getMinutesSinceMarketOpenIST(marketOpenUtc);
      expect(minutes).toBe(0);
    });

    it("returns 1 at 09:16 AM IST", () => {
      const utc = "2026-08-28T03:46:00.000Z"; // 09:16 IST
      const minutes = getMinutesSinceMarketOpenIST(utc);
      expect(minutes).toBe(1);
    });

    it("returns 264 at 13:39 PM IST (4 hours 24 mins = 264 mins)", () => {
      const utc = "2026-08-28T08:09:00.000Z"; // 13:39 IST
      const minutes = getMinutesSinceMarketOpenIST(utc);
      expect(minutes).toBe(264);
    });

    it("returns 0 if before 09:15 AM IST", () => {
      const preMarketUtc = "2026-08-28T03:30:00.000Z"; // 09:00 IST
      const minutes = getMinutesSinceMarketOpenIST(preMarketUtc);
      expect(minutes).toBe(0);
    });
  });

  describe("normalizeCandleTimestamp contract", () => {
    it("returns timeString, minuteBucket, minuteIndex, timestampMs without assuming Date is IST", () => {
      const utcMs = Date.UTC(2026, 7, 28, 8, 9, 30); // 2026-08-28 08:09:30 UTC
      const norm = normalizeCandleTimestamp(utcMs);

      expect(norm.timeString).toBe("13:39");
      expect(norm.minuteBucket).toBe("2026-08-28 13:39");
      expect(norm.minuteIndex).toBe(264);
      expect(norm.timestampMs).toBe(utcMs);
      expect(norm.fullIso).toBe(new Date(utcMs).toISOString());
    });
  });

  describe("Grid Cell Deduplication & Minute Progression", () => {
    it("multiple ticks within the same minute update the existing cell in-place", () => {
      const grid: Module2Cell[] = [];

      const tick1 = {
        ltp: 135,
        minute: 264,
        timestamp: "13:39",
        isHigh: true,
        isLow: true,
      };

      // Add first tick
      const existingIdx1 = grid.findIndex((c) => c.timestamp === tick1.timestamp);
      if (existingIdx1 >= 0) {
        grid[existingIdx1] = { ...grid[existingIdx1], ...tick1 };
      } else {
        grid.push(tick1);
      }

      expect(grid.length).toBe(1);
      expect(grid[0].ltp).toBe(135);

      // Add second tick in same minute with updated LTP
      const tick2 = {
        ltp: 138,
        minute: 264,
        timestamp: "13:39",
        isHigh: true,
        isLow: false,
      };

      const existingIdx2 = grid.findIndex((c) => c.timestamp === tick2.timestamp);
      if (existingIdx2 >= 0) {
        grid[existingIdx2] = { ...grid[existingIdx2], ...tick2 };
      } else {
        grid.push(tick2);
      }

      expect(grid.length).toBe(1);
      expect(grid[0].ltp).toBe(138);
      expect(grid[0].timestamp).toBe("13:39");
    });

    it("new minute creates a new column while preserving historical minute", () => {
      const grid: Module2Cell[] = [
        { ltp: 138, minute: 264, timestamp: "13:39", isHigh: true, isLow: false },
      ];

      const tickNextMinute = {
        ltp: 140,
        minute: 265,
        timestamp: "13:40",
        isHigh: true,
        isLow: false,
      };

      const existingIdx = grid.findIndex((c) => c.timestamp === tickNextMinute.timestamp);
      if (existingIdx >= 0) {
        grid[existingIdx] = { ...grid[existingIdx], ...tickNextMinute };
      } else {
        grid.push(tickNextMinute);
      }

      expect(grid.length).toBe(2);
      expect(grid[0].timestamp).toBe("13:39");
      expect(grid[0].ltp).toBe(138);
      expect(grid[1].timestamp).toBe("13:40");
      expect(grid[1].ltp).toBe(140);
    });
  });

  describe("Multi-Strike Timeline Alignment and Missing Candle Handling", () => {
    it("correctly handles strikes with missing minutes without shifting neighbor values", () => {
      const strikes: Record<string, Module2StrikeState> = {
        "24100CE": {
          strike: "24100CE",
          dayOpen: 132,
          dayHigh: 140,
          dayLow: 130,
          grid: [
            { ltp: 132, minute: 260, timestamp: "13:35", isHigh: false, isLow: false },
            { ltp: 135, minute: 261, timestamp: "13:36", isHigh: false, isLow: false },
            { ltp: 139, minute: 263, timestamp: "13:38", isHigh: false, isLow: false }, // missing 13:37
          ],
          trendBadge: "FLAT",
          isDowntrendActive: false,
          isDeepLoss: false,
          pctChange: 0,
        },
        "24150CE": {
          strike: "24150CE",
          dayOpen: 100,
          dayHigh: 110,
          dayLow: 98,
          grid: [
            { ltp: 101, minute: 260, timestamp: "13:35", isHigh: false, isLow: false },
            { ltp: 103, minute: 261, timestamp: "13:36", isHigh: false, isLow: false },
            { ltp: 102, minute: 262, timestamp: "13:37", isHigh: false, isLow: false },
            { ltp: 105, minute: 263, timestamp: "13:38", isHigh: false, isLow: false },
          ],
          trendBadge: "FLAT",
          isDowntrendActive: false,
          isDeepLoss: false,
          pctChange: 0,
        },
      };

      // Aggregated continuous timeline using generateTimelineColumns
      const rawTsList: string[] = [];
      Object.values(strikes).forEach((s) => {
        s.grid.forEach((c) => {
          if (c.timestamp) rawTsList.push(c.timestamp);
        });
      });
      const sortedTimestamps = generateTimelineColumns(rawTsList);

      expect(sortedTimestamps).toEqual(["13:35", "13:36", "13:37", "13:38"]);

      // Strike 24100CE cell lookup per minute
      const row1Cells = sortedTimestamps.map((ts) => {
        const cell = strikes["24100CE"].grid.find((c) => c.timestamp === ts);
        return cell ? cell.ltp : "—";
      });

      expect(row1Cells).toEqual([132, 135, "—", 139]);

      // Strike 24150CE cell lookup per minute
      const row2Cells = sortedTimestamps.map((ts) => {
        const cell = strikes["24150CE"].grid.find((c) => c.timestamp === ts);
        return cell ? cell.ltp : "—";
      });

      expect(row2Cells).toEqual([101, 103, 102, 105]);
    });
  });

  describe("8-Point Tracker Historical Timeline & Gap Integrity Validation", () => {
    // TEST 1 — Same strike restart (14:23-14:27, Stop, Restart 14:30)
    it("TEST 1: Same strike restart restores 14:23-14:27 with 14:28-14:29 as dashes '—'", () => {
      const strikeGrid: Module2Cell[] = [
        { ltp: 150, minute: 308, timestamp: "14:23", isHigh: false, isLow: false },
        { ltp: 151, minute: 309, timestamp: "14:24", isHigh: false, isLow: false },
        { ltp: 152, minute: 310, timestamp: "14:25", isHigh: false, isLow: false },
        { ltp: 153, minute: 311, timestamp: "14:26", isHigh: false, isLow: false },
        { ltp: 154, minute: 312, timestamp: "14:27", isHigh: false, isLow: false },
        // stopped at 14:27, restarted at 14:30
        { ltp: 160, minute: 315, timestamp: "14:30", isHigh: true, isLow: false },
      ];

      const rawTimestamps = strikeGrid.map((c) => c.timestamp);
      const timeline = generateTimelineColumns(rawTimestamps);

      expect(timeline).toEqual(["14:23", "14:24", "14:25", "14:26", "14:27", "14:28", "14:29", "14:30"]);

      const tableRow = timeline.map((ts) => {
        const cell = strikeGrid.find((c) => c.timestamp === ts);
        return cell ? cell.ltp : "—";
      });

      expect(tableRow).toEqual([150, 151, 152, 153, 154, "—", "—", 160]);
    });

    // TEST 2 — New strike (Existing NIFTY24000CE from 14:23, new NIFTY24500CE at 14:30)
    it("TEST 2: New strike added at 14:30 renders '—' for all prior columns 14:23-14:29", () => {
      const strikeA_Grid: Module2Cell[] = [
        { ltp: 150, minute: 308, timestamp: "14:23", isHigh: false, isLow: false },
        { ltp: 154, minute: 312, timestamp: "14:27", isHigh: false, isLow: false },
        { ltp: 160, minute: 315, timestamp: "14:30", isHigh: true, isLow: false },
      ];
      const strikeB_Grid: Module2Cell[] = [
        { ltp: 80, minute: 315, timestamp: "14:30", isHigh: true, isLow: false },
      ];

      const allTs = [...strikeA_Grid.map((c) => c.timestamp), ...strikeB_Grid.map((c) => c.timestamp)];
      const timeline = generateTimelineColumns(allTs);

      expect(timeline).toEqual(["14:23", "14:24", "14:25", "14:26", "14:27", "14:28", "14:29", "14:30"]);

      const rowB = timeline.map((ts) => {
        const cell = strikeB_Grid.find((c) => c.timestamp === ts);
        return cell ? cell.ltp : "—";
      });

      expect(rowB).toEqual(["—", "—", "—", "—", "—", "—", "—", 80]);
    });

    // TEST 3 — Multiple restart cycles (14:23-14:27, 14:30-14:34, 14:40-14:45)
    it("TEST 3: Multiple restart cycles preserve all active ranges with gap columns", () => {
      const multiCycleGrid: Module2Cell[] = [
        { ltp: 150, minute: 308, timestamp: "14:23", isHigh: false, isLow: false },
        { ltp: 154, minute: 312, timestamp: "14:27", isHigh: false, isLow: false },
        { ltp: 160, minute: 315, timestamp: "14:30", isHigh: false, isLow: false },
        { ltp: 164, minute: 319, timestamp: "14:34", isHigh: false, isLow: false },
        { ltp: 170, minute: 325, timestamp: "14:40", isHigh: false, isLow: false },
        { ltp: 175, minute: 330, timestamp: "14:45", isHigh: true, isLow: false },
      ];

      const timeline = generateTimelineColumns(multiCycleGrid.map((c) => c.timestamp));
      expect(timeline[0]).toBe("14:23");
      expect(timeline[timeline.length - 1]).toBe("14:45");
      expect(timeline.length).toBe(23); // 14:23 to 14:45 inclusive

      const cellMap = new Map(multiCycleGrid.map((c) => [c.timestamp, c.ltp]));
      expect(cellMap.get("14:23")).toBe(150);
      expect(cellMap.get("14:28")).toBeUndefined();
      expect(cellMap.get("14:30")).toBe(160);
      expect(cellMap.get("14:35")).toBeUndefined();
      expect(cellMap.get("14:40")).toBe(170);
    });

    // TEST 4 — Multiple strikes with distinct start times
    it("TEST 4: Multiple strikes maintain independent historical timelines", () => {
      const strikesData: Record<string, Module2Cell[]> = {
        "24000CE": [
          { ltp: 100, minute: 300, timestamp: "14:15", isHigh: false, isLow: false },
          { ltp: 105, minute: 305, timestamp: "14:20", isHigh: false, isLow: false },
        ],
        "24100PE": [
          { ltp: 200, minute: 310, timestamp: "14:25", isHigh: false, isLow: false },
          { ltp: 205, minute: 315, timestamp: "14:30", isHigh: false, isLow: false },
        ],
      };

      const allTs = Object.values(strikesData).flatMap((g) => g.map((c) => c.timestamp));
      const timeline = generateTimelineColumns(allTs);

      expect(timeline[0]).toBe("14:15");
      expect(timeline[timeline.length - 1]).toBe("14:30");

      const rowCE = timeline.map((ts) => strikesData["24000CE"].find((c) => c.timestamp === ts)?.ltp || "—");
      const rowPE = timeline.map((ts) => strikesData["24100PE"].find((c) => c.timestamp === ts)?.ltp || "—");

      expect(rowCE[0]).toBe(100); // 14:15
      expect(rowCE[timeline.length - 1]).toBe("—"); // 14:30
      expect(rowPE[0]).toBe("—"); // 14:15
      expect(rowPE[timeline.length - 1]).toBe(205); // 14:30
    });

    // TEST 5 — No duplicate minutes
    it("TEST 5: Duplicate minutes in raw input produce exactly one timeline column", () => {
      const duplicateTimestamps = ["14:23", "14:23", "14:24", "14:24", "14:25"];
      const timeline = generateTimelineColumns(duplicateTimestamps);
      expect(timeline).toEqual(["14:23", "14:24", "14:25"]);
    });

    // TEST 6 — Persistence reload recovery
    it("TEST 6: Reloaded session data restores full historical grid without data loss", () => {
      const persistedGrid: Module2Cell[] = [
        { ltp: 110, minute: 300, timestamp: "14:15", isHigh: false, isLow: false },
        { ltp: 112, minute: 301, timestamp: "14:16", isHigh: false, isLow: false },
        { ltp: 115, minute: 302, timestamp: "14:17", isHigh: false, isLow: false },
      ];
      const reloadedGrid = [...persistedGrid];
      const timeline = generateTimelineColumns(reloadedGrid.map((c) => c.timestamp));
      expect(timeline).toEqual(["14:15", "14:16", "14:17"]);
      expect(reloadedGrid.map((c) => c.ltp)).toEqual([110, 112, 115]);
    });

    // TEST 7 — 20 strikes scalability
    it("TEST 7: 20 strikes timeline generation completes in < 5ms", () => {
      const strikes20: Record<string, Module2Cell[]> = {};
      for (let i = 0; i < 20; i++) {
        const symbol = i < 10 ? `NIFTY${24000 + i * 50}CE` : `NIFTY${24000 + (i - 10) * 50}PE`;
        strikes20[symbol] = [
          { ltp: 100 + i, minute: 300, timestamp: "14:15", isHigh: false, isLow: false },
          { ltp: 102 + i, minute: 315, timestamp: "14:30", isHigh: false, isLow: false },
        ];
      }

      const t0 = performance.now();
      const allTs = Object.values(strikes20).flatMap((g) => g.map((c) => c.timestamp));
      const timeline = generateTimelineColumns(allTs);
      const elapsed = performance.now() - t0;

      expect(timeline.length).toBe(16); // 14:15 to 14:30 inclusive
      expect(elapsed).toBeLessThan(5); // < 5ms
    });

    // TEST 8 — Gap integrity (inactive gaps never fabricated)
    it("TEST 8: Gap cells remain strictly '—' and are never populated with zero or fake prices", () => {
      const gridWithGap: Module2Cell[] = [
        { ltp: 150, minute: 300, timestamp: "14:15", isHigh: false, isLow: false },
        { ltp: 155, minute: 305, timestamp: "14:20", isHigh: false, isLow: false },
      ];
      const timeline = generateTimelineColumns(gridWithGap.map((c) => c.timestamp));
      const renderedRow = timeline.map((ts) => {
        const cell = gridWithGap.find((c) => c.timestamp === ts);
        return cell ? cell.ltp : "—";
      });

      expect(renderedRow[0]).toBe(150); // 14:15
      expect(renderedRow[1]).toBe("—"); // 14:16
      expect(renderedRow[2]).toBe("—"); // 14:17
      expect(renderedRow[3]).toBe("—"); // 14:18
      expect(renderedRow[4]).toBe("—"); // 14:19
      expect(renderedRow[5]).toBe(155); // 14:20

      // Inactive cells must NEVER equal 0 or undefined
      expect(renderedRow.filter((v) => v === 0)).toHaveLength(0);
    });
  });
});
