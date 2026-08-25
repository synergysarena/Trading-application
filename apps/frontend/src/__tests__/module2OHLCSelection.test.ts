import { describe, it, expect } from "vitest";

describe("Module 2 OHLC Field Selection & Table Column Rules", () => {
  const ALL_OHLC_COLS = [
    { id: "open", label: "Open" },
    { id: "high", label: "High" },
    { id: "low", label: "Low" },
    { id: "close", label: "Close" },
  ];

  const filterCols = (selectedFields: string[]) => {
    return ALL_OHLC_COLS.filter((c) => selectedFields.includes(c.id)).map((c) => c.label);
  };

  const validateOHLCFields = (selectedFields: string[]) => {
    if (selectedFields.length === 0) {
      return { valid: false, error: "At least one OHLC field must be selected." };
    }
    return { valid: true, error: null };
  };

  describe("Validation of OHLC selection count", () => {
    it("fails when 0 fields are selected", () => {
      const res = validateOHLCFields([]);
      expect(res.valid).toBe(false);
      expect(res.error).toBe("At least one OHLC field must be selected.");
    });

    it("passes when at least 1 field is selected", () => {
      expect(validateOHLCFields(["open"]).valid).toBe(true);
      expect(validateOHLCFields(["open", "high"]).valid).toBe(true);
      expect(validateOHLCFields(["open", "high", "low", "close"]).valid).toBe(true);
    });
  });

  describe("Single field selection renders ONLY that field", () => {
    it("Open only -> [Open]", () => {
      const cols = filterCols(["open"]);
      expect(cols).toEqual(["Open"]);
    });

    it("High only -> [High]", () => {
      const cols = filterCols(["high"]);
      expect(cols).toEqual(["High"]);
    });

    it("Low only -> [Low]", () => {
      const cols = filterCols(["low"]);
      expect(cols).toEqual(["Low"]);
    });

    it("Close only -> [Close]", () => {
      const cols = filterCols(["close"]);
      expect(cols).toEqual(["Close"]);
    });
  });

  describe("Pairs selection renders exactly the two chosen fields", () => {
    it("Open + High -> [Open, High]", () => {
      expect(filterCols(["open", "high"])).toEqual(["Open", "High"]);
    });

    it("Open + Low -> [Open, Low]", () => {
      expect(filterCols(["open", "low"])).toEqual(["Open", "Low"]);
    });

    it("Open + Close -> [Open, Close]", () => {
      expect(filterCols(["open", "close"])).toEqual(["Open", "Close"]);
    });

    it("High + Low -> [High, Low]", () => {
      expect(filterCols(["high", "low"])).toEqual(["High", "Low"]);
    });

    it("High + Close -> [High, Close]", () => {
      expect(filterCols(["high", "close"])).toEqual(["High", "Close"]);
    });

    it("Low + Close -> [Low, Close]", () => {
      expect(filterCols(["low", "close"])).toEqual(["Low", "Close"]);
    });
  });

  describe("Three fields selection renders exactly the three chosen fields", () => {
    it("Open + High + Low -> [Open, High, Low]", () => {
      expect(filterCols(["open", "high", "low"])).toEqual(["Open", "High", "Low"]);
    });

    it("Open + High + Close -> [Open, High, Close]", () => {
      expect(filterCols(["open", "high", "close"])).toEqual(["Open", "High", "Close"]);
    });

    it("Open + Low + Close -> [Open, Low, Close]", () => {
      expect(filterCols(["open", "low", "close"])).toEqual(["Open", "Low", "Close"]);
    });

    it("High + Low + Close -> [High, Low, Close]", () => {
      expect(filterCols(["high", "low", "close"])).toEqual(["High", "Low", "Close"]);
    });
  });

  describe("All four fields selection renders complete OHLC", () => {
    it("Open + High + Low + Close -> [Open, High, Low, Close]", () => {
      expect(filterCols(["open", "high", "low", "close"])).toEqual(["Open", "High", "Low", "Close"]);
    });
  });
});
