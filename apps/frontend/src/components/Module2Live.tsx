import { useCallback, useMemo, useState, memo } from "react";
import { useMarketSocket } from "../hooks/module2Live/useMarketSocket";
import { useExpiryDates } from "../hooks/module2Live/useExpiryDates";
import { useInstrumentSearch } from "../hooks/module2Live/useInstrumentSearch";
import { useTrackerSessionBridge } from "../hooks/module2Live/useTrackerSessionBridge";
import { useSubscriptions } from "../hooks/module2Live/useSubscriptions";
import { useMarketData } from "../hooks/module2Live/useMarketData";
import { useCandles } from "../hooks/module2Live/useCandles";
import {
  SUPPORTED_INSTRUMENTS,
  INSTRUMENT_EXCHANGE,
  SupportedInstrument,
  OptionType,
} from "../data/module2LiveTypes";
import type { SubscriptionRecord } from "../data/module2LiveTypes";

const BLUE = "#2563eb";
const GREEN = "#047857";
const RED = "#E53935";
const AMBER = "#D97706";

// ── Connection Status (Step 9) ──────────────────────────────────────────────────

const BROKER_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  CONNECTED: { label: "Connected", color: GREEN },
  RECONNECTED: { label: "Reconnected", color: GREEN },
  DISCONNECTED: { label: "Disconnected", color: RED },
};

const ConnectionBadge = memo(function ConnectionBadge({
  socketStatus,
  brokerStatus,
}: {
  socketStatus: "connecting" | "connected" | "disconnected";
  brokerStatus: string | null;
}) {
  const socketCfg =
    socketStatus === "connected"
      ? { label: "Live Feed", color: GREEN }
      : socketStatus === "connecting"
      ? { label: "Connecting…", color: AMBER }
      : { label: "Offline", color: RED };

  const brokerCfg = brokerStatus ? BROKER_STATUS_LABEL[brokerStatus] || { label: brokerStatus, color: "#64748b" } : null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 6, background: `${socketCfg.color}12`, border: `1px solid ${socketCfg.color}40` }}>
        <span className={socketStatus === "connecting" ? "animate-pulse" : ""} style={{ width: 6, height: 6, borderRadius: "50%", background: socketCfg.color, display: "inline-block" }} />
        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: socketCfg.color }}>{socketCfg.label}</span>
      </span>
      {brokerCfg && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 6, background: `${brokerCfg.color}12`, border: `1px solid ${brokerCfg.color}40` }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: brokerCfg.color, display: "inline-block" }} />
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: brokerCfg.color }}>Broker: {brokerCfg.label}</span>
        </span>
      )}
    </div>
  );
});

// ── One subscribed instrument's live tick + candle (Steps 7/8) ──────────────────

const SubscriptionRow = memo(function SubscriptionRow({
  subscription,
  onUnsubscribe,
  unsubscribing,
}: {
  subscription: SubscriptionRecord;
  onUnsubscribe: (subscriptionId: string) => void;
  unsubscribing: boolean;
}) {
  const { data: tick, loading: tickLoading, error: tickError } = useMarketData(subscription.exchangeInstrumentID);
  const { candle, loading: candleLoading } = useCandles(subscription.exchangeInstrumentID);

  const isCE = subscription.optionType === "CE";
  const handleUnsubscribe = useCallback(() => onUnsubscribe(subscription.subscriptionId), [onUnsubscribe, subscription.subscriptionId]);

  return (
    <div
      style={{
        background: "var(--trading-surface)", border: "1.5px solid var(--trading-border)", borderRadius: 12,
        padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 800, color: "var(--trading-text-active)" }}>
            {subscription.tradingSymbol || subscription.exchangeInstrumentID}
          </span>
          <span style={{
            padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700, fontFamily: "'Inter', sans-serif",
            color: isCE ? GREEN : RED, background: isCE ? "rgba(4,120,87,0.1)" : "rgba(229,57,53,0.1)",
            border: `1px solid ${isCE ? "rgba(4,120,87,0.25)" : "rgba(229,57,53,0.25)"}`,
          }}>
            {subscription.optionType}
          </span>
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "var(--trading-text-muted)" }}>
            Strike {subscription.strike}
          </span>
        </div>
        <button
          onClick={handleUnsubscribe}
          disabled={unsubscribing}
          style={{
            fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, padding: "5px 12px", borderRadius: 6,
            border: "1.5px solid rgba(220,38,38,0.4)", background: "transparent", color: "#dc2626",
            cursor: unsubscribing ? "not-allowed" : "pointer", opacity: unsubscribing ? 0.5 : 1,
          }}
        >
          {unsubscribing ? "Removing…" : "Stop Tracking"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 10 }}>
        {[
          { label: "LTP", value: tick?.lastPrice },
          { label: "OI", value: tick?.openInterest },
          { label: "Volume", value: tick?.volume },
          { label: "Bid", value: tick?.bid },
          { label: "Ask", value: tick?.ask },
        ].map(({ label, value }) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, fontWeight: 700, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, fontWeight: 700, color: "var(--trading-text-active)" }}>
              {tickLoading ? "…" : value ?? "—"}
            </span>
          </div>
        ))}
      </div>

      {tickError && (
        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: "#dc2626" }}>{tickError}</div>
      )}
      {tick?.timestamp && (
        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, color: "var(--trading-text-muted)" }}>
          Last update: {new Date(tick.timestamp).toLocaleTimeString()}
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--trading-border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 10, fontWeight: 700, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Current 1m Candle
        </span>
        {candleLoading ? (
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: "var(--trading-text-muted)" }}>Loading…</span>
        ) : candle ? (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {[
              ["O", candle.open], ["H", candle.high], ["L", candle.low], ["C", candle.close], ["Ticks", candle.tickCount],
            ].map(([label, value]) => (
              <span key={label as string} style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: "var(--trading-text-active)" }}>
                <b>{label}:</b> {value}
              </span>
            ))}
          </div>
        ) : (
          <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: "var(--trading-text-muted)" }}>No candle yet this minute.</span>
        )}
      </div>
    </div>
  );
});

// ── Root screen ───────────────────────────────────────────────────────────────

export function Module2Live() {
  const { status: socketStatus, brokerStatus, reconnect } = useMarketSocket();
  const { sessionId, error: sessionError, ensureSessionId } = useTrackerSessionBridge();

  const [instrument, setInstrument] = useState<SupportedInstrument>("NIFTY");
  const [expiry, setExpiry] = useState("");
  const [strike, setStrike] = useState<number | "">("");
  const [optionType, setOptionType] = useState<OptionType>("CE");
  const [searchQuery, setSearchQuery] = useState("");
  const [subscribeError, setSubscribeError] = useState<string | null>(null);

  const exchange = INSTRUMENT_EXCHANGE[instrument];

  const { expiries, loading: expiriesLoading, error: expiriesError } = useExpiryDates(instrument);
  const { results: searchResults, loading: searchLoading, error: searchError, search, clear: clearSearch } = useInstrumentSearch();
  const {
    subscriptions, loading: subsLoading, error: subsError,
    subscribe, subscribing, unsubscribe, unsubscribing,
  } = useSubscriptions(sessionId);

  const handleInstrumentChange = useCallback((value: string) => {
    setInstrument(value as SupportedInstrument);
    setExpiry("");
    clearSearch();
    setSearchQuery("");
  }, [clearSearch]);

  const handleSearch = useCallback(() => {
    search(searchQuery || instrument);
  }, [search, searchQuery, instrument]);

  const handleStartTracking = useCallback(async () => {
    setSubscribeError(null);
    if (!expiry || strike === "" || Number(strike) <= 0) {
      setSubscribeError("Choose an expiry and enter a valid strike before tracking.");
      return;
    }
    try {
      const activeSessionId = await ensureSessionId({
        sessionType: optionType === "CE" ? "CE" : "PE",
        indexSymbol: instrument,
        expiryDate: expiry,
        selectedStrikes: [`${instrument}${strike}${optionType}`],
      });
      if (!activeSessionId) return;
      await subscribe({ exchange, instrument, expiry, strike: Number(strike), optionType });
    } catch (err: any) {
      setSubscribeError(err?.message || "Failed to start tracking this instrument.");
    }
  }, [ensureSessionId, subscribe, exchange, instrument, expiry, strike, optionType]);

  const activeSubscriptions = useMemo(
    () => subscriptions.filter((s) => s.status === "ACTIVE"),
    [subscriptions]
  );

  return (
    <div style={{ minHeight: "100vh", background: "var(--trading-bg)", fontFamily: "'Inter', sans-serif", padding: "24px", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: BLUE, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>Module 02 · Phase 13</div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: "var(--trading-text-active)" }}>Live Instrument Watch</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ConnectionBadge socketStatus={socketStatus} brokerStatus={brokerStatus?.status ?? null} />
          {socketStatus === "disconnected" && (
            <button onClick={reconnect} style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, padding: "5px 12px", borderRadius: 6, border: `1.5px solid ${BLUE}`, background: "transparent", color: BLUE, cursor: "pointer" }}>
              Reconnect
            </button>
          )}
        </div>
      </div>

      {/* Instrument selection (Step 5) */}
      <div style={{ background: "var(--trading-surface)", border: "1.5px solid var(--trading-border)", borderRadius: 14, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.12em" }}>Instrument Selection</span>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
          <Field label="Exchange">
            <input value={exchange} disabled className="m2l-input" style={{ opacity: 0.7 }} />
          </Field>

          <Field label="Instrument">
            <select value={instrument} onChange={(e) => handleInstrumentChange(e.target.value)} className="m2l-select">
              {SUPPORTED_INSTRUMENTS.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </Field>

          <Field label="Expiry">
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="m2l-select" disabled={expiriesLoading}>
              <option value="">{expiriesLoading ? "Loading…" : "Select expiry"}</option>
              {expiries.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>

          <Field label="Strike">
            <input
              type="number"
              value={strike}
              onChange={(e) => setStrike(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="e.g. 25500"
              className="m2l-input"
            />
          </Field>

          <Field label="Type">
            <div style={{ display: "flex", gap: 4 }}>
              {(["CE", "PE"] as OptionType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setOptionType(t)}
                  style={{
                    flex: 1, padding: "8px 0", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer",
                    border: `1.5px solid ${optionType === t ? (t === "CE" ? GREEN : RED) : "var(--trading-border)"}`,
                    background: optionType === t ? (t === "CE" ? "rgba(4,120,87,0.1)" : "rgba(229,57,53,0.1)") : "transparent",
                    color: optionType === t ? (t === "CE" ? GREEN : RED) : "var(--trading-text-muted)",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </Field>
        </div>

        {expiriesError && <div style={{ fontSize: 11, color: "#dc2626" }}>{expiriesError}</div>}

        {/* Search (Step 5) */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search instruments (default: ${instrument})`}
            className="m2l-input"
            style={{ flex: 1, minWidth: 200 }}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <button onClick={handleSearch} disabled={searchLoading} className="m2l-btn-secondary">
            {searchLoading ? "Searching…" : "Search"}
          </button>
        </div>
        {searchError && <div style={{ fontSize: 11, color: "#dc2626" }}>{searchError}</div>}
        {searchResults.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 100, overflowY: "auto" }}>
            {searchResults.slice(0, 30).map((r) => (
              <span key={r.exchangeInstrumentID} title={r.tradingSymbol} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 11, background: "var(--trading-bg)", border: "1px solid var(--trading-border)", color: "var(--trading-text-active)" }}>
                {r.tradingSymbol || r.instrumentName}
              </span>
            ))}
          </div>
        )}

        <button onClick={handleStartTracking} disabled={subscribing} className="m2l-btn-primary" style={{ alignSelf: "flex-start" }}>
          {subscribing ? "Starting…" : "Start Tracking"}
        </button>
        {(subscribeError || sessionError) && <div style={{ fontSize: 12, color: "#dc2626", fontWeight: 600 }}>{subscribeError || sessionError}</div>}
      </div>

      {/* Subscriptions (Steps 6/7/8/10) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.12em" }}>
          Tracked Instruments {activeSubscriptions.length > 0 && `(${activeSubscriptions.length})`}
        </span>

        {!sessionId ? (
          <EmptyState message="Start tracking an instrument above to begin." />
        ) : subsLoading ? (
          <EmptyState message="Loading subscriptions…" />
        ) : subsError ? (
          <EmptyState message={subsError} isError />
        ) : activeSubscriptions.length === 0 ? (
          <EmptyState message="No instruments tracked yet." />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 14 }}>
            {activeSubscriptions.map((s) => (
              <SubscriptionRow key={s.subscriptionId} subscription={s} onUnsubscribe={unsubscribe} unsubscribing={unsubscribing} />
            ))}
          </div>
        )}
      </div>

      <style>{`
        .m2l-input, .m2l-select {
          width: 100%; box-sizing: border-box; padding: 9px 12px;
          font-family: 'Inter', sans-serif; font-size: 13px; font-weight: 500;
          color: var(--trading-text-active); background: var(--trading-bg);
          border: 1.5px solid var(--trading-border); border-radius: 8px; outline: none;
        }
        .m2l-btn-primary {
          padding: 10px 20px; border-radius: 8px; border: none;
          font-family: 'Inter', sans-serif; font-size: 13px; font-weight: 700;
          background: ${BLUE}; color: #fff; cursor: pointer;
        }
        .m2l-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .m2l-btn-secondary {
          padding: 9px 16px; border-radius: 8px; border: 1.5px solid ${BLUE};
          font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 700;
          background: transparent; color: ${BLUE}; cursor: pointer;
        }
        .m2l-btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
    </div>
  );
}

const Field = memo(function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "var(--trading-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</label>
      {children}
    </div>
  );
});

const EmptyState = memo(function EmptyState({ message, isError = false }: { message: string; isError?: boolean }) {
  return (
    <div style={{ padding: "24px", textAlign: "center", background: "var(--trading-surface)", border: "1.5px dashed var(--trading-border)", borderRadius: 12, fontSize: 13, color: isError ? "#dc2626" : "var(--trading-text-muted)", fontWeight: 600 }}>
      {message}
    </div>
  );
});

export default Module2Live;
