import { useEffect, useRef, useState } from "react";
import { useDashStore, scopedKey } from "./store";
import type { FeedStatus } from "./store";
import { ConfigRow } from "./ConfigRow";
import { TimeframeRow } from "./TimeframeRow";
import { Worksheet } from "./Worksheet";
import { exportModule1Excel, istDateStr } from "./excelExport";
import { useStore } from "../../store/useStore";
import { api } from "../../utils/api";
import type { OHLCBar } from "../../calc";
import {
  mmaBar, computeRanking,
  newTmaState, tmaAccumulate, tmaValue,
  computeRsiSeries, computeEMASeries, computeVWAPSeries,
  nearestFibLabel, smcNearest,
  compareScore, totalScoreFromParts, ratingFromTotalScore, signalFromRating,
} from "../../calc";
import type { TmaState } from "../../calc";
import { formatExpiryForBroker } from "../../data/models";

// -- Helpers -------------------------------------------------------------------

function tfToMs(tf: string): number {
  if (tf.endsWith("h")) return parseInt(tf, 10) * 60 * 60 * 1000;
  if (tf.endsWith("m")) return parseInt(tf, 10) * 60 * 1000;
  return 5 * 60 * 1000;
}

// Sentinel for a bar with no data
const MISSING_BAR = (t: number): OHLCBar => ({ t, o: NaN, h: NaN, l: NaN, c: NaN });

function normalizeBar(raw: any): OHLCBar | null {
  if (!raw || typeof raw !== "object") return null;
  const t =
    raw.t         != null ? Number(raw.t)                        :
    raw.openTime  != null ? Number(raw.openTime)                 :
    raw.timestamp != null ? new Date(raw.timestamp).getTime()    : null;
  const o = raw.o ?? raw.open;
  const h = raw.h ?? raw.high;
  const l = raw.l ?? raw.low;
  const c = raw.c ?? raw.close;
  if (t == null || o == null || h == null || l == null || c == null) return null;
  if (!Number.isFinite(t) || !Number.isFinite(+o) || !Number.isFinite(+h) ||
      !Number.isFinite(+l) || !Number.isFinite(+c)) return null;
  const rawVolume = raw.volume ?? raw.v;
  const volume = rawVolume != null && Number.isFinite(+rawVolume) ? +rawVolume : undefined;
  return { t, o: +o, h: +h, l: +l, c: +c, volume };
}

interface ActiveBar {
  callO: number; callH: number; callL: number; callC: number;
  putO:  number; putH:  number; putL:  number; putC:  number;
  futO:  number; futH:  number; futL:  number; futC:  number;
  spotO: number; spotH: number; spotL: number; spotC: number;
  futVolume: number;
  windowStart: number;
}

// -- StatusPanel ---------------------------------------------------------------

const STATUS_CONFIGS: Partial<Record<FeedStatus | "custom-pending", {
  icon: string; title: string; message: string; color: string; showRetry?: boolean;
}>> = {
  "connecting": {
    icon: "⟳",
    title: "Connecting…",
    message: "Establishing connection to the market data feed.",
    color: "#2E75B6",
  },
  "reconnecting": {
    icon: "⟳",
    title: "Reconnecting…",
    message: "Connection lost. Attempting to reconnect to the broker automatically.",
    color: "#D97706",
  },
  "market-closed": {
    icon: "◷",
    title: "Market Closed",
    message: "The market is currently closed. Trading hours: Monday – Friday, 9:15 AM – 3:30 PM IST.",
    color: "#5B6B7F",
  },
  "auth-error": {
    icon: "⊙",
    title: "Authentication Required",
    message: "Please authenticate with your broker to access live market data.",
    color: "#D97706",
  },
  "broker-disconnected": {
    icon: "⊘",
    title: "Broker Disconnected",
    message: "Unable to connect to the broker. Please re-authenticate with your broker credentials.",
    color: "#DC2626",
    showRetry: true,
  },
  "session-expired": {
    icon: "⊙",
    title: "Broker Session Expired",
    message: "Your broker session has expired. Please go to the login panel and reconnect.",
    color: "#D97706",
  },
  "api-error": {
    icon: "⚠",
    title: "API Error",
    message: "Unable to retrieve live market data. Please check your connection and try again.",
    color: "#DC2626",
    showRetry: true,
  },
  "no-network": {
    icon: "⊘",
    title: "No Internet Connection",
    message: "Internet connection lost. Reconnecting…",
    color: "#DC2626",
    showRetry: true,
  },
  "custom-pending": {
    icon: "📅",
    title: "Select a Date Range",
    message: "Choose a start and end date in the toolbar above, then click Apply.",
    color: "#5B6B7F",
  },
};

function StatusPanel({ status, onRetry }: { status: string; onRetry?: () => void }) {
  const cfg = STATUS_CONFIGS[status as keyof typeof STATUS_CONFIGS];
  if (!cfg) return null;
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", flex: 1, padding: 48, textAlign: "center",
      background: "#FFFFFF",
    }}>
      <div style={{ fontSize: 48, marginBottom: 16, color: cfg.color, lineHeight: 1 }}>
        {cfg.icon}
      </div>
      <div style={{
        fontSize: 16, fontWeight: 700, color: "#1A2533", marginBottom: 10,
        fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
      }}>
        {cfg.title}
      </div>
      <div style={{
        fontSize: 13, color: "#5B6B7F", maxWidth: 420, lineHeight: 1.65,
        marginBottom: cfg.showRetry ? 24 : 0,
        fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
      }}>
        {cfg.message}
      </div>
      {cfg.showRetry && onRetry && (
        <button
          onClick={onRetry}
          style={{
            fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
            fontSize: 13, fontWeight: 600,
            padding: "8px 24px", borderRadius: 4,
            border: "1px solid #2E75B6", background: "#2E75B6",
            color: "#fff", cursor: "pointer",
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

// -- InfoBar -------------------------------------------------------------------

function InfoBar() {
  const { pivotMethod, setPivotMethod } = useDashStore();

  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.5)",
    textTransform: "uppercase", letterSpacing: "0.1em",
  };

  return (
    <div style={{
      height: 42, flexShrink: 0,
      background: "#0F2744",
      display: "flex", alignItems: "center",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
      userSelect: "none",
    }}>
      <div style={{
        padding: "0 18px",
        fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
        fontSize: 15, fontWeight: 800, color: "#f1f5f9",
        letterSpacing: "0.04em", whiteSpace: "nowrap",
      }}>
        ◆ SYNERGY <span style={{ opacity: 0.4 }}>·</span> Trading Dashboard
      </div>

      <div style={{ flex: 1 }} />

      {/* PP / 4-Bar / Classic toggle */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "0 16px", borderLeft: "1px solid rgba(255,255,255,0.1)",
      }}>
        <span style={{ ...labelStyle, marginRight: 7 }}>PP</span>
        {(["client", "classic"] as const).map(m => (
          <button
            key={m}
            onClick={() => setPivotMethod(m)}
            style={{
              fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
              fontSize: 11, fontWeight: 700,
              padding: "3px 10px", borderRadius: 3,
              border: "1px solid rgba(255,255,255,0.2)",
              background: pivotMethod === m ? "#2E75B6" : "transparent",
              color: pivotMethod === m ? "#fff" : "rgba(255,255,255,0.5)",
              cursor: "pointer", letterSpacing: "0.05em",
              textTransform: "capitalize",
            }}
          >
            {m === "client" ? "4-Bar" : "Classic"}
          </button>
        ))}
      </div>
    </div>
  );
}

// -- Dashboard ----------------------------------------------------------------

export function Dashboard() {
  const {
    isGenerated, instrument, timeframe, customRange,
    expiryDate, callStrike, putStrike, type,
    rows, appendRow, clearRows,
    setFeedStatus, feedStatus,
    setLivePrices,
    hiddenCols, colOrder,
    generateKey, reloadKey, bumpReloadKey,
    rehydratePrefs,
    pivotMethod,
  } = useDashStore();

  const [isLoading, setIsLoading] = useState(false);

  const barRef        = useRef<ActiveBar | null>(null);
  const prevRsiCloses = useRef<number[]>([]);
  const swHighRef     = useRef<number>(0);
  const swLowRef      = useRef<number>(Infinity);
  const prevOiTin     = useRef<number>(-1);
  const prevEmaRef    = useRef<number | null>(null);
  const prevEma200Ref = useRef<number | null>(null);
  const vwapStateRef  = useRef<{ cumTPV: number; cumV: number }>({ cumTPV: 0, cumV: 0 });
  const tmaStatesRef  = useRef<{ call: TmaState; put: TmaState; fut: TmaState; spot: TmaState }>({
    call: newTmaState(), put: newTmaState(), fut: newTmaState(), spot: newTmaState(),
  });
  const liveFutVolumeRef = useRef<number>(0);

  // M-4: Rehydrate user-scoped preferences on login
  const user = useStore((s) => s.user);
  useEffect(() => {
    if (user?.id) {
      rehydratePrefs(user.id);
    }
  }, [user?.id, rehydratePrefs]);

  // Effect 1: fetch history whenever config changes
  useEffect(() => {
    if (!isGenerated) {
      clearRows();
      setFeedStatus("idle");
      barRef.current = null;
      prevRsiCloses.current = [];
      prevEmaRef.current = null;
      prevEma200Ref.current = null;
      vwapStateRef.current = { cumTPV: 0, cumV: 0 };
      tmaStatesRef.current = { call: newTmaState(), put: newTmaState(), fut: newTmaState(), spot: newTmaState() };
      liveFutVolumeRef.current = 0;
      return;
    }

    if (timeframe === "custom" && !customRange) {
      clearRows();
      setFeedStatus("live");
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    barRef.current = null;
    prevRsiCloses.current = [];
    prevOiTin.current = -1;
    prevEmaRef.current = null;
    prevEma200Ref.current = null;
    vwapStateRef.current = { cumTPV: 0, cumV: 0 };
    tmaStatesRef.current = { call: newTmaState(), put: newTmaState(), fut: newTmaState(), spot: newTmaState() };
    liveFutVolumeRef.current = 0;

    async function init() {
      clearRows();
      setIsLoading(true);
      setFeedStatus("connecting");
      console.log("[Module1/Data] Initializing Dashboard data load...");

      try {
        // 1. Market status check
        if (timeframe !== "custom") {
          const status = await api.get("/api/market/status").catch(() => null);
          if (cancelled) return;

          if (status?.status === "CLOSED") {
            setFeedStatus("market-closed");
          } else if (status && !status.zebuConnected) {
            const m1Status = useStore.getState().module1Status;
            if (m1Status !== "authenticated" && m1Status !== "authenticating") {
              setFeedStatus("auth-error");
              setIsLoading(false);
              return;
            }
            // If authenticated, do not immediately show fatal api-error;
            // keep status as connecting and proceed with history load + live wait.
            console.log("[Module1/Data] Broker connecting on startup — proceeding with history load & live wait");
            setFeedStatus("connecting");
          }
        }

        // 2. Build the futures OHLC URL from the selected underlying
        const inst   = (instrument || "NIFTY").toUpperCase();
        const futSym = `${inst}-FUT`;
        let futUrl: string;

        if (timeframe === "custom" && customRange) {
          futUrl = `/api/market/ohlc-history/${futSym}/${customRange.candleTf}?from=${encodeURIComponent(customRange.from)}&to=${encodeURIComponent(customRange.to)}`;
        } else {
          futUrl = `/api/market/ohlc/${futSym}/${timeframe}`;
        }

        // 3. Derive option symbols from store config
        const expiryFmt = formatExpiryForBroker(expiryDate);
        const includesCall = type === "Call" || type === "Call+Put";
        const includesPut  = type === "Put"  || type === "Call+Put";
        const ceSymbol = (expiryFmt && includesCall && callStrike) ? `${instrument}${expiryFmt}C${callStrike}` : null;
        const peSymbol = (expiryFmt && includesPut  && putStrike)  ? `${instrument}${expiryFmt}P${putStrike}`  : null;

        // 4. Fetch all OHLC series in parallel with bounded retry for transient network glitches
        const tf = timeframe === "custom" ? customRange!.candleTf : timeframe;

        console.log("[Module1/Data] Loading history from API...");

        const fetchWithRetry = async <T,>(fn: () => Promise<T>, maxAttempts = 3, initialDelay = 500): Promise<T | null> => {
          let delay = initialDelay;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              if (cancelled) return null;
              return await fn();
            } catch (err) {
              if (attempt === maxAttempts || cancelled) return null;
              await new Promise((res) => setTimeout(res, delay));
              delay *= 2;
            }
          }
          return null;
        };

        const [rawFut, rawCe, rawPe, rawSpot, rawSpotWarmup] = await Promise.all([
          fetchWithRetry(() => api.get(futUrl)),
          ceSymbol ? fetchWithRetry(() => api.get(`/api/market/ohlc/${ceSymbol}/${tf}`)) : Promise.resolve(null),
          peSymbol ? fetchWithRetry(() => api.get(`/api/market/ohlc/${peSymbol}/${tf}`)) : Promise.resolve(null),
          timeframe !== "custom"
            ? fetchWithRetry(() => api.get(`/api/market/ohlc/NIFTY-SPOT/${tf}`))
            : Promise.resolve(null),
          timeframe !== "custom"
            ? fetchWithRetry(() => api.get(`/api/market/ohlc-warmup/NIFTY-SPOT/${tf}?count=200`))
            : Promise.resolve(null),
        ]);

        if (cancelled) return;

        // 5. Normalize and build lookup maps
        let futBars: OHLCBar[] = Array.isArray(rawFut)
          ? rawFut.map(normalizeBar).filter(Boolean) as OHLCBar[]
          : [];

        const ceMap   = new Map<number, OHLCBar>();
        const peMap   = new Map<number, OHLCBar>();
        const spotMap = new Map<number, OHLCBar>();

        if (Array.isArray(rawCe)) {
          rawCe.forEach(r => { const b = normalizeBar(r); if (b) ceMap.set(b.t, b); });
        }
        if (Array.isArray(rawPe)) {
          rawPe.forEach(r => { const b = normalizeBar(r); if (b) peMap.set(b.t, b); });
        }
        if (Array.isArray(rawSpot)) {
          rawSpot.forEach(r => { const b = normalizeBar(r); if (b) spotMap.set(b.t, b); });
        }

        const spotWarmupCloses: number[] = Array.isArray(rawSpotWarmup)
          ? (rawSpotWarmup.map(normalizeBar).filter(Boolean) as OHLCBar[])
              .sort((a, b) => a.t - b.t)
              .map(b => b.c)
          : [];

        if (process.env.NODE_ENV === "development" && (ceMap.size > 0 || peMap.size > 0)) {
          console.log(`[C-1] Option OHLC loaded — CE bars: ${ceMap.size} PE bars: ${peMap.size} Spot bars: ${spotMap.size}`);
        }

        // 6. Client-side session filter for live mode
        if (timeframe !== "custom" && futBars.length > 0) {
          const nowMs = Date.now();
          const todayMidnightMs = nowMs - (nowMs % (24 * 60 * 60 * 1000));
          const sessionOpenMs = todayMidnightMs + (3 * 60 + 45) * 60 * 1000;
          const cutoffMs = nowMs < sessionOpenMs ? sessionOpenMs - 24 * 60 * 60 * 1000 : sessionOpenMs;
          futBars = futBars.filter(b => b.t >= cutoffMs);
        }

        if (cancelled) return;

        // 7. Build historical rows (closed bars only for live mode)
        const nowForBoundary  = Date.now();
        const activeTfMs      = tfToMs(timeframe === "custom" ? (customRange?.candleTf ?? "5m") : timeframe);
        const liveWindowStart = Math.floor(nowForBoundary / activeTfMs) * activeTfMs;

        const closedBars = timeframe === "custom"
          ? futBars
          : futBars.filter(b => b.t < liveWindowStart);

        if (spotWarmupCloses.length > 0) {
          const warmupEma    = computeEMASeries(spotWarmupCloses, 20);
          const warmupEma200 = computeEMASeries(spotWarmupCloses, 200);
          prevEmaRef.current    = warmupEma[warmupEma.length - 1] ?? null;
          prevEma200Ref.current = warmupEma200[warmupEma200.length - 1] ?? null;
        }

        if (closedBars.length > 0) {
          const futCloses       = closedBars.map(b => b.c);
          const rsiSeries       = computeRsiSeries(futCloses);
          const spotBarsForCalc = closedBars.map(b => spotMap.get(b.t) ?? b);
          const spotCloses      = spotBarsForCalc.map(sb => sb.c);

          const warmupLen       = spotWarmupCloses.length;
          const combinedCloses  = [...spotWarmupCloses, ...spotCloses];
          const emaSeriesAll    = computeEMASeries(combinedCloses, 20);
          const emaSeries200All = computeEMASeries(combinedCloses, 200);
          const emaSeries       = emaSeriesAll.slice(warmupLen);
          const emaSeries200    = emaSeries200All.slice(warmupLen);

          const vwapSeries      = computeVWAPSeries(closedBars);

          prevEmaRef.current = emaSeriesAll[emaSeriesAll.length - 1] ?? null;
          prevEma200Ref.current = emaSeries200All[emaSeries200All.length - 1] ?? null;
          let cumTPVForState = 0;
          let cumVForState   = 0;
          closedBars.forEach(fb => {
            const v = fb.volume ?? 0;
            cumTPVForState += ((fb.h + fb.l + fb.c) / 3) * v;
            cumVForState   += v;
          });
          vwapStateRef.current = { cumTPV: cumTPVForState, cumV: cumVForState };

          let sessionHigh = closedBars[0].h;
          let sessionLow  = closedBars[0].l;
          let prevH = closedBars[0].h;
          let prevL = closedBars[0].l;

          closedBars.forEach((bar, i) => {
            if (i > 0) {
              sessionHigh = Math.max(sessionHigh, bar.h);
              sessionLow  = Math.min(sessionLow,  bar.l);
            }
            const pdh = i === 0 ? bar.h : prevH;
            const pdl = i === 0 ? bar.l : prevL;

            const callBar: OHLCBar = ceMap.get(bar.t) ?? MISSING_BAR(bar.t);
            const putBar:  OHLCBar = peMap.get(bar.t) ?? MISSING_BAR(bar.t);
            const spotBar: OHLCBar = spotMap.get(bar.t) ?? bar;

            const cMMA = mmaBar(callBar);
            const pMMA = mmaBar(putBar);
            const fMMA = mmaBar(bar);
            const sMMA = mmaBar(spotBar);
            const tma = tmaStatesRef.current;
            tmaAccumulate(tma.call, callBar);
            tmaAccumulate(tma.put,  putBar);
            tmaAccumulate(tma.fut,  bar);
            tmaAccumulate(tma.spot, spotBar);
            const cTMA = tmaValue(tma.call);
            const pTMA = tmaValue(tma.put);
            const fTMA = tmaValue(tma.fut);
            const sTMA = tmaValue(tma.spot);
            const { value: rankVal, winner: rankWin } = computeRanking(cMMA, pMMA);
            const hRsi    = rsiSeries[i]    ?? null;
            const hEma    = emaSeries[i]    ?? null;
            const hEma200 = emaSeries200[i] ?? null;
            const hVwap   = vwapSeries[i]   ?? null;
            const hEmaScore   = compareScore(hEma, hEma200);
            const hVwapScore  = compareScore(hVwap, hEma);
            const hTotalScore = totalScoreFromParts(hEmaScore, hVwapScore);
            const hRating     = ratingFromTotalScore(hTotalScore);

            appendRow({
              t: bar.t,
              call: callBar, put: putBar, future: bar, spot: spotBar,
              callMMA: cMMA,   callTMA: cTMA,
              putMMA:  pMMA,   putTMA:  pTMA,
              futureMMA: fMMA, futureTMA: fTMA,
              spotMMA:   sMMA, spotTMA:   sTMA,
              ranking: rankVal, rankingWinner: rankWin,
              oiMatrix: null,
              smc: smcNearest(bar.c, sessionHigh, sessionLow, pdh, pdl),
              fib: nearestFibLabel(bar.c, sessionHigh, sessionLow) ?? "—",
              rsi: hRsi,
              ema:  hEma,
              vwap: hVwap,
              ema200: hEma200,
              emaScore: hEmaScore, vwapScore: hVwapScore, totalScore: hTotalScore,
              rating: hRating, signal: signalFromRating(hRating),
            });

            prevH = bar.h;
            prevL = bar.l;
          });

          prevRsiCloses.current = futCloses.slice(-50);
          swHighRef.current = sessionHigh;
          swLowRef.current  = sessionLow;

          const last        = closedBars[closedBars.length - 1];
          const lastSpotBar = spotMap.get(last.t) ?? last;
          setLivePrices(lastSpotBar.c, last.c);

          console.log(
            `[Module1/Data] History loaded: ${closedBars.length} closed bars | ` +
            `sessionHigh=${sessionHigh} sessionLow=${sessionLow} | last bar t=${last.t}`
          );
        }

        setIsLoading(false);
        if (useDashStore.getState().feedStatus !== "market-closed") {
          setFeedStatus("live");
        }

      } catch (err: unknown) {
        if (cancelled) return;
        const msg = (err as any)?.message?.toLowerCase() ?? "";
        const isNetworkError = !navigator.onLine ||
          msg.includes("failed to fetch") ||
          msg.includes("networkerror") ||
          msg.includes("internet connection");
        const isTimeout = msg.includes("timed out");
        setFeedStatus(isNetworkError || isTimeout ? "no-network" : "api-error");
        setIsLoading(false);
      }
    }

    init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerated, instrument, timeframe, customRange, reloadKey, generateKey, expiryDate, callStrike, putStrike, type]);

  // Effect 1b: automatic recovery from a stuck error state
  useEffect(() => {
    if (!isGenerated) return;

    if (
      feedStatus === "api-error" ||
      feedStatus === "auth-error" ||
      feedStatus === "no-network" ||
      feedStatus === "broker-disconnected" ||
      feedStatus === "reconnecting"
    ) {
      const t = setInterval(() => {
        console.log(`[Module1/Data] Auto-recovering from ${feedStatus}...`);
        bumpReloadKey();
      }, 5000);
      return () => clearInterval(t);
    }

    if (feedStatus === "market-closed") {
      const t = setInterval(() => bumpReloadKey(), 60000);
      return () => clearInterval(t);
    }
  }, [isGenerated, feedStatus, bumpReloadKey]);

  // Effect 2: 500ms live OI polling — builds and updates the active bar.
  useEffect(() => {
    if (!isGenerated || timeframe === "custom") return;

    const tfMs = tfToMs(timeframe);

    const timer = setInterval(() => {
      const dash = useDashStore.getState();
      if (dash.feedStatus !== "live") return;

      const { oiMetrics: oi, prices } = useStore.getState();
      if (!oi) return;

      const now         = Date.now();
      const windowStart = Math.floor(now / tfMs) * tfMs;

      const futLtp  = prices["NIFTY-FUT"]?.ltp;
      const spotLtp = prices["NIFTY-SPOT"]?.ltp;

      if (!futLtp) return;

      const FRESH_TTL_MS = 8000;
      const futUpdatedAt  = prices["NIFTY-FUT"]?.lastUpdated?.getTime();
      const futFresh      = futUpdatedAt  !== undefined && (now - futUpdatedAt)  < FRESH_TTL_MS;
      const spotUpdatedAt = prices["NIFTY-SPOT"]?.lastUpdated?.getTime();
      const spotFresh     = spotUpdatedAt !== undefined && (now - spotUpdatedAt) < FRESH_TTL_MS;

      const { expiryDate: expDate, instrument: inst, callStrike: cs, putStrike: ps, type: t } =
        useDashStore.getState();
      const exFmt    = formatExpiryForBroker(expDate);
      const ceSymbol = (exFmt && t !== "Put"  && cs) ? `${inst}${exFmt}C${cs}` : null;
      const peSymbol = (exFmt && t !== "Call" && ps) ? `${inst}${exFmt}P${ps}`  : null;
      const ceLtp = ceSymbol ? (prices[ceSymbol]?.ltp ?? null) : null;
      const peLtp = peSymbol ? (prices[peSymbol]?.ltp ?? null) : null;

      const futSymForVolume = `${(inst || "NIFTY").toUpperCase()}-FUT`;
      api.get(`/api/market/futures/${futSymForVolume}?timeframe=${timeframe}`)
        .then((data: any) => {
          if (typeof data?.activeCandle?.volume === "number") {
            liveFutVolumeRef.current = data.activeCandle.volume;
          }
        })
        .catch(() => { /* keep last known volume on failure */ });

      if (oi.tin !== prevOiTin.current) {
        console.log(
          `[Module1/Data] OI tick — tin=${oi.tin} futLtp=${futLtp} ceLtp=${ceLtp ?? "—"} peLtp=${peLtp ?? "—"} ` +
          `src=${oi.dataSource} window=${new Date(windowStart).toISOString()}`
        );
        prevOiTin.current = oi.tin;
      }

      if (!barRef.current || barRef.current.windowStart !== windowStart) {
        // Finalize previous live bar into running EMA / VWAP state
        if (barRef.current) {
          const pb = barRef.current;
          if (prevEmaRef.current !== null) {
            const k = 2 / (20 + 1);
            prevEmaRef.current = pb.spotC * k + prevEmaRef.current * (1 - k);
          }
          if (prevEma200Ref.current !== null) {
            const k200 = 2 / (200 + 1);
            prevEma200Ref.current = pb.spotC * k200 + prevEma200Ref.current * (1 - k200);
          }
          if (!isNaN(pb.futH) && !isNaN(pb.futL) && !isNaN(pb.futC)) {
            vwapStateRef.current.cumTPV += ((pb.futH + pb.futL + pb.futC) / 3) * pb.futVolume;
            vwapStateRef.current.cumV   += pb.futVolume;
          }
          const tmaFold = tmaStatesRef.current;
          tmaAccumulate(tmaFold.call, { t: pb.windowStart, o: pb.callO, h: pb.callH, l: pb.callL, c: pb.callC });
          tmaAccumulate(tmaFold.put,  { t: pb.windowStart, o: pb.putO,  h: pb.putH,  l: pb.putL,  c: pb.putC  });
          tmaAccumulate(tmaFold.fut,  { t: pb.windowStart, o: pb.futO,  h: pb.futH,  l: pb.futL,  c: pb.futC  });
          tmaAccumulate(tmaFold.spot, { t: pb.windowStart, o: pb.spotO, h: pb.spotH, l: pb.spotL, c: pb.spotC });
          if (!isNaN(pb.futC)) {
            prevRsiCloses.current = [...prevRsiCloses.current, pb.futC].slice(-50);
          }
          if (!isNaN(pb.futH)) swHighRef.current = Math.max(swHighRef.current, pb.futH);
          if (!isNaN(pb.futL)) swLowRef.current  = Math.min(swLowRef.current,  pb.futL);
        }

        if (dash.rows.length === 0) {
          console.log(`[Module1/Data] ✓ First candle created — futLtp=${futLtp} ceLtp=${ceLtp} peLtp=${peLtp} t=${new Date(windowStart).toISOString()}`);
        }

        const sLtp = spotLtp ?? futLtp;
        const ceN  = ceLtp ?? NaN;
        const peN  = peLtp ?? NaN;
        barRef.current = {
          callO: ceN, callH: ceN, callL: ceN, callC: ceN,
          putO:  peN, putH:  peN, putL:  peN, putC:  peN,
          futO:  futLtp, futH: futLtp, futL:  futLtp, futC:  futLtp,
          spotO: sLtp,   spotH: sLtp,  spotL: sLtp,   spotC: sLtp,
          futVolume: liveFutVolumeRef.current,
          windowStart,
        };

        const callBar: OHLCBar = { t: windowStart, o: ceN, h: ceN, l: ceN, c: ceN };
        const putBar:  OHLCBar = { t: windowStart, o: peN, h: peN, l: peN, c: peN };
        const futBar:  OHLCBar = futFresh  ? { t: windowStart, o: futLtp, h: futLtp, l: futLtp, c: futLtp } : MISSING_BAR(windowStart);
        const spotBar: OHLCBar = spotFresh ? { t: windowStart, o: sLtp,   h: sLtp,   l: sLtp,   c: sLtp   } : MISSING_BAR(windowStart);

        const sessHigh = Math.max(swHighRef.current, futLtp);
        const sessLow  = Math.min(swLowRef.current,  futLtp);

        const cMMA = mmaBar(callBar);
        const pMMA = mmaBar(putBar);
        const fMMA = mmaBar(futBar);
        const sMMA = mmaBar(spotBar);
        const tmaSt = tmaStatesRef.current;
        const cTMA = tmaValue(tmaSt.call, callBar);
        const pTMA = tmaValue(tmaSt.put,  putBar);
        const fTMA = tmaValue(tmaSt.fut,  futBar);
        const sTMA = tmaValue(tmaSt.spot, spotBar);
        const { value: rankVal, winner: rankWin } = computeRanking(cMMA, pMMA);

        const rsiSer = computeRsiSeries([...prevRsiCloses.current, futLtp]);
        const rsi    = rsiSer[rsiSer.length - 1] ?? null;
        const k2     = 2 / (20 + 1);
        const ema    = prevEmaRef.current !== null ? sLtp * k2 + prevEmaRef.current * (1 - k2) : null;
        const k200   = 2 / (200 + 1);
        const ema200 = prevEma200Ref.current !== null ? sLtp * k200 + prevEma200Ref.current * (1 - k200) : null;
        const liveTp  = futFresh ? (futBar.h + futBar.l + futBar.c) / 3 : null;
        const liveVol = liveTp !== null ? liveFutVolumeRef.current : 0;
        const vwapCumV = vwapStateRef.current.cumV + liveVol;
        const vwap = vwapCumV > 0
          ? (vwapStateRef.current.cumTPV + (liveTp ?? 0) * liveVol) / vwapCumV
          : null;
        const emaScoreVal   = compareScore(ema, ema200);
        const vwapScoreVal  = compareScore(vwap, ema);
        const totalScoreVal = totalScoreFromParts(emaScoreVal, vwapScoreVal);
        const ratingVal     = ratingFromTotalScore(totalScoreVal);

        dash.appendRow({
          t: windowStart,
          call: callBar, put: putBar, future: futBar, spot: spotBar,
          callMMA: cMMA,   callTMA: cTMA,
          putMMA:  pMMA,   putTMA:  pTMA,
          futureMMA: fMMA, futureTMA: fTMA,
          spotMMA:   sMMA, spotTMA:   sTMA,
          ranking: rankVal, rankingWinner: rankWin,
          oiMatrix: { ...oi },
          smc: smcNearest(futLtp, sessHigh, sessLow, sessHigh, sessLow),
          fib: nearestFibLabel(futLtp, sessHigh, sessLow) ?? "—",
          rsi, ema, vwap,
          ema200, emaScore: emaScoreVal, vwapScore: vwapScoreVal, totalScore: totalScoreVal,
          rating: ratingVal, signal: signalFromRating(ratingVal),
        });

      } else {
        const b = barRef.current;
        if (ceLtp !== null) {
          b.callH = isNaN(b.callH) ? ceLtp : Math.max(b.callH, ceLtp);
          b.callL = isNaN(b.callL) ? ceLtp : Math.min(b.callL, ceLtp);
          if (isNaN(b.callO)) b.callO = ceLtp;
          b.callC = ceLtp;
        }
        if (peLtp !== null) {
          b.putH = isNaN(b.putH) ? peLtp : Math.max(b.putH, peLtp);
          b.putL = isNaN(b.putL) ? peLtp : Math.min(b.putL, peLtp);
          if (isNaN(b.putO)) b.putO = peLtp;
          b.putC = peLtp;
        }
        b.futH  = Math.max(b.futH,  futLtp);
        b.futL  = Math.min(b.futL,  futLtp);
        b.futC  = futLtp;
        b.futVolume = liveFutVolumeRef.current;
        const sLtp = spotLtp ?? futLtp;
        b.spotH = Math.max(b.spotH, sLtp);
        b.spotL = Math.min(b.spotL, sLtp);
        b.spotC = sLtp;

        const callBar: OHLCBar = { t: b.windowStart, o: b.callO, h: b.callH, l: b.callL, c: b.callC };
        const putBar:  OHLCBar = { t: b.windowStart, o: b.putO,  h: b.putH,  l: b.putL,  c: b.putC  };
        const futBar:  OHLCBar = futFresh  ? { t: b.windowStart, o: b.futO,  h: b.futH,  l: b.futL,  c: b.futC  } : MISSING_BAR(b.windowStart);
        const spotBar: OHLCBar = spotFresh ? { t: b.windowStart, o: b.spotO, h: b.spotH, l: b.spotL, c: b.spotC } : MISSING_BAR(b.windowStart);

        const sessHigh = Math.max(swHighRef.current, b.futH);
        const sessLow  = Math.min(swLowRef.current,  b.futL);

        const cMMA = mmaBar(callBar);
        const pMMA = mmaBar(putBar);
        const fMMA = mmaBar(futBar);
        const sMMA = mmaBar(spotBar);
        const tmaSt = tmaStatesRef.current;
        const cTMA = tmaValue(tmaSt.call, callBar);
        const pTMA = tmaValue(tmaSt.put,  putBar);
        const fTMA = tmaValue(tmaSt.fut,  futBar);
        const sTMA = tmaValue(tmaSt.spot, spotBar);
        const { value: rankVal, winner: rankWin } = computeRanking(cMMA, pMMA);

        const rsiSer = computeRsiSeries([...prevRsiCloses.current, futLtp]);
        const rsi    = rsiSer[rsiSer.length - 1] ?? null;
        const k2     = 2 / (20 + 1);
        const ema    = prevEmaRef.current !== null ? sLtp * k2 + prevEmaRef.current * (1 - k2) : null;
        const k200   = 2 / (200 + 1);
        const ema200 = prevEma200Ref.current !== null ? sLtp * k200 + prevEma200Ref.current * (1 - k200) : null;
        const liveTp  = futFresh ? (futBar.h + futBar.l + futBar.c) / 3 : null;
        const liveVol = liveTp !== null ? liveFutVolumeRef.current : 0;
        const vwapCumV = vwapStateRef.current.cumV + liveVol;
        const vwap = vwapCumV > 0
          ? (vwapStateRef.current.cumTPV + (liveTp ?? 0) * liveVol) / vwapCumV
          : null;
        const emaScoreVal   = compareScore(ema, ema200);
        const vwapScoreVal  = compareScore(vwap, ema);
        const totalScoreVal = totalScoreFromParts(emaScoreVal, vwapScoreVal);
        const ratingVal     = ratingFromTotalScore(totalScoreVal);

        dash.updateLatestRow({
          call: callBar, put: putBar, future: futBar, spot: spotBar,
          callMMA: cMMA,   callTMA: cTMA,
          putMMA:  pMMA,   putTMA:  pTMA,
          futureMMA: fMMA, futureTMA: fTMA,
          spotMMA:   sMMA, spotTMA:   sTMA,
          ranking: rankVal, rankingWinner: rankWin,
          oiMatrix: { ...oi },
          smc: smcNearest(futLtp, sessHigh, sessLow, sessHigh, sessLow),
          fib: nearestFibLabel(futLtp, sessHigh, sessLow) ?? "—",
          rsi, ema, vwap,
          ema200, emaScore: emaScoreVal, vwapScore: vwapScoreVal, totalScore: totalScoreVal,
          rating: ratingVal, signal: signalFromRating(ratingVal),
        });

        if (spotLtp != null) dash.setLivePrices(spotLtp, futLtp);
      }
    }, 500);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerated, timeframe]);

  // Effect 3: automatic end-of-day Excel export.
  useEffect(() => {
    if (!isGenerated) return;

    const tryAutoExport = () => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata", hour12: false,
        weekday: "short", hour: "numeric", minute: "numeric",
      }).formatToParts(new Date());
      const partMap: Record<string, string> = {};
      parts.forEach(p => { partMap[p.type] = p.value; });
      if (partMap.weekday === "Sat" || partMap.weekday === "Sun") return;

      const minutesNow = parseInt(partMap.hour, 10) * 60 + parseInt(partMap.minute, 10);
      const MARKET_CLOSE_MIN = 15 * 60 + 45; // 3:45 PM IST
      if (minutesNow < MARKET_CLOSE_MIN) return;

      const flagKey = scopedKey(`m1_eod_export_${istDateStr()}`);
      try {
        if (localStorage.getItem(flagKey) === "1") return;
      } catch { return; }

      const dash = useDashStore.getState();
      if (dash.rows.length === 0) return;

      const exported = exportModule1Excel({
        rows: dash.rows, hiddenCols: dash.hiddenCols, colOrder: dash.colOrder,
        type: dash.type, instrument: dash.instrument, timeframe: dash.timeframe,
        pivotMethod: dash.pivotMethod,
        callStrike: dash.callStrike, putStrike: dash.putStrike,
      });
      if (exported) {
        try { localStorage.setItem(flagKey, "1"); } catch { /* noop */ }
      }
    };

    tryAutoExport();
    const timer = setInterval(tryAutoExport, 60000);
    return () => clearInterval(timer);
  }, [isGenerated]);

  const worksheetFeedStatus: "idle" | "live" | "interrupted" =
    feedStatus === "live"        ? "live"        :
    feedStatus === "interrupted" ? "interrupted" : "idle";

  const statusPanelKey: string | null =
    !isGenerated ? null :
    timeframe === "custom" && !customRange ? "custom-pending" :
    feedStatus === "auth-error"         ? "auth-error"         :
    feedStatus === "session-expired"    ? "session-expired"    :
    feedStatus === "broker-disconnected" && rows.length === 0 ? "broker-disconnected":
    (feedStatus === "reconnecting" || feedStatus === "no-network" || feedStatus === "api-error") && rows.length === 0 ? feedStatus : null;

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "calc(100vh - 60px)", width: "100%",
      background: "#FFFFFF",
      fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
      overflow: "hidden",
    }}>
      <InfoBar />
      {feedStatus === "market-closed" && (
        <div style={{
          background: "#FEF2F2",
          borderBottom: "1px solid #FCA5A5",
          color: "#991B1B",
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: "'Calibri','Segoe UI',system-ui,sans-serif",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>🔴</span>
            <div>
              <span style={{ fontSize: 20, marginLeft: 12, opacity: 0.9, fontWeight:800 }}>MARKET CLOSED</span>
              <span style={{ fontSize: 20, marginLeft: 12, opacity: 0.9, fontWeight:800 }}>
                Monday–Friday: Live market updates have stopped. Displaying {istDateStr()} stored market session data (9:15 AM – 3:30 PM IST).
              </span>
            </div>
          </div>
        </div>
      )}
      <ConfigRow />
      <TimeframeRow />
      {statusPanelKey ? (
        <StatusPanel status={statusPanelKey} onRetry={bumpReloadKey} />
      ) : (
        <Worksheet
          rows={rows}
          hiddenCols={hiddenCols}
          colOrder={colOrder}
          feedStatus={worksheetFeedStatus}
          isLoading={isLoading}
          type={type}
          pivotMethod={pivotMethod}
        />
      )}
    </div>
  );
}

export default Dashboard;
