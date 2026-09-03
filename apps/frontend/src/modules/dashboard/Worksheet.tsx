import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { DashboardRow, PivotMethod } from "../../calc";
import { buildLiveColorGrid } from "./cellColorRules";
import {
  ALL_COLS,
  GROUP_COLORS,
  GROUP_LABELS,
  getCellRawValue,
  getCellValue,
  getDashboardCellPresentation,
  getVisibleColumns,
  type Group,
} from "./tablePresentation";

export {
  ALL_COLS,
  GROUP_LABELS,
  TYPE_HIDDEN,
  getCellRawValue,
  getCellValue,
  getVisibleColumns,
  rankingDir,
  rankingDisplayValue,
} from "./tablePresentation";
export type { ColSpec, Group, RankDir } from "./tablePresentation";

interface SelRange { r1: number; c1: number; r2: number; c2: number; }

interface WorksheetProps {
  rows: DashboardRow[];
  hiddenCols: string[];
  colOrder: string[];
  feedStatus: "idle" | "live" | "interrupted";
  isLoading: boolean;
  type: "Call" | "Put" | "Call+Put";
  pivotMethod: PivotMethod;
}

// ── Frozen-column detector (dev-only debugging utility) ───────────────────────
// Columns that legitimately repeat the same value across many rows by design —
// never a sign of a stuck calculation:
//   datetime — the frozen (pinned) leftmost column, not a data value at all
//   space    — reserved placeholder column with no data/logic (always "")
//   smc/fib  — "nearest level" labels; the nearest SWH/SWL/PDH/PDL or Fib
//              level legitimately stays the same across many bars
//   vwap     — null ("VWAP Not Available") until cumulative Future volume > 0
//   ema      — a 3-way categorical label (CALL/PUT/NEUTRAL), not a continuous
//              price; long runs of the same label are expected
const FROZEN_DETECTOR_EXCLUDED_COLS = new Set(["datetime", "space", "smc", "fib", "vwap", "ema"]);

// Floating-point tolerance for the frozen-column detector's raw-value
// comparison — two values are only "the same" when they're mathematically
// equal within this margin, not merely equal after display rounding.
const FROZEN_DETECTOR_EPSILON = 0.0001;

const rawValuesEqual = (a: number | string, b: number | string): boolean =>
  typeof a === "number" && typeof b === "number"
    ? Math.abs(a - b) < FROZEN_DETECTOR_EPSILON
    : a === b;

// Missing-data sentinels (NaN, null, "—", "") never count as "the same value" —
// a column of all-missing cells isn't a frozen calculation, it's absent data.
const isValidRawValue = (v: number | string | null): v is number | string => {
  if (v == null) return false;
  if (typeof v === "number") return Number.isFinite(v);
  return v !== "" && v !== "—";
};

// ── Shimmer skeleton ──────────────────────────────────────────────────────────

const SHIMMER_STYLE: React.CSSProperties = {
  background: "linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)",
  backgroundSize: "200% 100%",
  animation: "ws-shimmer 1.5s infinite",
  borderRadius: 2,
  height: 13,
  display: "block",
};

// ── Main component ────────────────────────────────────────────────────────────

export function Worksheet({ rows, hiddenCols, colOrder, feedStatus, isLoading, type, pivotMethod }: WorksheetProps) {
  const cols = getVisibleColumns(type, hiddenCols, colOrder);

  const initWidths = (): Record<string, number> => {
    const w: Record<string, number> = {};
    ALL_COLS.forEach(c => { w[c.id] = c.defaultW; });
    return w;
  };
  const [colWidths, setColWidths] = useState<Record<string, number>>(initWidths);
  const [selRange, setSelRange]   = useState<SelRange | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ── Full Screen mode (UI-only — layout, no data/calc effect) ─────────────
  // Expands ONLY this table's container to fill the viewport; the rest of
  // the dashboard (InfoBar/ConfigRow/TimeframeRow) is simply visually
  // covered (position: fixed, full viewport, opaque background, high
  // z-index) — nothing outside this component is touched, no state/rows are
  // reloaded or recalculated, no API calls are made.
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => {
    if (isFullscreen) {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => { /* ignore */ });
      }
      setIsFullscreen(false);
      return;
    }
    const el = fullscreenContainerRef.current;
    if (el?.requestFullscreen) {
      el.requestFullscreen()
        .then(() => setIsFullscreen(true))
        .catch(() => setIsFullscreen(true)); // Fullscreen API blocked/unsupported → CSS-only fallback
    } else {
      setIsFullscreen(true);
    }
  }, [isFullscreen]);

  // Keep state in sync when the user exits native fullscreen via the
  // browser's own Esc-key handling (not our button).
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setIsFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Dev-only: detect columns whose values are identical across every visible row.
  const frozenWarnKeyRef = useRef<string>("");
  const [frozenWarn, setFrozenWarn] = useState<string[]>([]);

  // rows is already chronological (oldest first, appendRow pushes newest to
  // the end) — display in that order so the earliest candle is the first row
  // and the live candle is always the last.
  const displayRows = rows;

  // ── Auto-scroll to the latest candle (live-terminal behavior) ────────────
  // Tracks whether the user is currently pinned to the bottom via a ref (not
  // state) so scroll events never trigger a re-render. When a new row is
  // appended, we only jump to the bottom if the user was already there —
  // scrolling up to inspect history pauses auto-scroll until they scroll
  // back down. Only scrollTop is touched, so horizontal scroll position,
  // frozen columns, and sticky headers are all untouched.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isPinnedToBottomRef = useRef(true);
  const BOTTOM_PIN_THRESHOLD_PX = 24;

  const handleTableScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isPinnedToBottomRef.current = distanceFromBottom <= BOTTOM_PIN_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !isPinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [displayRows.length]);

  // Column-independent Blue/Green/Pink/Black live coloring (see
  // ./cellColorRules) — one left-to-right pass per applicable column,
  // recomputed only when the `rows` array reference actually changes
  // (every live tick), never on unrelated re-renders (selection, resize,
  // column visibility, etc.).
  const liveColorGrid = useMemo(() => buildLiveColorGrid(displayRows), [displayRows]);

  const copySelection = useCallback(() => {
    if (!selRange) return;
    const { r1, c1, r2, c2 } = selRange;
    const lines: string[] = [];
    for (let ri = r1; ri <= r2; ri++) {
      const row = displayRows[ri];
      if (!row) continue;
      const cells: string[] = [];
      for (let ci = c1; ci <= c2; ci++) {
        const col = cols[ci];
        if (col) cells.push(getCellValue(row, col.id, pivotMethod));
      }
      lines.push(cells.join("\t"));
    }
    navigator.clipboard.writeText(lines.join("\n")).catch(() => { /* ignore */ });
  }, [selRange, displayRows, cols, pivotMethod]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && selRange) copySelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copySelection, selRange]);

  useEffect(() => {
    const onUp = () => setIsDragging(false);
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, []);

  // Frozen-column detector — dev only.
  // A column is "frozen" when every non-missing row's RAW (pre-formatting)
  // value is the same within FROZEN_DETECTOR_EPSILON, which indicates the row
  // builder copied one price into all rows instead of using per-bar data.
  // Compares getCellRawValue, never getCellValue/p0() — a column can display
  // identical truncated text (e.g. 104.20/104.38/104.46/104.42 all showing
  // "104") while the underlying calculation is changing correctly every row;
  // that is a display-rounding artifact, not a frozen calculation, and must
  // not be reported here.
  useEffect(() => {
    if (!import.meta.env.DEV || displayRows.length < 2) {
      if (frozenWarn.length > 0) setFrozenWarn([]);
      return;
    }
    const frozen: string[] = [];
    for (const col of cols) {
      if (FROZEN_DETECTOR_EXCLUDED_COLS.has(col.id)) continue;
      const raws = displayRows.map(row => getCellRawValue(row, col.id, pivotMethod));
      const valid = raws.filter(isValidRawValue);
      if (valid.length >= 2 && valid.every(v => rawValuesEqual(v, valid[0]))) {
        const shown = typeof valid[0] === "number" ? valid[0].toFixed(4) : valid[0];
        console.warn(`[Worksheet] FROZEN COLUMN: "${col.sub}" (${col.id}) — all ${valid.length} rows ≈ ${shown} (raw value, tolerance ${FROZEN_DETECTOR_EPSILON})`);
        frozen.push(col.sub);
      }
    }
    const key = frozen.join("|");
    if (key !== frozenWarnKeyRef.current) {
      frozenWarnKeyRef.current = key;
      setFrozenWarn(frozen);
    }
  }, [displayRows, cols, pivotMethod]); // eslint-disable-line react-hooks/exhaustive-deps

  const startResize = (colId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[colId] ?? 80;
    const onMove = (ev: MouseEvent) => {
      setColWidths(prev => ({ ...prev, [colId]: Math.max(40, startW + ev.clientX - startX) }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const totalW = cols.reduce((s, c) => s + (colWidths[c.id] ?? c.defaultW), 0);

  const frozenLeft = (_colId: string): number => 0; // single frozen column always at left: 0

  // Build group spans as a run-length encoding of the visible column list.
  // Also track the pixel left-offset of each group's first column so the
  // frozen Date & Time group header can be pinned to left: 0.
  const visibleGroupSpans = (() => {
    const result: {
      group: Group;
      label: string;
      span: number;
      frozen: boolean;
      leftPx: number;
    }[] = [];
    let leftAcc = 0;

    for (const col of cols) {
      const last = result[result.length - 1];
      if (last && last.group === col.group) {
        last.span++;
      } else {
        result.push({
          group:  col.group,
          label:  GROUP_LABELS[col.group],
          span:   1,
          frozen: !!col.frozen,
          leftPx: leftAcc,
        });
      }
      leftAcc += colWidths[col.id] ?? col.defaultW;
    }
    return result;
  })();

  // ── Shared header heights ──────────────────────────────────────────────────
  // Row 1 (group header) is 40 px; row 2 (column sub-header) is sticky at top: 40.

  const GROUP_ROW_H = 40;

  // ── Skeleton rows ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "#FFFFFF" }}>
        <style>{`
          @keyframes ws-shimmer {
            0%  { background-position: 200% 0 }
            100%{ background-position: -200% 0 }
          }
        `}</style>
        <table style={{ borderCollapse: "collapse", tableLayout: "fixed", width: totalW }}>
          <colgroup>{cols.map(c => <col key={c.id} style={{ width: colWidths[c.id] ?? c.defaultW }} />)}</colgroup>
          <thead>
            <tr>
              {visibleGroupSpans.map((gs, i) => {
                const gc = GROUP_COLORS[gs.group];
                return (
                  <th key={i} colSpan={gs.span} style={{
                    border: "1px solid #BDC4CF", padding: "4px 10px",
                    fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
                    fontSize: 24, lineHeight: 1, fontWeight: 700, height: GROUP_ROW_H,
                    whiteSpace: "nowrap", textAlign: "center", letterSpacing: "0.04em",
                    textTransform: "uppercase", userSelect: "none",
                    position: "sticky", top: 0, zIndex: gs.frozen ? 7 : 5,
                    background: gc.bg, color: gc.text,
                    ...(gs.frozen ? { left: gs.leftPx } : {}),
                  }}>
                    {gs.label}
                  </th>
                );
              })}
            </tr>
            <tr>
              {cols.map(c => {
                const gc = GROUP_COLORS[c.group];
                return (
                  <th key={c.id} style={{
                    border: "1px solid #BDC4CF", padding: "4px 10px",
                    fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
                    fontSize: 24, lineHeight: 1, fontWeight: 600, whiteSpace: "nowrap",
                    textAlign: "center", userSelect: "none",
                    position: "sticky", top: GROUP_ROW_H, zIndex: 4,
                    background: gc.subBg, color: gc.text,
                  }}>
                    {c.sub}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, ri) => (
              <tr key={ri}>
                {cols.map(c => (
                  <td key={c.id} style={{
                    border: "1px solid #BDC4CF", padding: "6px 10px",
                    height: 42, background: "#FFFFFF", fontSize: 24,
                  }}>
                    <span style={SHIMMER_STYLE} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────────

  if (rows.length === 0) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#FFFFFF" }}>
        <div style={{ textAlign: "center", color: "#9CA3AF" }}>
          <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.3 }}>📊</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1A2533", marginBottom: 6 }}>No data yet</div>
          <div style={{ fontSize: 13, color: "#5B6B7F" }}>Configure your selection above and press <strong>Generate</strong></div>
        </div>
      </div>
    );
  }

  // ── Main Excel-style table ────────────────────────────────────────────────

  return (
    <div
      ref={fullscreenContainerRef}
      style={{
        flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column",
        position: isFullscreen ? "fixed" : "relative",
        ...(isFullscreen
          ? { top: 0, left: 0, right: 0, bottom: 0, width: "100vw", height: "100vh", zIndex: 9999, background: "#FFFFFF" }
          : {}),
      }}
    >
      <button
        type="button"
        onClick={toggleFullscreen}
        title={isFullscreen ? "Exit full screen" : "Full screen"}
        aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
        style={{
          position: "absolute", top: 6, right: 10, zIndex: 20,
          width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center",
          border: "1px solid #BDC4CF", borderRadius: 4, background: "#FFFFFF",
          cursor: "pointer", fontSize: 13, lineHeight: 1, color: "#1A2533", padding: 0,
        }}
      >
        {isFullscreen ? "✖" : "⛶"}
      </button>
      {import.meta.env.DEV && frozenWarn.length > 0 && (
        <div style={{
          background: "#FEF2F2", borderBottom: "2px solid #EF4444",
          padding: "4px 14px", fontSize: 11, fontWeight: 600, color: "#DC2626", flexShrink: 0,
        }}>
          ⚠ DEV: frozen columns (all rows identical): {frozenWarn.join(", ")} — check data pipeline
        </div>
      )}
      <style>{`
        @keyframes ws-shimmer {
          0%  { background-position: 200% 0 }
          100%{ background-position: -200% 0 }
        }
        .ws-row:hover td:not([data-colored="true"]) { background: #EBF3FA !important; }
        .ws-row:hover td[data-colored="true"] { filter: brightness(0.96); }
      `}</style>

      {feedStatus === "interrupted" && (
        <div style={{
          background: "#FEF3C7", borderBottom: "1px solid #FDE68A",
          padding: "5px 14px", fontSize: 12, fontWeight: 600, color: "#92400E",
          flexShrink: 0,
        }}>
          ⚠ Feed interrupted — reconnecting…
        </div>
      )}

      {/* ── Scrollable table area ─────────────────────────────────────────── */}
      <div
        ref={scrollContainerRef}
        onScroll={handleTableScroll}
        style={{ flex: 1, minHeight: 0, overflow: "auto", background: "#FFFFFF" }}
      >
        <table style={{
          borderCollapse: "collapse",
          tableLayout: "fixed",
          width: Math.max(totalW, 600),
          minWidth: "100%",
          fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
        }}>
          <colgroup>
            {cols.map(c => <col key={c.id} style={{ width: colWidths[c.id] ?? c.defaultW }} />)}
          </colgroup>

          <thead>
            {/* ── Row 1: Group headers ──────────────────────────────────── */}
            <tr>
              {visibleGroupSpans.map((gs, i) => {
                const gc = GROUP_COLORS[gs.group];
                return (
                  <th
                    key={i}
                    colSpan={gs.span}
                    style={{
                      border: "1px solid #BDC4CF",
                      borderBottom: `2px solid ${gc.text}40`,
                      padding: "4px 10px",
                      fontSize: 24,
                      lineHeight: 1,
                      fontWeight: 700,
                      height: GROUP_ROW_H,
                      whiteSpace: "nowrap",
                      textAlign: "center",
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      userSelect: "none",
                      position: "sticky",
                      top: 0,
                      // Frozen Date & Time group pins to top-left; all others pin to top only.
                      zIndex: gs.frozen ? 7 : 5,
                      background: gc.bg,
                      color: gc.text,
                      ...(gs.frozen ? { left: gs.leftPx } : {}),
                    }}
                  >
                    {gs.label}
                  </th>
                );
              })}
            </tr>

            {/* ── Row 2: Column sub-headers ─────────────────────────────── */}
            <tr>
              {cols.map((c) => {
                const isFrozen = !!c.frozen;
                const gc = GROUP_COLORS[c.group];
                return (
                  <th
                    key={c.id}
                    style={{
                      border: "1px solid #BDC4CF",
                      padding: "4px 10px",
                      fontSize: 24,
                      lineHeight: 1,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      textAlign: "center",
                      userSelect: "none",
                      position: "sticky",
                      top: GROUP_ROW_H,
                      // Frozen sub-headers (date, time) must overlay non-frozen ones on horiz scroll.
                      zIndex: isFrozen ? 6 : 4,
                      background: gc.subBg,
                      color: gc.text,
                      boxShadow: "0 1px 0 #BDC4CF",
                      cursor: "default",
                      ...(isFrozen ? { left: frozenLeft(c.id) } : {}),
                    }}
                  >
                    {c.sub}
                    {/* Drag handle for column resize */}
                    <div
                      onMouseDown={(e) => startResize(c.id, e)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: "absolute", right: 0, top: 0, bottom: 0, width: 5,
                        cursor: "col-resize", zIndex: 10,
                      }}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {displayRows.map((row, ri) => (
              <tr key={row.t} className="ws-row">
                {cols.map((c, ci) => {
                  const isFrozen = !!c.frozen;
                  const isInSel  = selRange !== null
                    && ri >= selRange.r1 && ri <= selRange.r2
                    && ci >= selRange.c1 && ci <= selRange.c2;
                  const presentation = getDashboardCellPresentation({
                    row,
                    prevRow: displayRows[ri - 1],
                    colId: c.id,
                    pivotMethod,
                    colorClass: liveColorGrid[c.id]?.[ri] ?? null,
                  });
                  const isColored = presentation.bg !== "#FFFFFF" && presentation.bg !== "transparent";

                  return (
                    <td
                      key={c.id}
                      data-colored={isColored ? "true" : undefined}
                      title={presentation.tooltip}
                      style={{
                        border: "1px solid #BDC4CF",
                        padding: "6px 10px",
                        fontSize: 24,
                        height: 42,
                        whiteSpace: "nowrap",
                        userSelect: "none",
                        textAlign: (c.align ?? "center") as "left" | "right" | "center",
                        background: isInSel ? "rgba(31,111,235,0.45)" : presentation.bg,
                        color: presentation.textColor,
                        fontWeight: 800,
                        outline: isInSel ? "1px solid #1F6FEB" : "none",
                        outlineOffset: "-1px",
                        position: isFrozen ? "sticky" : "relative",
                        left:   isFrozen ? frozenLeft(c.id) : undefined,
                        zIndex: isFrozen ? 2 : undefined,
                      }}
                      onMouseDown={() => {
                        setSelRange({ r1: ri, c1: ci, r2: ri, c2: ci });
                        setIsDragging(true);
                      }}
                      onMouseEnter={() => {
                        if (isDragging && selRange) {
                          setSelRange({
                            r1: Math.min(selRange.r1, ri), c1: Math.min(selRange.c1, ci),
                            r2: Math.max(selRange.r2, ri), c2: Math.max(selRange.c2, ci),
                          });
                        }
                      }}
                    >
                      {presentation.value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Status bar ────────────────────────────────────────────────────── */}
      <div style={{
        flexShrink: 0, padding: "5px 12px",
        background: "#F3F6FA", borderTop: "1px solid #BDC4CF",
        fontSize: 11, color: "#5B6B7F",
        display: "flex", justifyContent: "space-between",
        fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
      }}>
        <span>{rows.length} bar{rows.length !== 1 ? "s" : ""} · Select range + Ctrl/Cmd-C to copy as TSV</span>
        <span>MA=(O+H+L−C)/4 · TMA=Σ(O+H+L+C)/(4×N) · C/P Sign=MA−TMA · Ranking=max(CallMA,PutMA) · EMA=EMA20 vs EMA200 Spot signal · VWAP Σ(TP×Vol)/ΣVol Future · RSI Wilder(14)</span>
      </div>
    </div>
  );
}

export default Worksheet;
