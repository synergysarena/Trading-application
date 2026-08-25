import { describe, it, expect, afterAll } from "vitest";
import { Workbook } from "exceljs";
import * as fs from "fs";
import type { DashboardRow } from "../../calc";
import { buildModule1Workbook, exportModule1Excel, istDateStr } from "./excelExport";

const bar = (o: number, h: number, l: number, c: number, t: number) => ({ t, o, h, l, c });

function mkRow(t: number, i: number): DashboardRow {
  return {
    t,
    call: bar(10 + i, 12 + i, 9 + i, 11 + i, t),
    put: bar(8 + i, 9 + i, 7 + i, 8.5 + i, t),
    future: bar(22000 + i, 22050 + i, 21950 + i, 22010 + i, t),
    spot: bar(22000 + i, 22050 + i, 21950 + i, 22010 + i, t),
    callMMA: 10.5 + i, callTMA: 9.5 + i,
    putMMA: 8.25 + i, putTMA: 7.25 + i,
    futureMMA: 22015 + i, futureTMA: 21990 + i,
    spotMMA: 22015 + i, spotTMA: 21990 + i,
    ranking: 10.5 + i, rankingWinner: i % 2 === 0 ? "call" : "put",
    smc: "Neutral", fib: "50%",
    rsi: 55 + i, ema: 22000 + i, vwap: 22005 + i,
    ema200: 21990 + i, emaScore: 1, vwapScore: 1, totalScore: 2, rating: "Strong CALL", signal: "BUY CALL",
    oiMatrix: null,
  };
}

describe("exportModule1Excel", () => {
  const outFile = "excelExport.verify.output.xlsx";
  afterAll(() => { try { fs.unlinkSync(outFile); } catch { /* noop */ } });

  it("writes a workbook whose rows, values, and colors match the visible table", async () => {
    const base = new Date(`${istDateStr()}T04:00:00.000Z`).getTime(); // ~09:30 IST
    const rows: DashboardRow[] = [mkRow(base, 0), mkRow(base + 300000, 1), mkRow(base + 600000, 2)];

    const built = buildModule1Workbook({
      rows, hiddenCols: [], colOrder: [],
      type: "Call+Put", instrument: "NIFTY", timeframe: "5m",
      callStrike: 24300, putStrike: 24000,
    });
    expect(built).not.toBeNull();
    expect(built!.filename).toBe(`Module1_NIFTY_5Min_${istDateStr()}.xlsx`);

    await built!.wb.xlsx.writeFile(outFile);
    expect(fs.existsSync(outFile)).toBe(true);

    const reloaded = new Workbook();
    await reloaded.xlsx.readFile(outFile);
    const ws = reloaded.getWorksheet("Module1");

    expect(ws).toBeDefined();
    expect(ws!.rowCount).toBe(5); // 2 header rows + 3 data rows
    expect(ws!.getCell("A2").value).toBe("Time");
    // chronological order preserved — oldest first, newest last (time-only display)
    expect(ws!.getCell("A3").value).toBe("09:30");
    expect(ws!.getCell("A5").value).toBe("09:40");
    // ranking column display formatting (no leading +)
    expect(ws!.getCell("P4").value).toBe("11");
    // section titles include selected strike values
    expect(ws!.getCell("B1").value).toBe("24300Call");
    expect(ws!.getCell("I1").value).toBe("24000Put");

    // Group header styling matches the live table palette.
    expect(ws!.getCell("B1").fill).toMatchObject({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFDBEAFE" },
    });

    // Call Open's latest new high uses the existing dark-blue HLC palette.
    expect(ws!.getCell("B5").fill).toMatchObject({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E3A8A" },
    });
    expect(ws!.getCell("B5").font).toMatchObject({
      color: { argb: "FFFFFFFF" },
    });

    // Ranking rises versus the previous row, so it exports with the dark-green fill.
    expect(ws!.getCell("P5").fill).toMatchObject({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF22C063" },
    });
    expect(ws!.getCell("P5").font).toMatchObject({
      color: { argb: "FFFFFFFF" },
      bold: true,
    });
  });

  it("no-ops when there are no rows", () => {
    const ok = exportModule1Excel({
      rows: [], hiddenCols: [], colOrder: [],
      type: "Call+Put", instrument: "NIFTY", timeframe: "5m",
    });
    expect(ok).toBe(false);
  });

  it("exportModule1Excel succeeds when rows are provided", async () => {
    const base = Date.now();
    const rows = [mkRow(base, 0)];
    const result = exportModule1Excel({
      rows, hiddenCols: [], colOrder: [],
      type: "Call+Put", instrument: "NIFTY", timeframe: "5m",
    });
    expect(result).toBe(true);
  });
});
