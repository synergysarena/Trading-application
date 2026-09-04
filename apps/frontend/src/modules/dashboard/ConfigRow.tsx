import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashStore } from "./store";
import { useStore } from "../../store/useStore";
import { fetchExchanges, fetchInstrumentTypes, fetchSymbols, fetchSymbolExpiries, fetchStrikes } from "../../data/liveApi";
import { formatExpiryDisplay } from "../../data/models";
import { api } from "../../utils/api";

// ── Live price hook ───────────────────────────────────────────────────────────

function useLivePrice(symbol: string): { ltp: number | null; dir: "up" | "down" | null } {
  const ltp = useStore((s) => s.prices[symbol]?.ltp ?? null);
  const updatePrice = useStore((s) => s.updatePrice);
  const prevRef = useRef<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  // Initial fetch for Spot / Future price if not yet cached in store
  useEffect(() => {
    if (ltp !== null) return;
    let cancelled = false;
    const fetchInitial = async () => {
      try {
        const res = await api.get(`/api/market/spot/${symbol}`);
        if (!cancelled && typeof res?.ltp === "number" && res.ltp > 0) {
          updatePrice(symbol, res.ltp);
        }
      } catch {
        if (symbol.includes("FUT")) {
          try {
            const futRes = await api.get(`/api/market/futures/${symbol}`);
            if (!cancelled && typeof futRes?.ltp === "number" && futRes.ltp > 0) {
              updatePrice(symbol, futRes.ltp);
            }
          } catch {}
        }
      }
    };
    fetchInitial();
    return () => { cancelled = true; };
  }, [symbol, ltp, updatePrice]);

  useEffect(() => {
    if (ltp === null) return;
    if (prevRef.current !== null) {
      if (ltp > prevRef.current) setDir("up");
      else if (ltp < prevRef.current) setDir("down");
    }
    prevRef.current = ltp;
  }, [ltp]);

  return { ltp, dir };
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const SEL: React.CSSProperties = {
  fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
  fontSize: 14,
  fontWeight: 600,
  color: "#1A2533",
  background: "#F3F6FA",
  border: "1px solid #BDC4CF",
  borderRadius: 4,
  padding: "6px 28px 6px 10px",
  height: 34,
  appearance: "none",
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235B6B7F'/%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 8px center",
  cursor: "pointer",
  minWidth: 132,
};

const LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: "#5B6B7F",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  marginBottom: 3,
};

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={LABEL}>{label}</span>
      {children}
    </div>
  );
}

/** Dependent dropdown: disabled until its parent is selected, shows loading and
 *  empty states, and never renders broker symbols/tokens — display labels only. */
function DepSelect({
  value, onChange, disabled, loading, options, placeholder = "Select…",
  minWidth,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  loading: boolean;
  options: { value: string; label: string }[];
  placeholder?: string;
  minWidth?: number;
}) {
  const empty = !loading && !disabled && options.length === 0;
  return (
    <select
      style={{ ...SEL, ...(minWidth ? { minWidth } : {}), opacity: disabled ? 0.5 : 1 }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || loading || empty}
    >
      <option value="">
        {loading ? "Loading…" : disabled ? "—" : empty ? "No data" : placeholder}
      </option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function DirArrow({ dir }: { dir: "up" | "down" | null }) {
  if (dir === "up")   return <span style={{ color: "#16a34a", fontSize: 12, lineHeight: 1 }}>▲</span>;
  if (dir === "down") return <span style={{ color: "#dc2626", fontSize: 12, lineHeight: 1 }}>▼</span>;
  return null;
}

function LivePrice({ label, value, dir }: { label: string; value: number | null; dir: "up" | "down" | null }) {
  const formatted = value != null ? Math.trunc(value).toLocaleString("en-IN") : "—";

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={LABEL}>{label}</span>
      <div style={{
        display: "flex", alignItems: "center", gap: 4, height: 34,
        padding: "0 10px",
        background: "#EEF4FB",
        border: "1px solid #BDC4CF",
        borderRadius: 4,
        minWidth: 100,
      }}>
        <span style={{
          fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
          fontSize: 14, fontWeight: 700, color: "#1A2533", letterSpacing: "0.01em",
        }}>
          {formatted}
        </span>
        <DirArrow dir={dir} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ConfigRow() {
  const {
    exchange, instrumentType, instrument, type, callStrike, putStrike,
    expiryDate,
    isGenerated,
    setExchange, setInstrumentType, setInstrument, setType,
    setCallStrike, setPutStrike,
    setExpiryDate,
    generate, reset,
    configCollapsed, toggleConfigCollapsed,
  } = useDashStore();

  const { ltp: spotLtp,   dir: spotDir }   = useLivePrice("NIFTY-SPOT");
  const { ltp: futureLtp, dir: futureDir } = useLivePrice("NIFTY-FUT");

  // ── Dependent data (Exchange → Instrument type → Symbol → Expiry → Strike) ───
  // Every level below is fetched live from the broker's instrument master via
  // ../../data/liveApi.ts — nothing is a static/hardcoded catalog, and each
  // query is filtered by every level selected above it.

  const { data: exchanges = [], isLoading: loadExch } = useQuery({
    queryKey: ["exchanges"],
    queryFn: fetchExchanges,
    staleTime: Infinity,
  });

  const { data: instrumentTypes = [], isLoading: loadInst } = useQuery({
    queryKey: ["instrumentTypes", exchange],
    queryFn: () => fetchInstrumentTypes(exchange),
    enabled: !!exchange,
    staleTime: Infinity,
  });

  const { data: symbols = [], isLoading: loadSym } = useQuery({
    queryKey: ["symbols", exchange, instrumentType],
    queryFn: () => fetchSymbols(exchange, instrumentType),
    enabled: !!exchange && !!instrumentType,
    staleTime: Infinity,
  });

  const { data: expiries = [], isLoading: loadExp } = useQuery({
    queryKey: ["expiries", exchange, instrumentType, instrument],
    queryFn: () => fetchSymbolExpiries(exchange, instrumentType, instrument),
    enabled: !!exchange && !!instrumentType && !!instrument,
    staleTime: Infinity,
  });

  // Whether this symbol has an options/futures chain at all — derived from the
  // live data itself (empty for cash instruments like NSE EQ/INDEX), not a
  // hardcoded instrument-type set.
  const expiryApplies = expiries.length > 0;

  const { data: strikes = [], isLoading: loadSt } = useQuery({
    queryKey: ["strikes", exchange, instrumentType, instrument, expiryDate],
    queryFn: () => fetchStrikes(exchange, instrumentType, instrument, expiryDate),
    enabled: !!exchange && !!instrumentType && !!instrument && !!expiryDate,
    staleTime: Infinity,
  });

  // ── Defaults + preserve-valid-selection guards ────────────────────────────
  // When a parent changes, a still-valid child selection is kept; an invalid
  // one is cleared (which cascades through the store resets).

  // Exchange is the root selector — auto-select the first one the broker
  // reports whenever the current selection is missing/invalid.
  useEffect(() => {
    if (loadExch || exchanges.length === 0) return;
    if (!exchange || !exchanges.includes(exchange)) {
      setExchange(exchanges[0]);
    }
  }, [exchange, exchanges, loadExch, setExchange]);

  // Instrument type auto-selects the first one the broker reports for the
  // selected Exchange, same pattern as Exchange above.
  useEffect(() => {
    if (loadInst || instrumentTypes.length === 0) return;
    if (!instrumentType || !instrumentTypes.includes(instrumentType)) {
      setInstrumentType(instrumentTypes[0]);
    }
  }, [instrumentType, instrumentTypes, loadInst, setInstrumentType]);

  // Symbol is left to manual selection (no auto-pick) — just cleared if it's
  // no longer valid for the current Exchange/Instrument.
  useEffect(() => {
    if (loadSym) return;
    if (instrument && !symbols.includes(instrument)) {
      setInstrument("");
    }
  }, [instrument, symbols, loadSym, setInstrument]);

  // Nearest expiry is auto-selected whenever the current one is missing/invalid.
  useEffect(() => {
    if (loadExp || expiries.length === 0) return;
    if (!expiryDate || !expiries.some((e) => e.id === expiryDate)) {
      setExpiryDate(expiries[0].id);
    }
  }, [expiries, loadExp, expiryDate, setExpiryDate]);

  useEffect(() => {
    if (!loadExp && !expiryApplies && expiryDate) setExpiryDate("");
  }, [loadExp, expiryApplies, expiryDate, setExpiryDate]);

  useEffect(() => {
    if (loadSt || !expiryDate) return;
    if (callStrike !== null && !strikes.some((s) => s.value === callStrike)) setCallStrike(null);
    if (putStrike  !== null && !strikes.some((s) => s.value === putStrike))  setPutStrike(null);
  }, [strikes, loadSt, expiryDate, callStrike, putStrike, setCallStrike, setPutStrike]);

  const includesCall = type === "Call" || type === "Call+Put";
  const includesPut  = type === "Put"  || type === "Call+Put";

  const canGenerate =
    !!exchange && !!instrumentType && !!instrument && (!expiryApplies || !!expiryDate) &&
    (!includesCall || callStrike !== null) &&
    (!includesPut  || putStrike  !== null);

  // ── Auto-generate on data readiness ───────────────────────────────────────

  const marketDataReady   = useStore((s) => s.marketDataReady);
  const autoGeneratedRef  = useRef(false);

  useEffect(() => {
    if (!canGenerate) {
      autoGeneratedRef.current = false;
    }
  }, [canGenerate]);

  useEffect(() => {
    if (canGenerate && marketDataReady && !isGenerated && !autoGeneratedRef.current) {
      autoGeneratedRef.current = true;
      console.log(
        "[Module1/AutoGenerate] ✓ All readiness conditions met" +
        ` — canGenerate=${canGenerate} marketDataReady=${marketDataReady}` +
        " → triggering generate()"
      );
      generate();
    }
  }, [canGenerate, marketDataReady, isGenerated, generate]);

  // ── Collapsed state ───────────────────────────────────────────────────────

  if (configCollapsed) {
    const p2 = (n: number | null) =>
      n != null ? Math.trunc(n).toLocaleString("en-IN") : "—";

    const summary = [
      exchange,
      instrumentType,
      instrument,
      expiryApplies && expiryDate ? formatExpiryDisplay(expiryDate) : null,
    ].filter(Boolean).join(" › ");

    return (
      <div
        style={{
          display: "flex", alignItems: "center", gap: 12,
          height: 34, padding: "0 14px",
          background: "#F3F6FA", borderBottom: "1px solid #BDC4CF",
          cursor: "pointer", flexShrink: 0,
        }}
        onClick={toggleConfigCollapsed}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: "#2E75B6" }}>
          SPOT {p2(spotLtp)}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#1A2533" }}>
          FUT {p2(futureLtp)}
        </span>
        <span style={{ color: "#BDC4CF" }}>|</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#5B6B7F" }}>
          {summary}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#5B6B7F" }}>▼ Expand config</span>
      </div>
    );
  }

  // ── Expanded state ────────────────────────────────────────────────────────

  const strikeOptions = strikes.map((s) => ({ value: String(s.value), label: String(s.value) }));

  return (
    <div style={{
      display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap",
      padding: "10px 16px",
      background: "#F3F6FA", borderBottom: "1px solid #BDC4CF",
      flexShrink: 0,
    }}>

      {/* ── Live prices ──────────────────────────────────────────────────── */}
      <LivePrice label="Spot"   value={spotLtp}   dir={spotDir} />
      <LivePrice label="Future" value={futureLtp} dir={futureDir} />

      <div style={{ width: 1, height: 44, background: "#BDC4CF", alignSelf: "center", margin: "0 2px" }} />

      {/* Exchange — sourced live from the broker's instrument master
          (fetchExchanges), never hardcoded. First selector in the chain. */}
      <Field label="Exchange">
        <DepSelect
          value={exchange}
          onChange={setExchange}
          disabled={false}
          loading={loadExch}
          options={exchanges.map((e) => ({ value: e, label: e }))}
          minWidth={100}
        />
      </Field>

      {/* Instrument (type) — sourced live from the broker's instrument master
          (fetchInstrumentTypes), filtered by the selected Exchange. */}
      <Field label="Instrument">
        <DepSelect
          value={instrumentType}
          onChange={setInstrumentType}
          disabled={!exchange}
          loading={loadInst}
          options={instrumentTypes.map((t) => ({ value: t, label: t }))}
          minWidth={144}
        />
      </Field>

      {/* Symbol (underlying) — sourced live (fetchSymbols), filtered by the
          selected Exchange + Instrument. */}
      <Field label="Symbol">
        <DepSelect
          value={instrument}
          onChange={setInstrument}
          disabled={!instrumentType}
          loading={loadSym}
          options={symbols.map((s) => ({ value: s, label: s }))}
        />
      </Field>

      {/* Expiry Date — internal value is ISO "YYYY-MM-DD"; display "DD Mon YYYY".
          Hidden for symbols with no options/futures chain (e.g. cash EQ/INDEX) —
          derived from whether the broker actually returned any expiries, not a
          hardcoded instrument-type set. */}
      {(loadExp || expiryApplies) && (
        <Field label="Expiry Date">
          <DepSelect
            value={expiryDate}
            onChange={setExpiryDate}
            disabled={!instrument}
            loading={loadExp}
            options={expiries.map((e) => ({ value: e.id, label: e.expiry }))}
            minWidth={122}
          />
        </Field>
      )}

      {/* Option Type — hidden from UI per client request; app always uses the
          default Call+Put behind the scenes, component/logic kept intact. */}
      <div style={{ display: "none" }}>
        <Field label="Type">
          <div style={{
            display: "flex", height: 34,
            border: "1px solid #BDC4CF", borderRadius: 4, overflow: "hidden",
          }}>
            {(["Call+Put", "Call", "Put"] as const).map((opt, i) => (
              <button
                key={opt}
                onClick={() => setType(opt)}
                style={{
                  fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
                  fontSize: 13, fontWeight: 700,
                  padding: "0 14px",
                  border: "none",
                  borderLeft: i > 0 ? "1px solid #BDC4CF" : "none",
                  background: type === opt ? "#2E75B6" : "#F3F6FA",
                  color: type === opt ? "#fff" : "#5B6B7F",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  lineHeight: "34px",
                }}
              >
                {opt === "Call+Put" ? "Call + Put" : opt}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {/* Call strike */}
      {includesCall && (
        <Field label="Call Strike">
          <DepSelect
            value={callStrike !== null ? String(callStrike) : ""}
            onChange={(v) => setCallStrike(v ? +v : null)}
            disabled={!expiryDate}
            loading={loadSt}
            options={strikeOptions}
            minWidth={100}
          />
        </Field>
      )}

      {/* Put strike */}
      {includesPut && (
        <Field label="Put Strike">
          <DepSelect
            value={putStrike !== null ? String(putStrike) : ""}
            onChange={(v) => setPutStrike(v ? +v : null)}
            disabled={!expiryDate}
            loading={loadSt}
            options={strikeOptions}
            minWidth={100}
          />
        </Field>
      )}

      <div style={{ flex: 1 }} />

      {/* Reset + Generate + Collapse — hidden per client request; logic kept intact for future use */}
      <div style={{ display: "none", alignItems: "flex-end", gap: 10 }}>
        {isGenerated && (
          <button
            onClick={reset}
            style={{
              fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
              fontSize: 14, fontWeight: 700,
              padding: "7px 18px", borderRadius: 4,
              border: "1px solid #BDC4CF", background: "#fff",
              color: "#5B6B7F", cursor: "pointer", height: 34,
            }}
          >
            Reset
          </button>
        )}
        <button
          onClick={generate}
          disabled={!canGenerate}
          style={{
            fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
            fontSize: 14, fontWeight: 700,
            padding: "7px 24px", borderRadius: 4,
            border: "none",
            background: canGenerate ? "#2E9E4F" : "#9ca3af",
            color: "#fff", cursor: canGenerate ? "pointer" : "not-allowed",
            height: 34,
          }}
        >
          ▶ Generate
        </button>

        <button
          onClick={toggleConfigCollapsed}
          title="Collapse config"
          style={{
            border: "1px solid #BDC4CF", background: "#fff", borderRadius: 4,
            width: 34, height: 34, cursor: "pointer",
            fontSize: 12, color: "#5B6B7F",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          ▲
        </button>
      </div>
    </div>
  );
}

export default ConfigRow;
