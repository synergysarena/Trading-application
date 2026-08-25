import { create } from "zustand";
import type { DashboardRow, PivotMethod } from "../../calc";
import { useStore } from "../../store/useStore";

export type { PivotMethod };
export type FeedStatus =
  | "idle"
  | "connecting"
  | "live"
  | "interrupted"
  | "market-closed"
  | "auth-error"
  | "api-error"
  | "no-network"
  | "broker-disconnected"
  | "session-expired"
  | "reconnecting";

interface DashboardStore {
  // Config selection — dependent chain:
  // Exchange → Instrument (type) → Symbol → Expiry Date → Strikes
  /** Broker-provided exchange, e.g. "NFO" — sourced live from the instrument
   *  master via fetchExchanges(), never hardcoded. See ../../data/liveApi.ts. */
  exchange: string;
  /** Instrument type, e.g. "OPTIDX" — sourced live from the instrument master
   *  via fetchInstrumentTypes(exchange), never hardcoded. */
  instrumentType: string;
  /** Underlying symbol, e.g. "NIFTY" */
  instrument: string;
  type: "Call" | "Put" | "Call+Put";
  callStrike: number | null;
  putStrike:  number | null;
  /** Expiry stored internally as ISO "YYYY-MM-DD"; formatted for display only */
  expiryDate: string;

  // Generated
  isGenerated:     boolean;
  generateKey:     number;
  /** Bumped to force Effect 1 (history fetch + live-bar rebuild) in Dashboard
   *  to re-run without changing any config — used by both the manual Retry
   *  button and automatic recovery (socket reconnect / broker back online /
   *  periodic retry while in an error state). See index.tsx. */
  reloadKey:       number;
  bumpReloadKey(): void;
  timeframe:       string;
  customRange:     { from: string; to: string; candleTf: string } | null;
  pivotMethod:     PivotMethod;
  configCollapsed: boolean;

  // Live data
  rows:       DashboardRow[];
  feedStatus: FeedStatus;
  spotLtp:    number | null;
  futureLtp:  number | null;
  spotDir:    "up" | "down" | null;
  futureDir:  "up" | "down" | null;

  // Column preferences
  hiddenCols: string[];
  colOrder:   string[];

  // Actions
  setExchange(v: string): void;
  setInstrumentType(v: string): void;
  setInstrument(v: string): void;
  setType(v: "Call" | "Put" | "Call+Put"): void;
  setCallStrike(v: number | null): void;
  setPutStrike(v: number | null): void;
  setExpiryDate(v: string): void;
  generate(): void;
  reset(): void;
  clearRows(): void;
  setTimeframe(tf: string): void;
  setCustomRange(r: { from: string; to: string; candleTf: string } | null): void;
  setPivotMethod(m: PivotMethod): void;
  toggleConfigCollapsed(): void;
  appendRow(row: DashboardRow): void;
  updateLatestRow(partial: Partial<DashboardRow>): void;
  setFeedStatus(s: FeedStatus): void;
  setLivePrices(spot: number, future: number): void;
  toggleColumn(id: string): void;
  setColOrder(order: string[]): void;
  rehydratePrefs(userId: string): void;
}

const savedHidden = (): string[] => {
  try { return JSON.parse(localStorage.getItem("m1_cols") ?? "[]"); }
  catch { return []; }
};

const savedPivot = (): PivotMethod => {
  try { return (localStorage.getItem("m1_pivot") ?? "client") as PivotMethod; }
  catch { return "client"; }
};

const getUserId = (): string | undefined =>
  useStore.getState().user?.id as string | undefined;

export const scopedKey = (base: string) => {
  const uid = getUserId();
  return uid ? `${base}_${uid}` : base;
};

export const useDashStore = create<DashboardStore>((set, get) => ({
  exchange: "",
  instrumentType: "", instrument: "",
  type: "Call+Put",
  callStrike: null, putStrike: null,
  expiryDate: "",
  isGenerated: false,
  generateKey: 0,
  reloadKey: 0,
  timeframe: "5m", customRange: null, pivotMethod: savedPivot(), configCollapsed: false,
  rows: [], feedStatus: "idle",
  spotLtp: null, futureLtp: null, spotDir: null, futureDir: null,
  hiddenCols: savedHidden(),
  colOrder: [],

  // Changing a parent selection resets every dependent selection below it.
  setExchange: (v) => set({ exchange: v, instrumentType: "", instrument: "", expiryDate: "", callStrike: null, putStrike: null }),
  setInstrumentType: (v) => set({ instrumentType: v, instrument: "", expiryDate: "", callStrike: null, putStrike: null }),
  setInstrument:     (v) => set({ instrument: v, expiryDate: "", callStrike: null, putStrike: null }),
  setType:           (v) => set({ type: v }),
  setCallStrike:    (v) => set({ callStrike: v }),
  setPutStrike:     (v) => set({ putStrike: v }),
  // Expiry change reloads strikes (ConfigRow prunes selections no longer valid)
  setExpiryDate:    (v) => set({ expiryDate: v }),
  generate:      ()  => set((s) => ({ isGenerated: true, rows: [], generateKey: s.generateKey + 1 })),
  bumpReloadKey: ()  => set((s) => ({ reloadKey: s.reloadKey + 1 })),
  reset:         ()  => set({ isGenerated: false, rows: [], feedStatus: "idle" }),
  clearRows:     ()  => set({ rows: [] }),
  setTimeframe:  (tf) => set({ timeframe: tf }),
  setCustomRange: (r) => set({ customRange: r }),

  setPivotMethod: (m) => {
    try { localStorage.setItem(scopedKey("m1_pivot"), m); } catch { /* noop */ }
    set({ pivotMethod: m });
  },

  toggleConfigCollapsed: () => set((s) => ({ configCollapsed: !s.configCollapsed })),

  appendRow: (row) => set((s) => {
    if (s.rows.length > 0 && s.rows[s.rows.length - 1].t === row.t) {
      console.warn(`[Dashboard] appendRow deduped t=${row.t} — already last row`);
      return {};
    }
    return { rows: [...s.rows, row] };
  }),

  updateLatestRow: (partial) => set((s) => {
    if (s.rows.length === 0) return {};
    const updated = [...s.rows];
    updated[updated.length - 1] = { ...updated[updated.length - 1], ...partial } as DashboardRow;
    return { rows: updated };
  }),

  setFeedStatus: (feedStatus) => set({ feedStatus }),

  setLivePrices: (spot, future) => set((s) => {
    const spotDir   = s.spotLtp   !== null ? (spot   > s.spotLtp   ? "up" : spot   < s.spotLtp   ? "down" : s.spotDir)   : null;
    const futureDir = s.futureLtp !== null ? (future > s.futureLtp ? "up" : future < s.futureLtp ? "down" : s.futureDir) : null;
    return { spotLtp: spot, futureLtp: future, spotDir, futureDir };
  }),

  toggleColumn: (id) => {
    const current = get().hiddenCols;
    const hidden  = current.includes(id) ? current.filter(c => c !== id) : [...current, id];
    try { localStorage.setItem(scopedKey("m1_cols"), JSON.stringify(hidden)); } catch { /* noop */ }
    set({ hiddenCols: hidden });
  },

  setColOrder: (order) => {
    try { localStorage.setItem(scopedKey("m1_col_order"), JSON.stringify(order)); } catch { /* noop */ }
    set({ colOrder: order });
  },

  rehydratePrefs: (userId: string) => {
    try {
      const colsKey  = `m1_cols_${userId}`;
      const pivotKey = `m1_pivot_${userId}`;
      const orderKey = `m1_col_order_${userId}`;
      // Fall back to unscoped keys for migration
      const savedCols  = JSON.parse(localStorage.getItem(colsKey)  ?? localStorage.getItem("m1_cols")  ?? "[]") as string[];
      const savedPiv   = (localStorage.getItem(pivotKey) ?? localStorage.getItem("m1_pivot") ?? "client") as PivotMethod;
      const savedOrder = JSON.parse(localStorage.getItem(orderKey) ?? "[]") as string[];
      set({ hiddenCols: savedCols, pivotMethod: savedPiv, colOrder: savedOrder });
    } catch { /* noop */ }
  },
}));
