import type { DashboardRow } from "../../calc";

// ── Live cell color coding ──────────────────────────────────────────────────
// Column-independent Blue/Green/Pink/Black highlighting for every Call/Put/
// Future/Spot Open/High/Low/Close/MMA/TLA column. Each column tracks its own
// "previous value" and "highest value reached this timeframe" completely
// independently of every other column (see TRACKED_COLUMN_ACCESSORS below).
//
// Rules (evaluated per cell, against that SAME column's own running state):
//   current > all-time-high-so-far   → "blue"  (new high), highest updates
//   current > previous, not new high → "green"
//   current < all-time-low-so-far    → "black" (new low), lowest updates
//   current < previous, not new low  → "pink"
//   current === previous             → same rule as "current > previous"
//                                       (ties resolve to the non-decrease
//                                       side, matching this codebase's other
//                                       tie-break convention — see
//                                       computeRanking's callMMA-putMMA>=0):
//                                       "blue" if it's also a new all-time
//                                       high, otherwise "green". A cell is
//                                       never left uncolored once there is a
//                                       previous value to compare against.
//   first valid value in the column  → null (nothing to compare against yet)
//
// Missing/invalid values (null, undefined, 0, NaN, Infinity) never get a
// color and are skipped entirely for previous/highest tracking.
//
// Highest-value tracking is per column and resets automatically whenever the
// row set is rebuilt (e.g. on a timeframe change, which clears/refetches
// `rows` from scratch — see Dashboard Effect 1) since the whole grid below is
// always recomputed from row 0 of the CURRENT `rows` array.
//
// Blue and Black are additionally "singleton" per column: only the MOST
// RECENT new-high (blue) and the MOST RECENT new-low (black) stay
// highlighted. When a later row earns a fresh blue, the previous row that
// held it is repainted to null; when a later row earns a fresh black, the
// previous row that held it is repainted to pink instead (see
// lastBlueIndex/lastBlackIndex in buildLiveColorGrid below). Green is
// unaffected and can appear on any number of rows simultaneously; pink can
// appear on any number of rows too (both directly, for a drop that isn't a
// new low, and via a black cell being repainted).

// Single source of truth for "the number the trader actually sees" — the
// Worksheet's p0()/fmtVwap() truncate to a whole number for display
// (Math.trunc), and the color engine below compares THIS SAME rounded value,
// not the raw sub-decimal float. Two consecutive rows whose raw values only
// differ by a fraction (e.g. 19.6 -> 19.2) both display as "19" — coloring
// off the raw values would flag that pair as a real decrease even though
// nothing visibly changed on screen, which is exactly the "equal values
// getting colored" defect this fixes. Exported so Worksheet.tsx's p0/fmtVwap
// use the identical function and the two can never drift apart again.
export const truncateForDisplay = (n: number): number => Math.trunc(n);

export type ColorClass = "blue" | "green" | "pink" | "black" | null;

export interface CellColorStyle {
  bg: string;
  textColor: string;
}

const DEFAULT_STYLE: CellColorStyle = { bg: "#FFFFFF", textColor: "#000000" };

// ── Color themes ──────────────────────────────────────────────────────────────
// Same ColorClass, same calculation (nextColorStep below) — only the visual
// palette differs by column group:
//   "light" — the base subtle-background palette (still colorClassStyle's
//             default, and the source LIGHT_THEME_STYLE the "hlc" theme
//             below pulls its green/pink from)
//   "hlc"   — Call/Put/Future/Spot Open/High/Low/Close: green/pink stay the
//             same light backgrounds as "light", but blue/black switch to
//             the stronger "dark" palette so a new-highest or a decrease
//             reads more emphatically on these columns
//   "dark"  — Call/Put/Future/Spot MMA/TLA + the Indicators section
//             (stronger backgrounds, white text, throughout)
// "black" (new lowest) is intentionally identical across "hlc" and "dark" —
// a new low reads the same regardless of column group.
export type ColorTheme = "light" | "hlc" | "dark";

const LIGHT_THEME_STYLE: Record<Exclude<ColorClass, null>, CellColorStyle> = {
  blue:  { bg: "#BFDBFE", textColor: "#1E3A8A" }, // light blue — new highest
  green: { bg: "#BBF7D0", textColor: "#22C063" }, // light green — up, not a new highest
  pink:  { bg: "#FBD5D5", textColor: "#7F1D1D" }, // light pink — down, not a new lowest
  black: { bg: "#111827", textColor: "#FFFFFF" }, // down, new lowest
};

const DARK_THEME_STYLE: Record<Exclude<ColorClass, null>, CellColorStyle> = {
  blue:  { bg: "#1E3A8A", textColor: "#FFFFFF" }, // dark blue — new highest
  green: { bg: "#22C063", textColor: "#FFFFFF" }, // dark green — up, not a new highest
  pink:  { bg: "#B10202", textColor: "#FFFFFF" }, // dark red — down, not a new lowest
  black: { bg: "#111827", textColor: "#FFFFFF" }, // down, new lowest
};

// Open/High/Low/Close: light green/pink (same as LIGHT_THEME_STYLE) but dark
// blue/black (same as DARK_THEME_STYLE) — only blue/black get the darker
// treatment per the client's revision.
const HLC_THEME_STYLE: Record<Exclude<ColorClass, null>, CellColorStyle> = {
  blue:  DARK_THEME_STYLE.blue,
  green: LIGHT_THEME_STYLE.green,
  pink:  LIGHT_THEME_STYLE.pink,
  black: DARK_THEME_STYLE.black,
};

const COLOR_THEME_STYLE: Record<ColorTheme, Record<Exclude<ColorClass, null>, CellColorStyle>> = {
  light: LIGHT_THEME_STYLE,
  hlc:   HLC_THEME_STYLE,
  dark:  DARK_THEME_STYLE,
};

export function colorClassStyle(cls: ColorClass, theme: ColorTheme = "light"): CellColorStyle {
  return cls ? COLOR_THEME_STYLE[theme][cls] : DEFAULT_STYLE;
}

// SMC/FIB render as "<LABEL> <formatted price>" (see calc/index.ts
// smcNearest / nearestFibLabel — e.g. "SWH 23,456.00" or "23.6% 23,456.00").
// The color engine needs a plain number to track against; this pulls the
// trailing formatted price back out of the label.
function parseTrailingNumber(label: string): number | null {
  const match = label.match(/(-?[\d,]+\.\d+)\s*$/);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

interface TrackedColumnDef {
  accessor: (row: DashboardRow) => number | null | undefined;
  theme: ColorTheme;
}

// Every applicable column, mapped to how to read its value off a
// DashboardRow and which palette it uses. Ranking is handled separately in
// Worksheet.tsx (its comparison is against the previous row only, not a
// running highest — see rankingDir). To extend to a future column, add one
// entry here; nothing else changes.
const TRACKED_COLUMNS: Record<string, TrackedColumnDef> = {
  // Group A — Call/Put/Future/Spot Open/High/Low/Close (light green/pink, dark blue/black)
  "ce-o": { accessor: (r) => r.call.o, theme: "hlc" },
  "ce-h": { accessor: (r) => r.call.h, theme: "hlc" },
  "ce-l": { accessor: (r) => r.call.l, theme: "hlc" },
  "ce-c": { accessor: (r) => r.call.c, theme: "hlc" },
  "pe-o": { accessor: (r) => r.put.o, theme: "hlc" },
  "pe-h": { accessor: (r) => r.put.h, theme: "hlc" },
  "pe-l": { accessor: (r) => r.put.l, theme: "hlc" },
  "pe-c": { accessor: (r) => r.put.c, theme: "hlc" },
  "fut-o": { accessor: (r) => r.future.o, theme: "hlc" },
  "fut-h": { accessor: (r) => r.future.h, theme: "hlc" },
  "fut-l": { accessor: (r) => r.future.l, theme: "hlc" },
  "fut-c": { accessor: (r) => r.future.c, theme: "hlc" },
  "spot-o": { accessor: (r) => r.spot.o, theme: "hlc" },
  "spot-h": { accessor: (r) => r.spot.h, theme: "hlc" },
  "spot-l": { accessor: (r) => r.spot.l, theme: "hlc" },
  "spot-c": { accessor: (r) => r.spot.c, theme: "hlc" },
  // SPACE = C Sign − P Sign (C Sign = callMMA−callTMA, P Sign = putMMA−putTMA)
  // — reuses the same OHLC "hlc" theme/engine per spec, not a new color rule.
  "space": { accessor: (r) => (r.callMMA - r.callTMA) - (r.putMMA - r.putTMA), theme: "hlc" },

  // Group B — Call/Put/Future/Spot MA/TMA (dark theme). C Sign / P Sign now
  // use this same engine (client spec update) instead of their prior fixed
  // Dark-Green/Black rule.
  "mma-c": { accessor: (r) => r.callMMA, theme: "dark" },
  "tla-c": { accessor: (r) => r.callTMA, theme: "dark" },
  "mma-p": { accessor: (r) => r.putMMA, theme: "dark" },
  "tla-p": { accessor: (r) => r.putTMA, theme: "dark" },
  "fut-mma": { accessor: (r) => r.futureMMA, theme: "dark" },
  "fut-tla": { accessor: (r) => r.futureTMA, theme: "dark" },
  "spot-mma": { accessor: (r) => r.spotMMA, theme: "dark" },
  "spot-tla": { accessor: (r) => r.spotTMA, theme: "dark" },
  "c-sign": { accessor: (r) => r.callMMA - r.callTMA, theme: "dark" },
  "p-sign": { accessor: (r) => r.putMMA - r.putTMA, theme: "dark" },

  "smc": { accessor: (r) => parseTrailingNumber(r.smc), theme: "dark" },
  "fib": { accessor: (r) => parseTrailingNumber(r.fib), theme: "dark" },
  "rsi": { accessor: (r) => r.rsi, theme: "dark" },
  "ema": { accessor: (r) => r.ema, theme: "dark" }, // raw EMA-20 value — the column itself renders a CALL/PUT/NEUTRAL label, but color tracks the underlying number, same pattern as every other column
  "vwap": { accessor: (r) => r.vwap, theme: "dark" },
};

export const TRACKED_COLUMN_ACCESSORS: Record<string, (row: DashboardRow) => number | null | undefined> =
  Object.fromEntries(Object.entries(TRACKED_COLUMNS).map(([id, def]) => [id, def.accessor]));

export const TRACKED_COLUMN_THEME: Record<string, ColorTheme> =
  Object.fromEntries(Object.entries(TRACKED_COLUMNS).map(([id, def]) => [id, def.theme]));

export function isColorableValue(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v !== 0;
}

const MA_TMA_PAIR_IDS: Record<string, string> = {
  "mma-c": "tla-c",
  "tla-c": "mma-c",
  "mma-p": "tla-p",
  "tla-p": "mma-p",
  "fut-mma": "fut-tla",
  "fut-tla": "fut-mma",
  "spot-mma": "spot-tla",
  "spot-tla": "spot-mma",
};

// Pure step function: computes the color class and updated running-highest /
// running-lowest for a single cell given its current value, the previous
// row's value, and the highest / lowest values observed before this row.
//
// Rules (all column groups):
//   1. Row 0 (prevValue === null) -> null (no color).
//   2. current >= prevValue (Green or Blue):
//        isNewHigh = highestBefore === null || current > highestBefore
//        isNewHigh -> "blue" (running highest)
//        else      -> "green" (up or equal, not highest)
//   3. current < prevValue (Pink or Black):
//        isNewLow  = lowestBefore === null || current < lowestBefore
//        isNewLow  -> "black" (running lowest)
//        else      -> "pink" (down, not lowest)
//
// The palette (light vs hlc vs dark) is applied at render time via
// colorClassStyle(cls, theme) — this calculation is identical across all columns.
export function nextColorStep(
  current: number,
  prevValue: number | null,
  highestBefore: number | null,
  lowestBefore: number | null
): { colorClass: ColorClass; nextHighest: number; nextLowest: number } {
  const nextHighest = highestBefore === null ? current : Math.max(highestBefore, current);
  const nextLowest = lowestBefore === null ? current : Math.min(lowestBefore, current);

  if (prevValue === null) {
    return { colorClass: null, nextHighest, nextLowest };
  }
  // current === prevValue (a genuine tie) intentionally falls into this same
  // branch as current > prevValue — see the rule-table comment above. A tie
  // can never itself be a "new all-time high" here (highestBefore, tracked
  // through every prior row including the one that set prevValue, can never
  // be lower than prevValue === current), so this always resolves to
  // "green" for equal values, never "blue".
  if (current >= prevValue) {
    const isNewHigh = highestBefore === null || current > highestBefore;
    return { colorClass: isNewHigh ? "blue" : "green", nextHighest, nextLowest };
  }
  // current < prevValue
  const isNewLow = lowestBefore === null || current < lowestBefore;
  return { colorClass: isNewLow ? "black" : "pink", nextHighest, nextLowest };
}

// One left-to-right pass per tracked column (O(rows × columns), no
// quadratic rescans) — each column keeps its own prev/highest state as it
// walks the row list, exactly mirroring the independent-per-column contract
// above. Call with the live `rows` array; memoize on that array's reference
// (it's a fresh array on every append/update — see useDashStore) so this
// only reruns when the data actually changes, not on every render.
export function buildLiveColorGrid(rows: DashboardRow[]): Record<string, ColorClass[]> {
  const grid: Record<string, ColorClass[]> = {};
  const normalizedValuesByColId: Record<string, Array<number | null>> = {};

  for (const [colId, def] of Object.entries(TRACKED_COLUMNS)) {
    const values: Array<number | null> = new Array(rows.length).fill(null);
    for (let i = 0; i < rows.length; i++) {
      const raw = def.accessor(rows[i]);
      values[i] = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    }
    normalizedValuesByColId[colId] = values;
  }

  for (const [colId] of Object.entries(TRACKED_COLUMNS)) {
    const colColors: ColorClass[] = new Array(rows.length).fill(null);

    if (colId === "space") {
      const values = normalizedValuesByColId[colId] ?? [];
      const positiveValues = values.filter((v): v is number => v !== null && v > 0);
      const negativeValues = values.filter((v): v is number => v !== null && v < 0);
      const highestPositive = positiveValues.length > 0 ? Math.max(...positiveValues) : null;
      const lowestNegative = negativeValues.length > 0 ? Math.min(...negativeValues) : null;

      for (let i = 0; i < rows.length; i++) {
        const raw = values[i];
        if (raw === null) continue;

        let color: ColorClass = null;
        if (raw > 0) color = "green";
        else if (raw < 0) color = "pink";

        if (highestPositive !== null && raw === highestPositive) color = "blue";
        if (lowestNegative !== null && raw === lowestNegative && color !== "blue") color = "black";

        colColors[i] = color;
      }
    } else if (colId === "c-sign" || colId === "p-sign") {
      const values = normalizedValuesByColId[colId] ?? [];
      const positiveValues = values.filter((v): v is number => v !== null && v > 0);
      const lowestValue = values.filter((v): v is number => v !== null).length > 0
        ? Math.min(...values.filter((v): v is number => v !== null))
        : null;
      const highestPositive = positiveValues.length > 0 ? Math.max(...positiveValues) : null;

      for (let i = 0; i < rows.length; i++) {
        const raw = values[i];
        if (raw === null) continue;

        let color: ColorClass = null;
        if (raw > 0) color = "green";
        else color = "black";

        if (highestPositive !== null && raw === highestPositive) color = "blue";
        if (lowestValue !== null && raw === lowestValue && color !== "blue") color = "black";

        colColors[i] = color;
      }
    } else if (colId in MA_TMA_PAIR_IDS) {
      const values = normalizedValuesByColId[colId] ?? [];
      const pairId = MA_TMA_PAIR_IDS[colId];
      const pairValues = normalizedValuesByColId[pairId] ?? [];
      const isMaColumn = colId.startsWith("mma") || colId.startsWith("fut-mma") || colId.startsWith("spot-mma");
      const numericValues = values.filter((v): v is number => v !== null);
      const highestValue = numericValues.length > 0 ? Math.max(...numericValues) : null;
      const lowestValue = numericValues.length > 0 ? Math.min(...numericValues) : null;

      for (let i = 0; i < rows.length; i++) {
        const raw = values[i];
        const pairRaw = pairValues[i];
        if (raw === null || pairRaw === null) continue;

        let color: ColorClass = null;
        if (isMaColumn) {
          if (raw > pairRaw) color = "green";
          else if (raw < pairRaw) color = "pink";
          else color = "green";
        } else {
          if (raw < pairRaw) color = "pink";
          else if (raw > pairRaw) color = "green";
          else color = "pink";
        }

        if (highestValue !== null && raw === highestValue) color = "blue";
        if (lowestValue !== null && raw === lowestValue && color !== "blue") color = "black";

        colColors[i] = color;
      }
    } else {
      let prevValue: number | null = null;
      let highest: number | null = null;
      let lowest: number | null = null;
      // Index of the row currently holding this column's blue/black — at most
      // one of each may be lit at a time. When a later row earns a fresh blue,
      // the row at the recorded index is repainted to null first. When a later
      // row earns a fresh black, the row at the recorded index is repainted to
      // pink first.
      let lastBlueIndex: number | null = null;
      let lastBlackIndex: number | null = null;

      for (let i = 0; i < rows.length; i++) {
        const raw = normalizedValuesByColId[colId]?.[i] ?? null;
        if (!isColorableValue(raw)) continue; // missing/invalid — no color, don't touch tracking

        const step = nextColorStep(raw, prevValue, highest, lowest);

        if (step.colorClass === "blue") {
          if (lastBlueIndex !== null) colColors[lastBlueIndex] = null;
          lastBlueIndex = i;
        } else if (step.colorClass === "black") {
          if (lastBlackIndex !== null) colColors[lastBlackIndex] = "pink";
          lastBlackIndex = i;
        }

        colColors[i] = step.colorClass;
        prevValue = raw;
        highest = step.nextHighest;
        lowest = step.nextLowest;
      }
    }

    grid[colId] = colColors;
  }

  return grid;
}
