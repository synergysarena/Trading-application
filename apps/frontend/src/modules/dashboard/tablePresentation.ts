import type { DashboardRow, PivotMethod } from "../../calc";
import { pivotForBar } from "../../calc";
import {
  TRACKED_COLUMN_ACCESSORS,
  TRACKED_COLUMN_THEME,
  colorClassStyle,
  truncateForDisplay,
  type ColorClass,
} from "./cellColorRules";

// Pure, shared table-presentation helpers consumed by both the React worksheet
// and the Excel export path. This keeps display values, column visibility, and
// color presentation in one non-React module.

export type Group = "datetime" | "call" | "put" | "ranking" | "future" | "space" | "spot" | "indicators";
type Align = "left" | "right" | "center";

export interface ColSpec {
  id: string;
  sub: string;
  group: Group;
  defaultW: number;
  frozen?: boolean;
  align?: Align;
}

export interface GroupColorSpec {
  bg: string;
  subBg: string;
  text: string;
}

export const TYPE_HIDDEN: Record<string, string[]> = {
  "Call": ["pe-o", "pe-h", "pe-l", "pe-c", "mma-p", "tla-p", "p-sign"],
  "Put": ["ce-o", "ce-h", "ce-l", "ce-c", "mma-c", "tla-c", "c-sign"],
  "Call+Put": [],
};

const PIVOT_UI_HIDDEN = ["pp", "r1", "r2", "r3", "s1", "s2", "s3"];
const INDICATOR_UI_HIDDEN = ["ema200", "ema-score", "vwap-score", "total-score", "rating", "signal"];

export const ALL_COLS: ColSpec[] = [
  { id: "datetime", sub: "Time", group: "datetime", defaultW: 76, frozen: true, align: "center" },
  { id: "ce-o", sub: "Open", group: "call", defaultW: 84 },
  { id: "ce-h", sub: "High", group: "call", defaultW: 84 },
  { id: "ce-l", sub: "Low", group: "call", defaultW: 84 },
  { id: "ce-c", sub: "Close", group: "call", defaultW: 84 },
  { id: "mma-c", sub: "MA", group: "call", defaultW: 91 },
  { id: "tla-c", sub: "TMA", group: "call", defaultW: 91 },
  { id: "c-sign", sub: "C Sign", group: "call", defaultW: 84 },
  { id: "pe-o", sub: "Open", group: "put", defaultW: 84 },
  { id: "pe-h", sub: "High", group: "put", defaultW: 84 },
  { id: "pe-l", sub: "Low", group: "put", defaultW: 84 },
  { id: "pe-c", sub: "Close", group: "put", defaultW: 84 },
  { id: "mma-p", sub: "MA", group: "put", defaultW: 91 },
  { id: "tla-p", sub: "TMA", group: "put", defaultW: 91 },
  { id: "p-sign", sub: "P Sign", group: "put", defaultW: 84 },
  { id: "ranking", sub: "Ranking", group: "ranking", defaultW: 95, align: "center" },
  { id: "fut-o", sub: "Open", group: "future", defaultW: 84 },
  { id: "fut-h", sub: "High", group: "future", defaultW: 84 },
  { id: "fut-l", sub: "Low", group: "future", defaultW: 84 },
  { id: "fut-c", sub: "Close", group: "future", defaultW: 84 },
  { id: "fut-mma", sub: "MA", group: "future", defaultW: 91 },
  { id: "fut-tla", sub: "TMA", group: "future", defaultW: 91 },
  { id: "space", sub: "Space", group: "space", defaultW: 84 },
  { id: "spot-o", sub: "Open", group: "spot", defaultW: 84 },
  { id: "spot-h", sub: "High", group: "spot", defaultW: 84 },
  { id: "spot-l", sub: "Low", group: "spot", defaultW: 84 },
  { id: "spot-c", sub: "Close", group: "spot", defaultW: 84 },
  { id: "spot-mma", sub: "MA", group: "spot", defaultW: 91 },
  { id: "spot-tla", sub: "TMA", group: "spot", defaultW: 91 },
  { id: "smc", sub: "SMC", group: "indicators", defaultW: 125, align: "left" },
  { id: "fib", sub: "FIB", group: "indicators", defaultW: 116, align: "left" },
  { id: "rsi", sub: "RSI", group: "indicators", defaultW: 74 },
  { id: "ema", sub: "EMA", group: "indicators", defaultW: 74 },
  { id: "ema200", sub: "EMA200", group: "indicators", defaultW: 80 },
  { id: "vwap", sub: "VWAP", group: "indicators", defaultW: 74 },
  { id: "ema-score", sub: "EMA Score", group: "indicators", defaultW: 87 },
  { id: "vwap-score", sub: "VWAP Score", group: "indicators", defaultW: 91 },
  { id: "total-score", sub: "Total Score", group: "indicators", defaultW: 91 },
  { id: "rating", sub: "Rating", group: "indicators", defaultW: 114, align: "left" },
  { id: "signal", sub: "Signal", group: "indicators", defaultW: 87, align: "left" },
  { id: "pp", sub: "PP", group: "indicators", defaultW: 74 },
  { id: "r1", sub: "R1", group: "indicators", defaultW: 74 },
  { id: "r2", sub: "R2", group: "indicators", defaultW: 74 },
  { id: "r3", sub: "R3", group: "indicators", defaultW: 74 },
  { id: "s1", sub: "S1", group: "indicators", defaultW: 74 },
  { id: "s2", sub: "S2", group: "indicators", defaultW: 74 },
  { id: "s3", sub: "S3", group: "indicators", defaultW: 74 },
];

export const GROUP_LABELS: Record<Group, string> = {
  datetime: "Time",
  call: "Call",
  put: "Put",
  ranking: "Ranking",
  future: "Future",
  space: "Space",
  spot: "Spot",
  indicators: "Indicators",
};

export const GROUP_COLORS: Record<Group, GroupColorSpec> = {
  datetime: { bg: "#E8EDF2", subBg: "#EFF2F6", text: "#1A2533" },
  call: { bg: "#DBEAFE", subBg: "#EFF6FF", text: "#1E40AF" },
  put: { bg: "#FEF3C7", subBg: "#FFFBEB", text: "#92400E" },
  ranking: { bg: "#F3E8FF", subBg: "#FAF0FF", text: "#6B21A8" },
  future: { bg: "#D1FAE5", subBg: "#ECFDF5", text: "#22C063" },
  space: { bg: "#E5E7EB", subBg: "#F3F4F6", text: "#4B5563" },
  spot: { bg: "#CCFBF1", subBg: "#F0FDFA", text: "#0F766E" },
  indicators: { bg: "#EDE9FE", subBg: "#F5F3FF", text: "#4C1D95" },
};

type CellColor = { bg: string; textColor: string };

const C_DEFAULT: CellColor = { bg: "#FFFFFF", textColor: "#000000" };
const C_RANK_CALL: CellColor = { bg: "#FFFFFF", textColor: "#1E40AF" };
const C_RANK_PUT: CellColor = { bg: "#FFFFFF", textColor: "#78350F" };
const NON_NUMERIC_COLS = new Set(["datetime", "smc", "fib", "ema", "rating", "signal"]);

export type RankDir = "up" | "down" | "flat" | "none";

export function rankingDir(curr: number, prev: number | undefined): RankDir {
  if (prev === undefined || !Number.isFinite(prev) || !Number.isFinite(curr)) return "none";
  if (curr > prev) return "up";
  if (curr < prev) return "down";
  return "flat";
}

function getStaticCellStyle(colId: string, row: DashboardRow): CellColor {
  switch (colId) {
    case "ranking":
      return row.rankingWinner === "call" ? C_RANK_CALL : C_RANK_PUT;
    default:
      return C_DEFAULT;
  }
}

const p0 = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const val = truncateForDisplay(n);
  const clean = Object.is(val, -0) || val === 0 ? 0 : val;
  return clean.toLocaleString("en-IN");
};

const p0NoGroup = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const val = truncateForDisplay(n);
  const clean = Object.is(val, -0) || val === 0 ? 0 : val;
  return String(clean);
};

const fmtSign = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const val = truncateForDisplay(n);
  const clean = Object.is(val, -0) || val === 0 ? 0 : val;
  return clean.toLocaleString("en-IN");
};

const fmtVwap = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "VWAP Not Available" : String(truncateForDisplay(n));

const fmtEmaSignal = (score: number | null | undefined): string => {
  if (score == null || !Number.isFinite(score)) return "—";
  if (score > 0) return "CALL (+1)";
  if (score < 0) return "PUT (-1)";
  return "NEUTRAL (0)";
};

const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  const opts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  };
  return d.toLocaleTimeString("en-GB", opts);
};

export function rankingDisplayValue(row: DashboardRow, prevRow: DashboardRow | undefined): string {
  const dir = rankingDir(row.ranking, prevRow?.ranking);
  let val = p0(row.ranking);
  if (dir === "down" && row.ranking >= 0 && !val.startsWith("-") && val !== "0") {
    val = "-" + val;
  }
  return val;
}

export function getVisibleColumns(type: string, hiddenCols: string[], colOrder: string[]): ColSpec[] {
  const typeHidden = TYPE_HIDDEN[type] ?? [];
  const sortedBase = colOrder.length > 0
    ? [...ALL_COLS].sort((a, b) => {
      const ai = colOrder.indexOf(a.id);
      const bi = colOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    })
    : ALL_COLS;

  return sortedBase.filter(c =>
    !hiddenCols.includes(c.id)
    && !typeHidden.includes(c.id)
    && !PIVOT_UI_HIDDEN.includes(c.id)
    && !INDICATOR_UI_HIDDEN.includes(c.id)
  );
}

export function getCellValue(row: DashboardRow, colId: string, pivotMethod: PivotMethod = "client"): string {
  switch (colId) {
    case "datetime": return fmtTime(row.t);
    case "ce-o": return p0(row.call.o);
    case "ce-h": return p0(row.call.h);
    case "ce-l": return p0(row.call.l);
    case "ce-c": return p0(row.call.c);
    case "mma-c": return p0(row.callMMA);
    case "tla-c": return p0(row.callTMA);
    case "c-sign": return fmtSign(row.callMMA - row.callTMA);
    case "pe-o": return p0(row.put.o);
    case "pe-h": return p0(row.put.h);
    case "pe-l": return p0(row.put.l);
    case "pe-c": return p0(row.put.c);
    case "mma-p": return p0(row.putMMA);
    case "tla-p": return p0(row.putTMA);
    case "p-sign": return fmtSign(row.putMMA - row.putTMA);
    case "ranking": return p0(row.ranking);
    case "fut-o": return p0NoGroup(row.future.o);
    case "fut-h": return p0NoGroup(row.future.h);
    case "fut-l": return p0NoGroup(row.future.l);
    case "fut-c": return p0NoGroup(row.future.c);
    case "fut-mma": return p0NoGroup(row.futureMMA);
    case "fut-tla": return p0NoGroup(row.futureTMA);
    case "space": return p0NoGroup((row.callMMA - row.callTMA) - (row.putMMA - row.putTMA));
    case "spot-o": return p0NoGroup(row.spot.o);
    case "spot-h": return p0NoGroup(row.spot.h);
    case "spot-l": return p0NoGroup(row.spot.l);
    case "spot-c": return p0NoGroup(row.spot.c);
    case "spot-mma": return p0NoGroup(row.spotMMA);
    case "spot-tla": return p0NoGroup(row.spotTMA);
    case "smc": return row.smc;
    case "fib": return row.fib;
    case "rsi": return p0NoGroup(row.rsi);
    case "ema": return fmtEmaSignal(row.emaScore);
    case "vwap": return fmtVwap(row.vwap);
    case "ema200": return p0NoGroup(row.ema200);
    case "ema-score": return p0NoGroup(row.emaScore);
    case "vwap-score": return p0NoGroup(row.vwapScore);
    case "total-score": return p0NoGroup(row.totalScore);
    case "rating": return row.rating ?? "—";
    case "signal": return row.signal ?? "—";
    case "pp": return p0NoGroup(pivotForBar(pivotMethod, row.future)?.pp);
    case "r1": return p0NoGroup(pivotForBar(pivotMethod, row.future)?.r1);
    case "r2": return p0NoGroup(pivotForBar(pivotMethod, row.future)?.r2);
    case "r3": return p0NoGroup(pivotForBar(pivotMethod, row.future)?.r3);
    case "s1": return p0NoGroup(pivotForBar(pivotMethod, row.future)?.s1);
    case "s2": return p0NoGroup(pivotForBar(pivotMethod, row.future)?.s2);
    case "s3": return p0NoGroup(pivotForBar(pivotMethod, row.future)?.s3);
    default: return "—";
  }
}

export function getCellRawValue(row: DashboardRow, colId: string, pivotMethod: PivotMethod = "client"): number | string | null {
  switch (colId) {
    case "ce-o": return row.call.o;
    case "ce-h": return row.call.h;
    case "ce-l": return row.call.l;
    case "ce-c": return row.call.c;
    case "mma-c": return row.callMMA;
    case "tla-c": return row.callTMA;
    case "c-sign": return row.callMMA - row.callTMA;
    case "pe-o": return row.put.o;
    case "pe-h": return row.put.h;
    case "pe-l": return row.put.l;
    case "pe-c": return row.put.c;
    case "mma-p": return row.putMMA;
    case "tla-p": return row.putTMA;
    case "p-sign": return row.putMMA - row.putTMA;
    case "ranking": return row.ranking;
    case "fut-o": return row.future.o;
    case "fut-h": return row.future.h;
    case "fut-l": return row.future.l;
    case "fut-c": return row.future.c;
    case "fut-mma": return row.futureMMA;
    case "fut-tla": return row.futureTMA;
    case "spot-o": return row.spot.o;
    case "spot-h": return row.spot.h;
    case "spot-l": return row.spot.l;
    case "spot-c": return row.spot.c;
    case "spot-mma": return row.spotMMA;
    case "spot-tla": return row.spotTMA;
    case "smc": return row.smc;
    case "fib": return row.fib;
    case "rsi": return row.rsi;
    case "vwap": return row.vwap;
    case "ema200": return row.ema200;
    case "ema-score": return row.emaScore;
    case "vwap-score": return row.vwapScore;
    case "total-score": return row.totalScore;
    case "rating": return row.rating;
    case "signal": return row.signal;
    case "pp": return pivotForBar(pivotMethod, row.future)?.pp ?? null;
    case "r1": return pivotForBar(pivotMethod, row.future)?.r1 ?? null;
    case "r2": return pivotForBar(pivotMethod, row.future)?.r2 ?? null;
    case "r3": return pivotForBar(pivotMethod, row.future)?.r3 ?? null;
    case "s1": return pivotForBar(pivotMethod, row.future)?.s1 ?? null;
    case "s2": return pivotForBar(pivotMethod, row.future)?.s2 ?? null;
    case "s3": return pivotForBar(pivotMethod, row.future)?.s3 ?? null;
    default: return null;
  }
}

export function getCellTooltip(row: DashboardRow, colId: string, pivotMethod: PivotMethod = "client"): string | undefined {
  const raw = getCellRawValue(row, colId, pivotMethod);
  if (raw == null || typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const clean = Object.is(raw, -0) || raw === 0 ? 0 : raw;
  const rounded = Number(Math.round(Number(clean + "e4")) + "e-4");
  return String(rounded);
}

export interface DashboardCellPresentation {
  value: string;
  tooltip?: string;
  bg: string;
  textColor: string;
  fontWeight: number;
}

export function getDashboardCellPresentation(params: {
  row: DashboardRow;
  prevRow?: DashboardRow;
  colId: string;
  pivotMethod?: PivotMethod;
  colorClass?: ColorClass;
}): DashboardCellPresentation {
  const { row, prevRow, colId, pivotMethod = "client", colorClass = null } = params;

  const baseStyle = colId in TRACKED_COLUMN_ACCESSORS
    ? colorClassStyle(colorClass, TRACKED_COLUMN_THEME[colId] ?? "light")
    : getStaticCellStyle(colId, row);

  let value = getCellValue(row, colId, pivotMethod);
  const tooltip = getCellTooltip(row, colId, pivotMethod);
  let bg = baseStyle.bg;
  let textColor = baseStyle.textColor;
  let fontWeight = NON_NUMERIC_COLS.has(colId) ? 400 : 600;

  if (colId === "ranking") {
    const dir = rankingDir(row.ranking, prevRow?.ranking);
    if (dir === "up" || dir === "down") {
      const rankStyle = colorClassStyle(dir === "up" ? "green" : "pink", "dark");
      bg = rankStyle.bg;
      textColor = rankStyle.textColor;
      fontWeight = 600;
    }
    value = rankingDisplayValue(row, prevRow);
  }

  return { value, tooltip, bg, textColor, fontWeight };
}
