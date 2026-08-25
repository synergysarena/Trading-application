import { useState, useRef, useEffect } from "react";
import { useDashStore } from "./store";
import { exportModule1Excel } from "./excelExport";

const TFS_MIN = ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "45m"];
const TFS_HR  = ["1h", "2h", "3h", "4h"];

// Ordered list of all toggleable column IDs — matches Worksheet ALL_COLS order (v2 31-col spec).
const ALL_COL_IDS = [
  // Time (1 frozen)
  "datetime",
  // Call (7)
  "ce-o", "ce-h", "ce-l", "ce-c", "mma-c", "tla-c", "c-sign",
  // Put (7)
  "pe-o", "pe-h", "pe-l", "pe-c", "mma-p", "tla-p", "p-sign",
  // Ranking (1)
  "ranking",
  // Future (6)
  "fut-o", "fut-h", "fut-l", "fut-c", "fut-mma", "fut-tla",
  // Space (1) — reserved placeholder column
  "space",
  // Spot (6)
  "spot-o", "spot-h", "spot-l", "spot-c", "spot-mma", "spot-tla",
  // Indicators (5)
  "smc", "fib", "rsi", "ema", "vwap",
  // EMA20 vs EMA200 / VWAP vs EMA20 scoring (client EMA & VWAP spec) — 6 columns
  "ema200", "ema-score", "vwap-score", "total-score", "rating", "signal",
  // Pivot Points (PP/R1-R3/S1-S3) are intentionally excluded here — they are
  // calculated (see calc/pivotForBar + Worksheet.getCellValue) but hidden from
  // the worksheet UI, so they must not appear as togglable columns either.
];

const ALL_COL_LABELS: Record<string, string> = {
  datetime: "Time",
  "ce-o": "Call Open",  "ce-h": "Call High", "ce-l": "Call Low",  "ce-c": "Call Close",
  "mma-c": "Call MA",   "tla-c": "Call TMA", "c-sign": "C Sign",
  "pe-o": "Put Open",   "pe-h": "Put High",  "pe-l": "Put Low",   "pe-c": "Put Close",
  "mma-p": "Put MA",    "tla-p": "Put TMA",  "p-sign": "P Sign",
  ranking: "Ranking",
  "fut-o": "Fut Open",  "fut-h": "Fut High", "fut-l": "Fut Low",  "fut-c": "Fut Close",
  "fut-mma": "Fut MA",  "fut-tla": "Fut TMA",
  space: "Space",
  "spot-o": "Spot Open","spot-h": "Spot High","spot-l": "Spot Low","spot-c": "Spot Close",
  "spot-mma": "Spot MA","spot-tla": "Spot TMA",
  smc: "SMC", fib: "FIB", rsi: "RSI", ema: "EMA", vwap: "VWAP",
  ema200: "EMA200", "ema-score": "EMA Score", "vwap-score": "VWAP Score",
  "total-score": "Total Score", rating: "Rating", signal: "Signal",
};

// Group label for each column ID — used to render dividers in the panel.
const COL_GROUP_LABEL: Record<string, string> = {
  datetime: "Time",
  "ce-o": "Call", "ce-h": "Call", "ce-l": "Call", "ce-c": "Call",
  "mma-c": "Call", "tla-c": "Call", "c-sign": "Call",
  "pe-o": "Put",  "pe-h": "Put",  "pe-l": "Put",  "pe-c": "Put",
  "mma-p": "Put", "tla-p": "Put", "p-sign": "Put",
  ranking: "Ranking",
  "fut-o": "Future", "fut-h": "Future", "fut-l": "Future", "fut-c": "Future",
  "fut-mma": "Future", "fut-tla": "Future",
  space: "Space",
  "spot-o": "Spot", "spot-h": "Spot", "spot-l": "Spot", "spot-c": "Spot",
  "spot-mma": "Spot", "spot-tla": "Spot",
  smc: "Indicators", fib: "Indicators", rsi: "Indicators", ema: "Indicators", vwap: "Indicators",
  ema200: "Indicators", "ema-score": "Indicators", "vwap-score": "Indicators",
  "total-score": "Indicators", rating: "Indicators", signal: "Indicators",
};

const CUSTOM_CANDLE_TFS = ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "45m", "1h", "2h", "3h", "4h"];

function localToUtcIso(localDt: string): string {
  if (!localDt) return "";
  return new Date(localDt).toISOString();
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function marketOpenDefault(date: string): string { return `${date}T09:15`; }
function marketCloseDefault(date: string): string { return `${date}T15:30`; }

export function TimeframeRow() {
  const {
    timeframe, setTimeframe, customRange, setCustomRange,
    feedStatus, hiddenCols, toggleColumn,
    colOrder, setColOrder,
    rows, type, instrument, pivotMethod,
    callStrike, putStrike,
  } = useDashStore();

  const [colsOpen, setColsOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // Local drag-reorder state
  const dragIdRef   = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Ordered list for display in the panel: apply colOrder then append any not in order
  const orderedIds = colOrder.length > 0
    ? [
        ...colOrder.filter(id => ALL_COL_IDS.includes(id)),
        ...ALL_COL_IDS.filter(id => !colOrder.includes(id)),
      ]
    : ALL_COL_IDS;

  const today = todayStr();
  const [fromDt,    setFromDt]    = useState(marketOpenDefault(today));
  const [toDt,      setToDt]      = useState(marketCloseDefault(today));
  const [candleTf,  setCandleTf]  = useState("5m");
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEffect(() => {
    if (!colsOpen) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setColsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [colsOpen]);

  const pillStyle = (active: boolean): React.CSSProperties => ({
    fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
    fontSize: 13, fontWeight: 700,
    padding: "5px 13px", borderRadius: 4,
    border: `1px solid ${active ? "#2E75B6" : "#BDC4CF"}`,
    background: active ? "#2E75B6" : "transparent",
    color: active ? "#fff" : "#1A2533",
    cursor: "pointer", transition: "all 0.1s",
    whiteSpace: "nowrap" as const,
  });

  const statusColor =
    feedStatus === "live"          ? "#2E9E4F" :
    feedStatus === "interrupted"   ? "#D97706" :
    feedStatus === "connecting"    ? "#2E75B6" :
    feedStatus === "market-closed" ? "#5B6B7F" :
    feedStatus === "auth-error"    ? "#D97706" :
    feedStatus === "api-error"     ? "#DC2626" :
    feedStatus === "no-network"    ? "#DC2626" : "#8A93A3";

  const statusLabel =
    feedStatus === "live"          ? "Live"            :
    feedStatus === "interrupted"   ? "Interrupted"     :
    feedStatus === "connecting"    ? "Connecting"      :
    feedStatus === "market-closed" ? "Market Closed"   :
    feedStatus === "auth-error"    ? "Auth Required"   :
    feedStatus === "api-error"     ? "API Error"       :
    feedStatus === "no-network"    ? "Connection Lost" : "Idle";

  function handleApplyCustomRange() {
    setRangeError(null);
    if (!fromDt || !toDt) { setRangeError("Please fill in both start and end date/time."); return; }
    const from = new Date(fromDt);
    const to   = new Date(toDt);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) { setRangeError("Invalid date/time."); return; }
    if (from >= to) { setRangeError("Start must be before end."); return; }
    setCustomRange({ from: localToUtcIso(fromDt), to: localToUtcIso(toDt), candleTf });
  }

  function handleClearCustomRange() {
    setCustomRange(null);
    setTimeframe("5m");
  }

  // ── Drag handlers for column reorder ────────────────────────────────────

  function handleDragStart(id: string) {
    dragIdRef.current = id;
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    setDragOver(id);
  }

  function handleDrop(targetId: string) {
    const sourceId = dragIdRef.current;
    if (!sourceId || sourceId === targetId) {
      dragIdRef.current = null;
      setDragOver(null);
      return;
    }
    const newOrder = [...orderedIds];
    const fromIdx  = newOrder.indexOf(sourceId);
    const toIdx    = newOrder.indexOf(targetId);
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, sourceId);
    setColOrder(newOrder);
    dragIdRef.current = null;
    setDragOver(null);
  }

  function handleDragEnd() {
    dragIdRef.current = null;
    setDragOver(null);
  }

  const inputStyle: React.CSSProperties = {
    fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
    fontSize: 13, padding: "4px 8px",
    border: "1px solid #BDC4CF", borderRadius: 4,
    background: "#fff", color: "#1A2533",
    outline: "none",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, color: "#5B6B7F",
    textTransform: "uppercase", letterSpacing: "0.06em",
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ borderBottom: "1px solid #BDC4CF", flexShrink: 0 }}>

      {/* ── Main pill row ─────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "7px 14px",
        background: "#FFFFFF",
        flexWrap: "wrap",
      }}>

        {TFS_MIN.map(tf => (
          <button
            key={tf}
            style={pillStyle(timeframe === tf && timeframe !== "custom")}
            onClick={() => { setTimeframe(tf); setCustomRange(null); }}
          >
            {tf}
          </button>
        ))}

        <div style={{ width: 1, height: 22, background: "#BDC4CF", margin: "0 5px" }} />

        {TFS_HR.map(tf => (
          <button
            key={tf}
            style={pillStyle(timeframe === tf && timeframe !== "custom")}
            onClick={() => { setTimeframe(tf); setCustomRange(null); }}
          >
            {tf}
          </button>
        ))}

        <div style={{ width: 1, height: 22, background: "#BDC4CF", margin: "0 5px" }} />

        {/* Custom timeframe option — hidden per client request; logic kept intact for future use */}
        <button
          style={{ ...pillStyle(timeframe === "custom"), display: "none" }}
          onClick={() => setTimeframe("custom")}
        >
          📅 Custom
        </button>

        <div style={{ flex: 1 }} />

        {/* Feed status indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginRight: 14 }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%", background: statusColor,
            boxShadow: feedStatus === "live" ? `0 0 0 2px ${statusColor}40` : "none",
            display: "inline-block",
          }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: statusColor }}>{statusLabel}</span>
        </div>

        {/* Download Excel button */}
        <button
          onClick={() => exportModule1Excel({ rows, hiddenCols, colOrder, type, instrument, timeframe, pivotMethod, callStrike, putStrike })}
          disabled={rows.length === 0}
          title={rows.length === 0 ? "No data to export yet" : "Download the full table as an Excel file"}
          style={{
            fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
            fontSize: 13, fontWeight: 700,
            padding: "5px 12px", borderRadius: 4,
            border: "1px solid #BDC4CF",
            background: "#fff",
            color: rows.length === 0 ? "#BDC4CF" : "#1A2533",
            cursor: rows.length === 0 ? "not-allowed" : "pointer",
            marginRight: 10,
          }}
        >
          ⬇ Export Table
        </button>

        {/* Columns button + popover */}
        <div style={{ position: "relative" }} ref={popRef}>
          <button
            onClick={() => setColsOpen(o => !o)}
            style={{
              fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
              fontSize: 13, fontWeight: 700,
              padding: "5px 12px", borderRadius: 4,
              border: "1px solid #BDC4CF", background: colsOpen ? "#EBF3FA" : "#fff",
              color: "#1A2533", cursor: "pointer",
            }}
          >
            ⛶ Columns
          </button>

          {colsOpen && (
            <div style={{
              position: "absolute", right: 0, top: "calc(100% + 4px)",
              background: "#fff", border: "1px solid #BDC4CF",
              borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
              zIndex: 100, minWidth: 230, padding: "10px 0",
              maxHeight: 440, overflowY: "auto",
            }}>
              <div style={{
                padding: "5px 14px 9px", fontSize: 10, fontWeight: 700,
                color: "#5B6B7F", textTransform: "uppercase",
                letterSpacing: "0.1em", borderBottom: "1px solid #EBF3FA",
              }}>
                Show / Hide · Drag to Reorder
              </div>
              {(() => {
                let lastGroup = "";
                return orderedIds.map(id => {
                  const groupLabel = COL_GROUP_LABEL[id] ?? "";
                  const showDivider = groupLabel !== lastGroup;
                  if (showDivider) lastGroup = groupLabel;
                  return (
                    <div key={id}>
                      {showDivider && (
                        <div style={{
                          padding: "6px 14px 3px",
                          fontSize: 10, fontWeight: 700,
                          color: "#8A93A3", textTransform: "uppercase",
                          letterSpacing: "0.1em",
                          borderTop: "1px solid #EBF3FA",
                          marginTop: 2,
                        }}>
                          {groupLabel}
                        </div>
                      )}
                      <label
                        draggable
                        onDragStart={() => handleDragStart(id)}
                        onDragOver={e => handleDragOver(e, id)}
                        onDrop={() => handleDrop(id)}
                        onDragEnd={handleDragEnd}
                        style={{
                          display: "flex", alignItems: "center", gap: 9,
                          padding: "6px 14px", cursor: "grab",
                          fontSize: 13, color: "#1A2533",
                          background: dragOver === id
                            ? "#EBF3FA"
                            : hiddenCols.includes(id) ? "#FBF7F0" : "transparent",
                          borderTop: dragOver === id ? "2px solid #2E75B6" : "2px solid transparent",
                          transition: "background 0.1s",
                        }}
                      >
                        <span style={{ fontSize: 11, color: "#BDC4CF", lineHeight: 1, userSelect: "none" }}>⠿</span>
                        <input
                          type="checkbox"
                          checked={!hiddenCols.includes(id)}
                          onChange={() => toggleColumn(id)}
                          onClick={e => e.stopPropagation()}
                          style={{ accentColor: "#2E75B6", width: 15, height: 15 }}
                        />
                        {ALL_COL_LABELS[id] ?? id}
                      </label>
                    </div>
                  );
                });
              })()}
              {colOrder.length > 0 && (
                <button
                  onClick={() => setColOrder([])}
                  style={{
                    display: "block", width: "calc(100% - 28px)", margin: "10px 14px 5px",
                    fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
                    fontSize: 13, fontWeight: 600, padding: "5px 0",
                    border: "1px solid #BDC4CF", borderRadius: 4,
                    background: "#fff", color: "#5B6B7F", cursor: "pointer",
                  }}
                >
                  Reset order
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Custom date range panel ──────────────────────────────────────── */}
      {timeframe === "custom" && (
        <div style={{
          display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12,
          padding: "8px 14px",
          background: "#F3F6FA",
          borderTop: "1px solid #BDC4CF",
        }}>
          <span style={labelStyle}>Interval</span>
          <select value={candleTf} onChange={e => setCandleTf(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
            {CUSTOM_CANDLE_TFS.map(tf => <option key={tf} value={tf}>{tf}</option>)}
          </select>

          <div style={{ width: 1, height: 22, background: "#BDC4CF" }} />

          <span style={labelStyle}>From</span>
          <input type="datetime-local" value={fromDt} onChange={e => setFromDt(e.target.value)} style={inputStyle} />

          <span style={labelStyle}>To</span>
          <input type="datetime-local" value={toDt} onChange={e => setToDt(e.target.value)} style={inputStyle} />

          <button
            onClick={handleApplyCustomRange}
            style={{
              fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
              fontSize: 13, fontWeight: 700,
              padding: "5px 16px", borderRadius: 4,
              border: "1px solid #2E75B6", background: "#2E75B6",
              color: "#fff", cursor: "pointer",
            }}
          >
            Apply
          </button>

          <button
            onClick={handleClearCustomRange}
            style={{
              fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
              fontSize: 13, fontWeight: 700,
              padding: "5px 12px", borderRadius: 4,
              border: "1px solid #BDC4CF", background: "#fff",
              color: "#5B6B7F", cursor: "pointer",
            }}
          >
            ✕ Clear
          </button>

          {customRange && (
            <span style={{ fontSize: 13, color: "#2E75B6", fontWeight: 600 }}>
              {new Date(customRange.from).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" })}
              {" — "}
              {new Date(customRange.to).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" })}
              {" · "}{customRange.candleTf}
            </span>
          )}

          {rangeError && (
            <span style={{ fontSize: 13, color: "#DC2626", fontWeight: 600 }}>{rangeError}</span>
          )}
        </div>
      )}
    </div>
  );
}

export default TimeframeRow;
