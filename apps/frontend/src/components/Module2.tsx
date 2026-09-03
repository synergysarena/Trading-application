import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "../store/useStore";
import { generateTimelineColumns } from "@stock/shared";
import { api } from "../utils/api";
import { exportModule2ToExcel } from "../utils/excelModule2Export";
import { colorClassStyle } from "../modules/dashboard/cellColorRules";

const formatExpiryLabel = (dateStr: string): string => {
  try {
    const d = new Date(dateStr + "T00:00:00");
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    return `${String(d.getDate()).padStart(2,"0")}-${months[d.getMonth()]}-${d.getFullYear()}`;
  } catch {
    return dateStr;
  }
};

// ── ALL ORIGINAL LOGIC — UNTOUCHED ───────────────────────────────────────────

const parseStrikeSymbol = (symbol: string) => {
  const match = symbol.match(/(\d+)(CE|PE)$/);
  if (match) return { strikePrice: match[1], optionType: match[2] };
  return { strikePrice: symbol, optionType: "" };
};

const ensureFullStrikesData = (session: any) => {
  if (!session) return session;
  const nextSession = JSON.parse(JSON.stringify(session));
  if (!nextSession.strikes) nextSession.strikes = {};
  let currentSelected = [...nextSession.selectedStrikes];
  const maxAllowed = nextSession.sessionType === "mixed" ? 20 : 10;
  if (currentSelected.length > maxAllowed) currentSelected = currentSelected.slice(0, maxAllowed);
  nextSession.selectedStrikes = currentSelected;
  currentSelected.forEach((strike: string) => {
    if (!nextSession.strikes[strike]) {
      nextSession.strikes[strike] = { strike, dayOpen: 0, dayHigh: 0, dayLow: 0, grid: [], trendBadge: "FLAT", isDowntrendActive: false, isDeepLoss: false, pctChange: 0 };
    }
  });
  return nextSession;
};

// ── Design tokens ─────────────────────────────────────────────────────────────
const GREEN = "#047857";
const RED = "#E53935";
const AMBER = "#D97706";

// ── Shared sub-components ─────────────────────────────────────────────────────

function TrendBadge({ badge }: { badge: string }) {
  const cfg: Record<string, { label: string; color: string; bg: string; border: string; pulse?: boolean }> = {
    L_TO_H:   { label: "L→H ▲", color: GREEN, bg: "rgba(4,120,87,0.1)",   border: "rgba(4,120,87,0.25)" },
    H_TO_L:   { label: "H→L ▼", color: RED,   bg: "rgba(229,57,53,0.1)",  border: "rgba(229,57,53,0.25)", pulse: true },
    REVERSAL: { label: "REV ⚡", color: AMBER, bg: "rgba(217,119,6,0.1)",  border: "rgba(217,119,6,0.25)", pulse: true },
    FLAT:     { label: "FLAT",   color: "#64748b", bg: "rgba(100,116,139,0.08)", border: "rgba(100,116,139,0.2)" },
  };
  const c = cfg[badge] || cfg.FLAT;
  return (
    <span
      className={c.pulse ? "animate-pulse" : ""}
      style={{
        display: "inline-flex", alignItems: "center",
        padding: "2px 8px", borderRadius: 6,
        fontSize: 10, fontFamily: "'Inter', sans-serif",
        fontWeight: 700, letterSpacing: "0.03em",
        color: c.color, background: c.bg, border: `1px solid ${c.border}`,
      }}
    >
      {c.label}
    </span>
  );
}

function SelectField({ label, value, onChange, options, disabled = false }: {
  label: string; value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 170, flex: 1 }}>
      <label style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 600, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {label}
      </label>
      <div style={{ position: "relative" }}>
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%", padding: "8px 32px 8px 12px",
            fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
            color: "var(--trading-text-active)", background: "var(--trading-bg)",
            border: "1.5px solid var(--trading-border)", borderRadius: 8,
            outline: "none", cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1, appearance: "none", WebkitAppearance: "none",
            height: 38,
          }}
        >
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: GREEN, pointerEvents: "none", fontSize: 11 }}>▾</span>
      </div>
    </div>
  );
}

function MultiSelectStrikeDropdown({
  label,
  type,
  options,
  selectedStrikes,
  onToggleStrike,
  onClear,
  disabled,
  loading,
  maxLimit = 10,
  placeholder = "Select…",
}: {
  label: string;
  type: "CE" | "PE";
  options: { strikePrice: number; symbol: string }[];
  selectedStrikes: string[];
  onToggleStrike: (symbol: string, strikePrice: number) => void;
  onClear?: () => void;
  disabled?: boolean;
  loading?: boolean;
  maxLimit?: number;
  placeholder?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const selectedForType = options.filter((o) => selectedStrikes.includes(o.symbol));
  const selectedCount = selectedForType.length;

  let displaySummary = placeholder;
  if (loading) {
    displaySummary = "Loading…";
  } else if (disabled) {
    displaySummary = "—";
  } else if (options.length === 0) {
    displaySummary = "No strikes";
  } else if (selectedCount === 1) {
    displaySummary = `${selectedForType[0].strikePrice}`;
  } else if (selectedCount === 2) {
    displaySummary = `${selectedForType[0].strikePrice}, ${selectedForType[1].strikePrice}`;
  } else if (selectedCount > 2) {
    displaySummary = `${selectedForType[0].strikePrice}, ${selectedForType[1].strikePrice} (+${selectedCount - 2})`;
  }

  const filteredOptions = searchTerm
    ? options.filter((o) => String(o.strikePrice).includes(searchTerm))
    : options;

  const colorTheme = type === "CE" ? GREEN : RED;

  return (
    <div ref={containerRef} style={{ display: "flex", flexDirection: "column", gap: 6, position: "relative", minWidth: 170, flex: 1, zIndex: isOpen ? 50 : "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 600, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {label}
        </label>
        {selectedCount > 0 && (
          <span style={{ fontSize: 10, fontWeight: 700, color: selectedCount >= maxLimit ? RED : colorTheme }}>
            {selectedCount}/{maxLimit}
          </span>
        )}
      </div>

      <div
        onClick={() => {
          if (!disabled && !loading && options.length > 0) setIsOpen((prev) => !prev);
        }}
        style={{
          width: "100%",
          padding: "8px 12px",
          fontFamily: "'Inter', sans-serif",
          fontSize: 13,
          fontWeight: selectedCount > 0 ? 700 : 500,
          color: selectedCount > 0 ? "var(--trading-text-active)" : "var(--trading-text-muted)",
          background: selectedCount > 0 ? (type === "CE" ? "rgba(4,120,87,0.04)" : "rgba(229,57,53,0.04)") : "var(--trading-bg)",
          border: `1.5px solid ${isOpen ? colorTheme : "var(--trading-border)"}`,
          borderRadius: 8,
          boxShadow: isOpen ? `0 0 0 2px ${colorTheme}20` : "none",
          cursor: disabled || loading || options.length === 0 ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          userSelect: "none",
          transition: "all 0.15s",
          boxSizing: "border-box",
          height: 38,
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            paddingRight: 8,
          }}
          title={selectedForType.map((o) => o.strikePrice).join(", ")}
        >
          {displaySummary}
        </span>
        <span style={{ color: colorTheme, fontSize: 11, transition: "transform 0.2s", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
          ▾
        </span>
      </div>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 1000,
            background: "var(--trading-surface)",
            border: "1.5px solid var(--trading-border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
            padding: "8px",
            minWidth: 200,
            maxHeight: 300,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Search & Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <input
              type="text"
              placeholder="Search strike…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              style={{
                flex: 1,
                padding: "6px 8px",
                fontSize: 12,
                fontFamily: "'Inter', sans-serif",
                background: "var(--trading-bg)",
                border: "1px solid var(--trading-border)",
                borderRadius: 5,
                outline: "none",
                color: "var(--trading-text-active)",
              }}
            />
            {selectedCount > 0 && onClear && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--trading-text-muted)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: "2px 4px",
                  textDecoration: "underline",
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Strikes List */}
          <div style={{ overflowY: "auto", maxHeight: 220, display: "flex", flexDirection: "column", gap: 2 }}>
            {filteredOptions.length === 0 ? (
              <div style={{ padding: "8px", textAlign: "center", fontSize: 12, color: "var(--trading-text-muted)" }}>
                No matching strikes
              </div>
            ) : (
              filteredOptions.map((opt) => {
                const isSelected = selectedStrikes.includes(opt.symbol);
                const isMaxReached = !isSelected && selectedCount >= maxLimit;

                return (
                  <label
                    key={opt.symbol}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: 5,
                      cursor: isMaxReached ? "not-allowed" : "pointer",
                      background: isSelected ? (type === "CE" ? "rgba(4,120,87,0.08)" : "rgba(229,57,53,0.08)") : "transparent",
                      opacity: isMaxReached ? 0.45 : 1,
                      userSelect: "none",
                      transition: "background 0.1s",
                    }}
                    onMouseOver={(e) => {
                      if (!isSelected && !isMaxReached) {
                        e.currentTarget.style.background = "var(--trading-bg)";
                      }
                    }}
                    onMouseOut={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.background = "transparent";
                      }
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={isMaxReached}
                      onChange={() => onToggleStrike(opt.symbol, opt.strikePrice)}
                      style={{
                        accentColor: colorTheme,
                        cursor: isMaxReached ? "not-allowed" : "pointer",
                        width: 15,
                        height: 15,
                      }}
                    />
                    <span style={{ fontSize: 13, fontWeight: isSelected ? 700 : 500, color: "var(--trading-text-active)", flex: 1 }}>
                      {opt.strikePrice}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "1px 5px",
                        borderRadius: 3,
                        background: type === "CE" ? "rgba(4,120,87,0.12)" : "rgba(229,57,53,0.12)",
                        color: colorTheme,
                      }}
                    >
                      {type}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export const Module2 = ({ isSplit = false }: { isSplit?: boolean }) => {
  const queryClient = useQueryClient();
  const activeSession = useStore((s) => s.activeSession);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const module2BrokerStatus = useStore((s) => s.module2BrokerStatus);
  const [isConfigExpanded, setIsConfigExpanded] = useState(!isSplit);

  const [indexSymbol, setIndexSymbol] = useState("NIFTY50");
  const [expiryDate, setExpiryDate] = useState("");
  const [selectedStrikes, setSelectedStrikes] = useState<string[]>([]);
  const [strikeWarning, setStrikeWarning] = useState<string | null>(null);

  const fullscreenTablesRef = useRef<HTMLDivElement>(null);
  const [isTablesFullscreen, setIsTablesFullscreen] = useState(false);

  const toggleTablesFullscreen = useCallback(() => {
    if (isTablesFullscreen) {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => { /* ignore */ });
      }
      setIsTablesFullscreen(false);
      return;
    }
    const el = fullscreenTablesRef.current;
    if (el?.requestFullscreen) {
      el.requestFullscreen()
        .then(() => setIsTablesFullscreen(true))
        .catch(() => setIsTablesFullscreen(true));
    } else {
      setIsTablesFullscreen(true);
    }
  }, [isTablesFullscreen]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setIsTablesFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // OHLC Field Selection state (Default: all 4 fields)
  const [selectedOHLCFields, setSelectedOHLCFields] = useState<string[]>(["open", "high", "low", "close"]);

  // 1. Index Symbol Query (API-driven)
  const { data: indexesData, isLoading: isIndexesLoading, isError: isIndexesError, refetch: refetchIndexes } = useQuery({
    queryKey: ["module2-indexes"],
    queryFn: async () => {
      console.log("[MODULE2][CONFIG] Loading indexes");
      const res = await api.get("/api/module2/indexes");
      console.log("[MODULE2][CONFIG] Indexes received:", res?.indexes?.length || 0);
      return res;
    },
    staleTime: 60 * 60 * 1000,
  });

  const indexOptions: { value: string; label: string }[] = isIndexesLoading
    ? [{ value: "", label: "Loading indexes…" }]
    : isIndexesError
    ? [{ value: "", label: "Error loading indexes" }]
    : (indexesData?.indexes || []).map((idx: { symbol: string; label: string }) => ({
        value: idx.symbol,
        label: idx.label,
      }));

  // Auto-set default index if current indexSymbol is invalid
  useEffect(() => {
    const available = indexesData?.indexes || [];
    if (available.length > 0) {
      if (!available.some((idx: any) => idx.symbol === indexSymbol)) {
        setIndexSymbol(available[0].symbol);
      }
    }
  }, [indexesData, indexSymbol]);

  // 2. Options Expiry Query (API-driven)
  const { data: expiriesData, isLoading: isExpiriesLoading, isError: isExpiriesError, refetch: refetchExpiries, isFetching: isExpiriesFetching } = useQuery({
    queryKey: ["module2-expiries", indexSymbol],
    queryFn: async () => {
      console.log(`[MODULE2][CONFIG] Loading expiries for ${indexSymbol}`);
      const res = await api.get(`/api/module2/expiries?symbol=${indexSymbol}`);
      console.log("[MODULE2][CONFIG] Expiries received:", res?.expiries?.length || 0);
      return res;
    },
    enabled: !!indexSymbol,
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  const expiryOptions: { value: string; label: string }[] = isExpiriesLoading
    ? [{ value: "", label: "Loading expiries…" }]
    : isExpiriesError
    ? [{ value: "", label: "Error loading expiries" }]
    : (expiriesData?.expiries || []).length === 0
    ? [{ value: "", label: "No expiries available" }]
    : (expiriesData?.expiries || []).map((date: string) => ({
        value: date,
        label: formatExpiryLabel(date),
      }));

  // When Index changes, reset expiry and selected strikes
  useEffect(() => {
    setExpiryDate("");
    setSelectedStrikes([]);
    setStrikeWarning(null);
  }, [indexSymbol]);

  // Auto-select first API-provided expiry when expiries list updates
  useEffect(() => {
    const expiries: string[] = expiriesData?.expiries || [];
    if (expiries.length > 0) {
      if (!expiryDate || !expiries.includes(expiryDate)) {
        setExpiryDate(expiries[0]);
      }
    } else {
      setExpiryDate("");
    }
  }, [expiriesData]);

  // When Expiry changes, clear previously selected strikes
  useEffect(() => {
    setSelectedStrikes([]);
    setStrikeWarning(null);
  }, [expiryDate]);

  // 3. Option Chain / Strikes Query (API-driven)
  const { data: chainData, isLoading: isStrikesLoading, isFetching: isChainFetching } = useQuery({
    queryKey: ["module2-option-chain", indexSymbol, expiryDate],
    queryFn: async () => {
      console.log(`[MODULE2][CONFIG] Loading option contracts for ${indexSymbol} @ ${expiryDate}`);
      const res = await api.get(`/api/module2/option-chain?symbol=${indexSymbol}&expiry=${expiryDate}`);
      
      const strikes = res?.strikes || [];
      let ceCount = 0;
      let peCount = 0;
      strikes.forEach((s: any) => {
        if (s.CE) ceCount++;
        if (s.PE) peCount++;
      });

      console.log(`[MODULE2][CONFIG] Contracts received: ${strikes.length}`);
      console.log(`[MODULE2][CONFIG] Available strikes: ${strikes.length}`);
      console.log(`[MODULE2][CONFIG] CE contracts: ${ceCount}`);
      console.log(`[MODULE2][CONFIG] PE contracts: ${peCount}`);

      return res;
    },
    enabled: !!indexSymbol && !!expiryDate,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  // Preserve valid selected strikes when chainData is refreshed
  useEffect(() => {
    if (chainData?.strikes && chainData.strikes.length > 0 && selectedStrikes.length > 0) {
      const availableSymbols = new Set<string>();
      chainData.strikes.forEach((s: any) => {
        if (s.CE) availableSymbols.add(s.CE);
        if (s.PE) availableSymbols.add(s.PE);
      });
      setSelectedStrikes((prev) => {
        const filtered = prev.filter((s) => availableSymbols.has(s));
        return filtered.length === prev.length ? prev : filtered;
      });
    }
  }, [chainData]);

  // Module 2 Configuration Refresh Handler
  const [isRefreshingConfig, setIsRefreshingConfig] = useState(false);
  const handleRefreshConfig = async () => {
    if (isRefreshingConfig) return;
    setIsRefreshingConfig(true);
    setStrikeWarning(null);
    try {
      console.log(`[MODULE2][REFRESH] symbol=${indexSymbol} expiry=${expiryDate}`);

      // 1. Invalidate indexes and fetch latest
      await queryClient.invalidateQueries({ queryKey: ["module2-indexes"] });
      await refetchIndexes();

      // 2. Invalidate expiries and fetch latest
      await queryClient.invalidateQueries({ queryKey: ["module2-expiries", indexSymbol] });
      const expiriesResult: any = await refetchExpiries();
      const expiries: string[] = expiriesResult?.data?.expiries || expiriesData?.expiries || [];

      // 3. Determine active target expiry: preserve current if still present, otherwise first available
      let targetExpiry = expiryDate;
      if (!targetExpiry || !expiries.includes(targetExpiry)) {
        targetExpiry = expiries.length > 0 ? expiries[0] : "";
        if (targetExpiry !== expiryDate) {
          setExpiryDate(targetExpiry);
        }
      }

      // 4. Force fresh option-chain fetch for the target expiry with staleTime: 0
      if (targetExpiry) {
        console.log(`[MODULE2][REFRESH] Loading option chain for ${indexSymbol} @ ${targetExpiry}`);
        await queryClient.invalidateQueries({ queryKey: ["module2-option-chain", indexSymbol, targetExpiry] });
        const chainRes: any = await queryClient.fetchQuery({
          queryKey: ["module2-option-chain", indexSymbol, targetExpiry],
          queryFn: async () => {
            console.log(`[MODULE2][CONFIG] Loading option contracts for ${indexSymbol} @ ${targetExpiry}`);
            const res = await api.get(`/api/module2/option-chain?symbol=${indexSymbol}&expiry=${targetExpiry}`);
            return res;
          },
          staleTime: 0,
        });

        const strikes = chainRes?.strikes || [];
        let ceCount = 0;
        let peCount = 0;
        strikes.forEach((s: any) => {
          if (s.CE) ceCount++;
          if (s.PE) peCount++;
        });

        console.log(`[MODULE2][REFRESH][CHAIN] contracts=${strikes.length} CE=${ceCount} PE=${peCount}`);
        console.log(`[MODULE2][REFRESH][STRIKES] CE=${ceCount} PE=${peCount}`);
      }

      console.log("[MODULE2][CONFIG] Manual configuration refresh complete");
    } catch (err: any) {
      console.error("[MODULE2][CONFIG] Manual configuration refresh failed:", err);
      setStrikeWarning("Failed to refresh configuration: " + (err?.message || "Unknown error"));
    } finally {
      setIsRefreshingConfig(false);
    }
  };

  const availableStrikesList: any[] = chainData?.strikes || [];

  const ceOptions = availableStrikesList
    .filter((s: any) => !!s.CE)
    .map((s: any) => ({ strikePrice: s.strikePrice, symbol: s.CE }));

  const peOptions = availableStrikesList
    .filter((s: any) => !!s.PE)
    .map((s: any) => ({ strikePrice: s.strikePrice, symbol: s.PE }));

  const ceCount = selectedStrikes.filter((s) => s.toUpperCase().endsWith("CE")).length;
  const peCount = selectedStrikes.filter((s) => s.toUpperCase().endsWith("PE")).length;

  const handleToggleCE = (symbol: string) => {
    setStrikeWarning(null);
    if (selectedStrikes.includes(symbol)) {
      setSelectedStrikes((prev) => prev.filter((s) => s !== symbol));
    } else {
      if (ceCount >= 10) {
        setStrikeWarning("Cannot select more than 10 Call (CE) strikes.");
        return;
      }
      if (selectedStrikes.length >= 20) {
        setStrikeWarning("Cannot select more than 20 total option contracts.");
        return;
      }
      setSelectedStrikes((prev) => [...prev, symbol]);
    }
  };

  const handleTogglePE = (symbol: string) => {
    setStrikeWarning(null);
    if (selectedStrikes.includes(symbol)) {
      setSelectedStrikes((prev) => prev.filter((s) => s !== symbol));
    } else {
      if (peCount >= 10) {
        setStrikeWarning("Cannot select more than 10 Put (PE) strikes.");
        return;
      }
      if (selectedStrikes.length >= 20) {
        setStrikeWarning("Cannot select more than 20 total option contracts.");
        return;
      }
      setSelectedStrikes((prev) => [...prev, symbol]);
    }
  };

  const toggleOHLCField = (fieldId: string) => {
    setSelectedOHLCFields((prev) => {
      if (prev.includes(fieldId)) {
        if (prev.length === 1) {
          setStrikeWarning("At least one OHLC field must be selected.");
          return prev;
        }
        setStrikeWarning(null);
        return prev.filter((f) => f !== fieldId);
      } else {
        setStrikeWarning(null);
        const canonicalOrder = ["open", "high", "low", "close"];
        const next = [...prev, fieldId];
        return canonicalOrder.filter((f) => next.includes(f));
      }
    });
  };

  // Session Start Mutation with strict contract validation
  const startSessionMutation = useMutation({
    mutationFn: async () => {
      console.log("[MODULE2][TRACKER] Start button clicked");
      console.log("[MODULE2][TRACKER] selected index:", indexSymbol);
      console.log("[MODULE2][TRACKER] expiry:", expiryDate);
      console.log("[MODULE2][TRACKER] selected strikes:", selectedStrikes);
      console.log("[MODULE2][TRACKER] selected OHLC fields:", selectedOHLCFields);

      if (selectedStrikes.length === 0) {
        const msg = "Validation Error: Please select at least one Call or Put strike.";
        setStrikeWarning(msg);
        throw new Error(msg);
      }

      if (selectedOHLCFields.length === 0) {
        const msg = "Validation Error: At least one OHLC field must be selected.";
        setStrikeWarning(msg);
        throw new Error(msg);
      }

      const activeCeCount = selectedStrikes.filter((st) => st.toUpperCase().endsWith("CE")).length;
      const activePeCount = selectedStrikes.filter((st) => st.toUpperCase().endsWith("PE")).length;

      if (selectedStrikes.length > 20) {
        const msg = "Validation Error: Cannot select more than 20 total option contracts.";
        setStrikeWarning(msg);
        throw new Error(msg);
      }
      if (activeCeCount > 10) {
        const msg = "Validation Error: Cannot select more than 10 Call (CE) strikes.";
        setStrikeWarning(msg);
        throw new Error(msg);
      }
      if (activePeCount > 10) {
        const msg = "Validation Error: Cannot select more than 10 Put (PE) strikes.";
        setStrikeWarning(msg);
        throw new Error(msg);
      }

      const sessionType: "CE" | "PE" | "mixed" =
        activeCeCount > 0 && activePeCount === 0 ? "CE" :
        activePeCount > 0 && activeCeCount === 0 ? "PE" : "mixed";

      console.log("[MODULE2][TRACKER] Starting tracker request to /api/module2/session/start");
      const res = await api.post("/api/module2/session/start", { sessionType, indexSymbol, expiryDate, selectedStrikes });
      console.log("[MODULE2][TRACKER] Response:", res);
      return res;
    },
    onSuccess: (data) => {
      console.log("[MODULE2][TRACKER] Mutation success, active session updated");
      setActiveSession(data);
    },
    onError: (error: any) => {
      console.error("[MODULE2][TRACKER] Request failed:", error?.message || error);
    }
  });

  // Session Stop Mutation with guaranteed local state reset
  const stopSessionMutation = useMutation({
    mutationFn: async () => {
      console.log("[MODULE2][TRACKER] Stop button clicked");
      const currentSessionId = activeSession?.sessionId;
      console.log(`[MODULE2][TRACKER] Stopping session=${currentSessionId || "unknown"}`);

      setActiveSession(null);
      setSelectedStrikes([]);
      setStrikeWarning(null);

      try {
        const res = await api.post("/api/module2/session/stop", { sessionId: currentSessionId });
        return res;
      } catch (err: any) {
        console.warn("[MODULE2][TRACKER] Stop network notice (state cleared locally):", err?.message || err);
        return { status: "success", message: "Session cleared locally" };
      }
    },
    onSuccess: () => {
      console.log("[MODULE2][TRACKER] Session stopped successfully");
      setActiveSession(null);
      setSelectedStrikes([]);
      setStrikeWarning(null);
    },
    onError: () => {
      setActiveSession(null);
      setSelectedStrikes([]);
      setStrikeWarning(null);
    }
  });

  const { data: marketStatus } = useQuery<{ status: "LIVE" | "CLOSED" }>({
    queryKey: ["market-status"],
    queryFn: () => api.get("/api/market/status"),
    refetchInterval: 15000,
  });

  const isClosed = marketStatus?.status === "CLOSED";

  const currentSession = activeSession ? ensureFullStrikesData(activeSession) : null;
  const sessionDataSource = currentSession?.dataSource || "UNAVAILABLE";
  const isLiveInteractive = sessionDataSource === "LIVE_INTERACTIVE_API";

  const sortedTimestamps = useMemo(() => {
    if (!currentSession?.strikes) return [];
    const rawTsList: string[] = [];
    Object.values(currentSession.strikes).forEach((s: any) => {
      s.grid?.forEach((c: any) => {
        if (c.timestamp) rawTsList.push(c.timestamp);
      });
    });
    const continuousTimeline = generateTimelineColumns(rawTsList);
    return continuousTimeline;
  }, [currentSession?.strikes]);

  // All selected strikes are displayed always
  const allSelectedStrikes: string[] = currentSession?.selectedStrikes || [];
  const ceStrikesList = allSelectedStrikes.filter((s) => s.endsWith("CE"));
  const peStrikesList = allSelectedStrikes.filter((s) => s.endsWith("PE"));

  const handleExportExcel = async () => {
    if (!currentSession) return;
    try {
      await exportModule2ToExcel(currentSession, sortedTimestamps, selectedOHLCFields);
    } catch (err) {
      console.error("Excel export failed:", err);
    }
  };

  // ── RENDER ──────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

        @keyframes m2-enter {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .m2-section { animation: m2-enter 0.35s ease both; }

        @keyframes m2-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.03); opacity: 0.95; }
        }

        .m2-th {
          font-family: 'Inter', sans-serif; font-size: 16px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase;
          padding: 12px 16px; white-space: nowrap;
          color: var(--trading-text-muted);
          background: var(--trading-bg);
          border-bottom: 1.5px solid var(--trading-border);
          position: sticky; top: 0; z-index: 2;
        }
        .m2-td {
          font-family: 'Inter', sans-serif; font-size: 24px;
          padding: 12px 16px; white-space: nowrap;
          border-bottom: 1px solid var(--trading-border);
          color: var(--trading-text-active);
        }
        .m2-tr:hover td:not(.m2-sticky-cell) { opacity: 0.95; }
        .m2-tr:hover .m2-sticky-cell {
          background-image: linear-gradient(rgba(4,120,87,0.03), rgba(4,120,87,0.03)) !important;
        }

        .m2-cta {
          width: 100%; padding: 12px; border-radius: 8px;
          font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 700;
          cursor: pointer; border: none; background: ${GREEN}; color: #fff;
          transition: all 0.2s; box-shadow: 0 4px 14px rgba(4,120,87,0.3);
        }
        .m2-cta:hover:not(:disabled) { opacity: 0.9; }
        .m2-cta:disabled { opacity: 0.45; cursor: not-allowed; }

        .m2-excel-btn {
          display: inline-flex; alignItems: center; gap: 6px;
          font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 700;
          padding: 8px 16px; border-radius: 8px; cursor: pointer;
          border: 1.5px solid ${GREEN}; background: rgba(4,120,87,0.08);
          color: ${GREEN}; transition: all 0.15s;
        }
        .m2-excel-btn:hover:not(:disabled) { background: ${GREEN}; color: #fff; }
        .m2-excel-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      `}</style>

      <div style={{ minHeight: isSplit ? "auto" : "100vh", background: isSplit ? "transparent" : "var(--trading-bg)", fontFamily: "'Inter', sans-serif" }}>
        <div style={{ maxWidth: "100%", margin: "0 auto", padding: isSplit ? "12px 12px 20px" : "24px 24px 40px", display: "flex", flexDirection: "column", gap: isSplit ? 12 : 20 }}>

          {/* Header */}
          {isSplit ? (
            <div
              className="m2-section"
              style={{
                background: "var(--trading-surface)",
                border: "1.5px solid var(--trading-border)",
                borderRadius: 10,
                padding: "10px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: GREEN, textTransform: "uppercase", letterSpacing: "0.05em" }}>M2 · Strike Tracker</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--trading-text-active)", borderLeft: "1px solid var(--trading-border)", paddingLeft: 8 }}>
                  {currentSession?.indexSymbol || indexSymbol} · {currentSession?.expiryDate || expiryDate}
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {activeSession && isLiveInteractive && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 5, background: "rgba(4,120,87,0.1)", fontSize: 11, fontWeight: 700, color: GREEN }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: GREEN }} />
                    Live API
                  </span>
                )}
                <button
                  className="m2-excel-btn"
                  onClick={handleExportExcel}
                  disabled={!currentSession || !allSelectedStrikes.length}
                >
                  Export Excel
                </button>
              </div>
            </div>
          ) : (
            <div
              className="m2-section"
              style={{
                background: "var(--trading-surface)", border: "1.5px solid var(--trading-border)",
                borderRadius: 14, padding: "18px 24px",
                display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12,
                boxShadow: "0 1px 8px rgba(0,0,0,0.05)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: GREEN, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>
                    Module 02
                  </div>
                  <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: "var(--trading-text-active)", letterSpacing: "-0.0em" }}>
                    Strike Tracker
                  </h1>
                </div>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 600, color: "var(--trading-text-muted)", background: "var(--trading-bg)", padding: "3px 10px", borderRadius: 6, border: "1.5px solid var(--trading-border)" }}>
                  {currentSession?.indexSymbol || indexSymbol} · {currentSession?.expiryDate || expiryDate}
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {activeSession && isLiveInteractive && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, background: "rgba(4,120,87,0.1)", border: "1.5px solid rgba(4,120,87,0.25)", fontSize: 12, fontWeight: 700, color: GREEN }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: GREEN, display: "inline-block" }} className="animate-pulse" />
                    Live Interactive API
                  </span>
                )}
                <button
                  className="m2-excel-btn"
                  onClick={handleExportExcel}
                  disabled={!currentSession || !allSelectedStrikes.length}
                >
                  Export Excel
                </button>
              </div>
            </div>
          )}



          {/* Broker status banner */}
          {module2BrokerStatus === "session-expired" && (
            <div className="m2-section" style={{ background: "rgba(239,68,68,0.08)", border: "1.5px solid rgba(239,68,68,0.3)", borderRadius: 10, padding: "12px 18px", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 16 }}>⚠</span>
              <div>
                <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 700, color: "#dc2626" }}>Broker Session Expired</div>
                <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#dc2626", opacity: 0.8, marginTop: 2 }}>Please reconnect from the Module 2 login page.</div>
              </div>
            </div>
          )}

          {(module2BrokerStatus === "broker-disconnected" || module2BrokerStatus === "reconnecting") && (
            <div className="m2-section animate-pulse" style={{ background: "rgba(217,119,6,0.08)", border: "1.5px solid rgba(217,119,6,0.3)", borderRadius: 10, padding: "12px 18px", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 16 }}>↻</span>
              <div>
                <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 700, color: "#d97706" }}>Disconnected</div>
                <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#d97706", opacity: 0.8, marginTop: 2 }}>Attempting to reconnect to broker…</div>
              </div>
            </div>
          )}

          {/* Configuration Section (Module 1 Style 4-Dropdown Row) */}
          {isConfigExpanded ? (
            <div
              className="m2-section"
              style={{
                background: "var(--trading-surface)", border: "1.5px solid var(--trading-border)",
                borderRadius: 14, padding: "18px 22px",
                boxShadow: "0 1px 8px rgba(0,0,0,0.05)", animationDelay: "0.04s",
                position: "relative",
                zIndex: 1,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.15em" }}>
                  Configuration & Strikes
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    onClick={handleRefreshConfig}
                    disabled={isRefreshingConfig || isExpiriesFetching || isChainFetching}
                    style={{
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "4px 12px",
                      borderRadius: 6,
                      border: "1.5px solid var(--trading-border, #d8e0ea)",
                      background: isRefreshingConfig ? "rgba(4,120,87,0.08)" : "var(--trading-surface, #ffffff)",
                      color: isRefreshingConfig ? GREEN : "var(--trading-text-muted, #475569)",
                      cursor: (isRefreshingConfig || isExpiriesFetching || isChainFetching) ? "not-allowed" : "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      transition: "all 0.15s",
                      opacity: (isRefreshingConfig || isExpiriesFetching || isChainFetching) ? 0.75 : 1,
                    }}
                    title="Refresh Module 2 configuration and strikes"
                  >
                    <span style={{ display: "inline-block", transform: isRefreshingConfig ? "rotate(180deg)" : "none", transition: "transform 0.5s" }}>
                      ↻
                    </span>
                    <span>{isRefreshingConfig ? "Refreshing…" : "Refresh"}</span>
                  </button>
                  {isSplit && (
                    <button
                      onClick={() => setIsConfigExpanded(false)}
                      style={{
                        background: "rgba(4,120,87,0.08)", border: "none", color: GREEN,
                        fontWeight: 700, fontSize: 11, cursor: "pointer", padding: "4px 10px", borderRadius: 5
                      }}
                    >
                      Hide Config ▲
                    </button>
                  )}
                </div>
              </div>

              {/* 1. Main 4-Column Layout (SYMBOL, EXPIRY DATE, CALL STRIKE, PUT STRIKE) */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 16 }}>
                <SelectField
                  label="Symbol"
                  value={indexSymbol}
                  onChange={setIndexSymbol}
                  options={indexOptions}
                  disabled={isIndexesLoading || !!activeSession}
                />
                <SelectField
                  label="Expiry Date"
                  value={expiryDate}
                  onChange={setExpiryDate}
                  options={expiryOptions}
                  disabled={isExpiriesLoading || !indexSymbol || (expiriesData?.expiries || []).length === 0 || !!activeSession}
                />
                <MultiSelectStrikeDropdown
                  label="Call Strike"
                  type="CE"
                  options={ceOptions}
                  selectedStrikes={selectedStrikes}
                  onToggleStrike={handleToggleCE}
                  onClear={() => setSelectedStrikes((prev) => prev.filter((s) => !s.toUpperCase().endsWith("CE")))}
                  disabled={!expiryDate || isStrikesLoading || isRefreshingConfig || !!activeSession}
                  loading={isStrikesLoading || isRefreshingConfig}
                  maxLimit={10}
                  placeholder="Select Call Strikes…"
                />
                <MultiSelectStrikeDropdown
                  label="Put Strike"
                  type="PE"
                  options={peOptions}
                  selectedStrikes={selectedStrikes}
                  onToggleStrike={handleTogglePE}
                  onClear={() => setSelectedStrikes((prev) => prev.filter((s) => !s.toUpperCase().endsWith("PE")))}
                  disabled={!expiryDate || isStrikesLoading || isRefreshingConfig || !!activeSession}
                  loading={isStrikesLoading || isRefreshingConfig}
                  maxLimit={10}
                  placeholder="Select Put Strikes…"
                />
              </div>

              {/* Warning Banner if any */}
              {strikeWarning && (
                <div
                  style={{
                    marginBottom: 16,
                    padding: "8px 12px",
                    borderRadius: 6,
                    background: "rgba(229, 57, 53, 0.1)",
                    border: "1px solid rgba(229, 57, 53, 0.3)",
                    color: "#e53935",
                    fontSize: 13,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span>⚠️ {strikeWarning}</span>
                  <button
                    onClick={() => setStrikeWarning(null)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#e53935",
                      cursor: "pointer",
                      fontSize: 16,
                      lineHeight: 1,
                      padding: "0 4px",
                    }}
                    title="Dismiss"
                  >
                    ×
                  </button>
                </div>
              )}

              {/* 2. OHLC Display Fields + Live Counter Row */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 14, marginBottom: 18, padding: "10px 14px", background: "var(--trading-bg)", borderRadius: 8, border: "1px solid var(--trading-border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    OHLC
                  </span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    {[
                      { id: "open", label: "Open" },
                      { id: "high", label: "High" },
                      { id: "low", label: "Low" },
                      { id: "close", label: "Close" },
                    ].map((field) => {
                      const isSelected = selectedOHLCFields.includes(field.id);
                      return (
                        <label
                          key={field.id}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "4px 10px",
                            borderRadius: 6,
                            border: isSelected ? `1.5px solid ${GREEN}` : "1.5px solid var(--trading-border)",
                            background: isSelected ? "rgba(4,120,87,0.08)" : "var(--trading-surface)",
                            color: isSelected ? GREEN : "var(--trading-text-muted)",
                            cursor: "pointer",
                            fontFamily: "'Inter', sans-serif",
                            fontSize: 12,
                            fontWeight: 700,
                            userSelect: "none",
                            transition: "all 0.15s",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleOHLCField(field.id)}
                            style={{ accentColor: GREEN, width: 14, height: 14, cursor: "pointer" }}
                          />
                          {field.label}
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 700, color: "var(--trading-text-active)" }}>
                    Selected: <span style={{ color: GREEN }}>CE {ceCount}/10</span> · <span style={{ color: RED }}>PE {peCount}/10</span> · Total {selectedStrikes.length}/20
                  </span>
                </div>
              </div>

              {/* 3. Session Start / Stop Action Button */}
              {activeSession ? (
                <button
                  className="m2-stop-cta"
                  onClick={() => stopSessionMutation.mutate()}
                  disabled={stopSessionMutation.isPending}
                  style={{
                    width: "100%", padding: 12, borderRadius: 8,
                    fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 700,
                    cursor: stopSessionMutation.isPending ? "not-allowed" : "pointer",
                    border: "none", background: RED, color: "#fff",
                    transition: "all 0.2s", boxShadow: "0 4px 14px rgba(229,57,53,0.3)",
                    opacity: stopSessionMutation.isPending ? 0.6 : 1,
                  }}
                >
                  {stopSessionMutation.isPending ? "Stopping Session…" : "Stop Active Session Tracker"}
                </button>
              ) : (
                <button
                  className="m2-cta"
                  onClick={() => startSessionMutation.mutate()}
                  disabled={selectedStrikes.length === 0 || !expiryDate || selectedOHLCFields.length === 0 || startSessionMutation.isPending}
                >
                  {startSessionMutation.isPending ? "Initialising Session…" : "Start Active Session Tracker"}
                </button>
              )}
            </div>
          ) : (
            isSplit && (
              <div
                className="m2-section"
                style={{
                  background: "var(--trading-surface)", border: "1.5px solid var(--trading-border)",
                  borderRadius: 10, padding: "10px 16px",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.04)", cursor: "pointer",
                  position: "relative",
                  zIndex: 1,
                }}
                onClick={() => setIsConfigExpanded(true)}
              >
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  ⚙️ Configure Session & Strikes
                </span>
                <span style={{ color: GREEN, fontWeight: 700, fontSize: 11, background: "rgba(4,120,87,0.08)", padding: "4px 10px", borderRadius: 5 }}>
                  Show Config ▼
                </span>
              </div>
            )
          )}

          {/* Tables Container with Combined Fullscreen support (both CE & PE together) */}
          <div
            ref={fullscreenTablesRef}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: isSplit ? 12 : 20,
              position: isTablesFullscreen ? "fixed" : "relative",
              ...(isTablesFullscreen
                ? {
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    width: "100vw",
                    height: "100vh",
                    zIndex: 9999,
                    background: "var(--trading-bg)",
                    padding: "16px 20px 24px",
                    overflowY: "auto",
                    boxSizing: "border-box",
                  }
                : {}),
            }}
          >
            {/* Fullscreen Header / Action Bar */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: -4 }}>
              {isTablesFullscreen ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: GREEN, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Module 02 · Live Strike Tracker
                  </span>
                  <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 600, color: "var(--trading-text-muted)", background: "var(--trading-surface)", padding: "2px 8px", borderRadius: 6, border: "1px solid var(--trading-border)" }}>
                    {currentSession?.indexSymbol || indexSymbol} · {currentSession?.expiryDate || expiryDate}
                  </span>
                </div>
              ) : <div />}
              <button
                type="button"
                onClick={toggleTablesFullscreen}
                title={isTablesFullscreen ? "Exit full screen" : "Full screen tables"}
                aria-label={isTablesFullscreen ? "Exit full screen" : "Full screen tables"}
                style={{
                  width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
                  border: "1px solid var(--trading-border)", borderRadius: 6, background: "var(--trading-surface)",
                  cursor: "pointer", fontSize: 14, lineHeight: 1, color: "var(--trading-text-active)", padding: 0,
                  boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                }}
              >
                {isTablesFullscreen ? "✖" : "⛶"}
              </button>
            </div>

            {/* CE Table */}
            <div className="m2-section" style={{ animationDelay: "0.1s", position: "relative", zIndex: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: GREEN, display: "inline-block" }} />
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: GREEN, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  CE Strikes
                </span>
              </div>
              <StrikeTrackerTable
                strikesList={ceStrikesList}
                session={currentSession}
                sortedTimestamps={sortedTimestamps}
                selectedOHLCFields={selectedOHLCFields}
                isSplit={isSplit}
                isClosed={isClosed}
              />
            </div>

            {/* PE Table */}
            <div className="m2-section" style={{ animationDelay: "0.13s", position: "relative", zIndex: 5 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: RED, display: "inline-block" }} />
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: RED, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  PE Strikes
                </span>
              </div>
              <StrikeTrackerTable
                strikesList={peStrikesList}
                session={currentSession}
                sortedTimestamps={sortedTimestamps}
                selectedOHLCFields={selectedOHLCFields}
                isSplit={isSplit}
                isClosed={isClosed}
              />
            </div>
          </div>

        </div>
      </div>
    </>
  );
};

// ── StrikeTrackerTable ────────────────────────────────────────────────────────
interface OHLCColDef {
  id: string;
  label: string;
  getValue: (s: any) => number;
  formatValue: (val: number) => string | number;
  textColor: string;
}

const ALL_OHLC_COLS: OHLCColDef[] = [
  {
    id: "open",
    label: "Open",
    getValue: (s) => (typeof s?.dayOpen === "number" && !isNaN(s.dayOpen) && s.dayOpen > 0 ? s.dayOpen : 0),
    formatValue: (val) => (val > 0 ? Math.round(val) : "—"),
    textColor: "#047857",
  },
  {
    id: "high",
    label: "High",
    getValue: (s) => (typeof s?.dayHigh === "number" && !isNaN(s.dayHigh) && s.dayHigh > 0 ? s.dayHigh : 0),
    formatValue: (val) => (val > 0 ? Math.round(val) : "—"),
    textColor: "#2563EB",
  },
  {
    id: "low",
    label: "Low",
    getValue: (s) => (typeof s?.dayLow === "number" && !isNaN(s.dayLow) && s.dayLow > 0 ? s.dayLow : 0),
    formatValue: (val) => (val > 0 ? Math.round(val) : "—"),
    textColor: "#111827",
  },
  {
    id: "close",
    label: "Close",
    getValue: (s) => {
      const lastLtp = (s?.grid && s.grid.length > 0) ? s.grid[s.grid.length - 1]?.ltp : s?.dayOpen;
      return typeof lastLtp === "number" && !isNaN(lastLtp) && lastLtp > 0 ? lastLtp : 0;
    },
    formatValue: (val) => (val > 0 ? Math.round(val) : "—"),
    textColor: "#4B5563",
  },
];

function StrikeTrackerTable({
  strikesList,
  session,
  sortedTimestamps,
  selectedOHLCFields = ["open", "high", "low", "close"],
  isSplit = false,
  isClosed = false,
}: {
  strikesList: string[];
  session: any;
  sortedTimestamps: string[];
  selectedOHLCFields?: string[];
  isSplit?: boolean;
  isClosed?: boolean;
}) {
  const [showFullColumns, setShowFullColumns] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wasAtEndRef = useRef<boolean>(true);
  const cellPadding = isSplit ? "10px 12px" : "12px 16px";
  const cellFontSize = "24px";

  const displayedTimestamps = showFullColumns || !isSplit
    ? sortedTimestamps
    : sortedTimestamps.slice(-5);

  const displayedStrikes = showFullColumns || !isSplit
    ? strikesList
    : strikesList.slice(0, 5);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isAtEnd = el.scrollWidth - el.scrollLeft - el.clientWidth <= 60;
    wasAtEndRef.current = isAtEnd;
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (wasAtEndRef.current) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [displayedTimestamps.length, displayedTimestamps[displayedTimestamps.length - 1]]);

  const activeOHLCCols = ALL_OHLC_COLS.filter((c) => selectedOHLCFields.includes(c.id));

  // Compute Min & Max per active OHLC column across displayed strikes
  const colMinMax: Record<string, { max: number | null; min: number | null }> = {};
  activeOHLCCols.forEach((col) => {
    const values: number[] = [];
    displayedStrikes.forEach((strike) => {
      const s = session?.strikes?.[strike];
      const val = col.getValue(s);
      if (val > 0) values.push(val);
    });
    colMinMax[col.id] = {
      max: values.length > 0 ? Math.max(...values) : null,
      min: values.length > 0 ? Math.min(...values) : null,
    };
  });

  const totalColsCount = displayedTimestamps.length + 2 + ((!isSplit || showFullColumns) ? activeOHLCCols.length : 0);

  return (
    <div
      style={{
        background: "var(--trading-surface)", border: "1.5px solid var(--trading-border)",
        borderRadius: 12, overflow: "hidden",
        boxShadow: "0 1px 8px rgba(0,0,0,0.05)",
      }}
    >
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        style={{ overflowX: "auto", overflowY: "visible" }}
      >
        <table style={{ 
          width: "100%", 
          minWidth: isSplit && showFullColumns ? "1450px" : "100%", 
          borderCollapse: "collapse", 
          textAlign: "left" 
        }}>
          <thead>
            <tr>
              <th className="m2-th" style={{ padding: cellPadding, fontSize: "16px", textAlign: "center", width: 60, minWidth: 55, position: "sticky", left: 0, top: 0, zIndex: 40, borderRight: "1px solid var(--trading-border)", background: "var(--trading-bg)" }}>S.No.</th>
              <th className="m2-th" style={{ padding: cellPadding, fontSize: "18px", minWidth: isSplit ? 200 : 260, position: "sticky", left: 60, top: 0, zIndex: 40, borderRight: "3px solid var(--trading-border)", background: "var(--trading-bg)" }}>Strike</th>
              {displayedTimestamps.map((ts) => (
                <th key={ts} className="m2-th" style={{ padding: cellPadding, fontSize: "18px", textAlign: "center", minWidth: isSplit ? 90 : 110 }}>{ts}</th>
              ))}
              {(!isSplit || showFullColumns) && activeOHLCCols.map((col, idx) => {
                const rightOffset = (activeOHLCCols.length - 1 - idx) * 110;
                const isFirst = idx === 0;
                return (
                  <th
                    key={col.id}
                    className="m2-th"
                    style={{
                      padding: cellPadding,
                      fontSize: "18px",
                      textAlign: "center",
                      minWidth: 110,
                      width: 110,
                      borderLeft: isFirst ? "3px solid var(--trading-border)" : undefined,
                      position: "sticky",
                      right: rightOffset,
                      top: 0,
                      zIndex: 40,
                      background: "var(--trading-bg)",
                    }}
                  >
                    {col.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {isClosed ? (
              <tr>
                <td colSpan={totalColsCount} style={{ padding: "48px 16px", textAlign: "center", fontFamily: "'Inter', sans-serif", fontSize: 24, color: "#E53935", fontWeight: 700 }}>
                  Market Closed
                </td>
              </tr>
            ) : displayedStrikes.length === 0 ? (
              <tr>
                <td colSpan={totalColsCount} style={{ padding: "32px 16px", textAlign: "center", fontFamily: "'Inter', sans-serif", fontSize: 24, color: "var(--trading-text-muted)" }}>
                  No strikes to display in this category.
                </td>
              </tr>
            ) : (
              displayedStrikes.map((strike, index) => {
                const s = session?.strikes?.[strike];
                if (!s) return null;
                const parsed = parseStrikeSymbol(strike);
                const isCE = parsed.optionType === "CE";

                const rowBg = s.isDeepLoss ? "rgba(107,114,128,0.08)" : s.isDowntrendActive ? "rgba(37, 99, 235, 0.08)" : "transparent";
                const stickyBg = s.isDeepLoss
                  ? "rgba(255,242,242,0.98)"
                  : s.isDowntrendActive
                  ? "rgba(255,251,235,0.98)"
                  : "var(--trading-surface)";

                const summaryBg = s.isDeepLoss
                  ? "rgba(255,242,242,0.98)"
                  : s.isDowntrendActive
                  ? "rgba(255,251,235,0.98)"
                  : "var(--trading-surface)";

                // Row-wise Min & Max calculation for timestamp/LTP cells in THIS specific strike row
                const rowLtps: number[] = [];
                displayedTimestamps.forEach((ts) => {
                  const cell = (s.grid || []).find((c: any) => c.timestamp === ts);
                  if (cell && typeof cell.ltp === "number" && !isNaN(cell.ltp) && cell.ltp > 0) {
                    rowLtps.push(cell.ltp);
                  }
                });

                const rowMax = rowLtps.length > 0 ? Math.max(...rowLtps) : null;
                const rowMin = rowLtps.length > 0 ? Math.min(...rowLtps) : null;
                const hasDistinctRowMinMax = rowMax !== null && rowMin !== null && rowMax !== rowMin;

                return (
                  <tr
                    key={strike}
                    className={`m2-tr ${
                      s.isDeepLoss
                        ? "border-red-signal"
                        : s.trendBadge === "L_TO_H"
                        ? "border-green-signal"
                        : ""
                    } ${s.trendBadge === "REVERSAL" ? "animate-reversal-border" : ""}`}
                    style={{ background: rowBg }}
                  >
                    {/* Column 1: S.No. */}
                    <td
                      className="m2-td m2-sticky-cell"
                      style={{
                        padding: cellPadding,
                        fontSize: cellFontSize,
                        textAlign: "center",
                        fontWeight: 600,
                        color: "var(--trading-text-muted)",
                        position: "sticky",
                        left: 0,
                        zIndex: 20,
                        background: stickyBg,
                        borderRight: "1px solid var(--trading-border)",
                        width: 60,
                        minWidth: 55,
                      }}
                    >
                      {index + 1}
                    </td>

                    {/* Column 2: Sticky Strike cell */}
                    <td className="m2-td m2-sticky-cell" style={{ 
                      padding: cellPadding, 
                      fontSize: cellFontSize, 
                      position: "sticky", 
                      left: 60, 
                      zIndex: 20, 
                      background: stickyBg, 
                      borderRight: "3px solid var(--trading-border)", 
                      minWidth: isSplit ? 200 : 260 
                    }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: isSplit ? 2 : 5 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: isSplit ? 6 : 10 }}>
                          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: "24px", fontWeight: 800, color: "var(--trading-text-active)" }}>{parsed.strikePrice}</span>
                          <span style={{
                            padding: isSplit ? "2px 6px" : "3px 8px", borderRadius: 4,
                            fontSize: "14px", fontWeight: 700, fontFamily: "'Inter', sans-serif",
                            color: isCE ? GREEN : RED,
                            background: isCE ? "rgba(4,120,87,0.1)" : "rgba(229,57,53,0.1)",
                            border: `1px solid ${isCE ? "rgba(4,120,87,0.25)" : "rgba(229,57,53,0.25)"}`,
                          }}>
                            {parsed.optionType}
                          </span>
                          <TrendBadge badge={s.trendBadge} />
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                          {s.isDeepLoss && (
                            <span className="animate-pulse" style={{ padding: "1px 5px", borderRadius: 4, fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: RED, background: "rgba(229,57,53,0.1)", border: "1px solid rgba(229,57,53,0.25)" }}>
                              Severe −15%
                            </span>
                          )}
                          {!s.isDeepLoss && s.isDowntrendActive && (
                            <span style={{ padding: "1px 5px", borderRadius: 4, fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: AMBER, background: "rgba(217,119,6,0.1)", border: "1px solid rgba(217,119,6,0.25)" }}>
                              Down 3m
                            </span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Minute columns with ROW-WISE cell-background color logic */}
                    {displayedTimestamps.map((ts) => {
                      const cell = (s.grid || []).find((c: any) => c.timestamp === ts);
                      if (!cell || typeof cell.ltp !== "number" || isNaN(cell.ltp)) return <td key={ts} className="m2-td" style={{ padding: cellPadding, fontSize: cellFontSize, textAlign: "center", color: "var(--trading-text-muted)" }}>—</td>;
                      
                      const isHighest = hasDistinctRowMinMax && cell.ltp === rowMax;
                      const isLowest  = hasDistinctRowMinMax && cell.ltp === rowMin;
                      const isLatestCell = ts === sortedTimestamps[sortedTimestamps.length - 1];

                      const colorClass = isHighest ? "blue" : isLowest ? "black" : null;
                      const cellStyle = colorClass ? colorClassStyle(colorClass, "light") : null;

                      return (
                        <td
                          key={ts}
                          className={`m2-td ${isLatestCell ? "animate-blue-live-pulse" : ""} ${
                            s.isDowntrendActive || s.isDeepLoss ? "bg-call-down-stripes" : ""
                          }`}
                          title={`${cell.timestamp} · ${cell.ltp}`}
                          style={{
                            padding: cellPadding,
                            fontSize: cellFontSize,
                            textAlign: "center",
                            background: cellStyle ? cellStyle.bg : undefined,
                            color: cellStyle ? cellStyle.textColor : "var(--trading-text-active)",
                            fontWeight: isHighest || isLowest ? 700 : 400,
                          }}
                        >
                          {Math.round(cell.ltp)}
                        </td>
                      );
                    })}

                    {/* Selected OHLC Columns with column-wise color logic */}
                    {(!isSplit || showFullColumns) && activeOHLCCols.map((col, idx) => {
                      const rightOffset = (activeOHLCCols.length - 1 - idx) * 110;
                      const isFirst = idx === 0;
                      const val = col.getValue(s);
                      const { max, min } = colMinMax[col.id] || { max: null, min: null };
                      const isHighest = max !== null && min !== null && max !== min && val === max && val > 0;
                      const isLowest  = max !== null && min !== null && max !== min && val === min && val > 0;
                      const colorClass = isHighest ? "blue" : isLowest ? "black" : null;
                      const cellStyle = colorClass ? colorClassStyle(colorClass, "hlc") : null;

                      return (
                        <td
                          key={col.id}
                          className="m2-td m2-sticky-cell"
                          style={{
                            padding: cellPadding,
                            fontSize: cellFontSize,
                            textAlign: "center",
                            position: "sticky",
                            right: rightOffset,
                            zIndex: 20,
                            background: cellStyle ? cellStyle.bg : summaryBg,
                            borderLeft: isFirst ? "3px solid var(--trading-border)" : undefined,
                            color: cellStyle ? cellStyle.textColor : col.textColor,
                            fontWeight: 700,
                            minWidth: 110,
                            width: 110,
                          }}
                        >
                          {col.formatValue(val)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {isSplit && (
        <div style={{ padding: 8, borderTop: "1.5px solid var(--trading-border)", background: "var(--trading-surface)" }}>
          <button
            onClick={() => setShowFullColumns(!showFullColumns)}
            style={{
              width: "100%",
              padding: "6px 12px",
              borderRadius: 8,
              border: "1.5px solid var(--trading-border)",
              background: "var(--trading-surface)",
              color: "var(--trading-text-muted)",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            className="secondary-btn"
          >
            {showFullColumns ? "Collapse to Compact View (5 Rows, 5 Ticks) ▲" : `Show All ${strikesList.length} Rows, Full Columns & All ${sortedTimestamps.length} Ticks ▼`}
          </button>
        </div>
      )}
    </div>
  );
}

export default Module2;
