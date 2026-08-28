import { describe, it, expect } from "vitest";
import {
  formatISTTime,
  getISTMinuteBucket,
  getMinutesSinceMarketOpenIST,
  normalizeCandleTimestamp,
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

      // Aggregated sorted timestamps
      const tsSet = new Set<string>();
      Object.values(strikes).forEach((s) => {
        s.grid.forEach((c) => {
          if (c.timestamp) tsSet.add(c.timestamp);
        });
      });
      const sortedTimestamps = Array.from(tsSet).sort((a, b) => a.localeCompare(b));

      expect(sortedTimestamps).toEqual(["13:35", "13:36", "13:37", "13:38"]);

      // Strike 24100CE cell lookup per minute
      const row1Cells = sortedTimestamps.map((ts) => {
        const cell = strikes["24100CE"].grid.find((c) => c.timestamp === ts);
        return cell ? cell.ltp : null;
      });

      expect(row1Cells).toEqual([132, 135, null, 139]);

      // Strike 24150CE cell lookup per minute
      const row2Cells = sortedTimestamps.map((ts) => {
        const cell = strikes["24150CE"].grid.find((c) => c.timestamp === ts);
        return cell ? cell.ltp : null;
      });

      expect(row2Cells).toEqual([101, 103, 102, 105]);
    });
  });
});
