import { create } from "zustand";
import {
  UserSession,
  Module2SessionData,
  Module2Cell,
  Module2StrikeState
} from "@stock/shared";

// ── Module 1 types (not in @stock/shared) ─────────────────────────────────────

export type OiSignal = "STRONG_BULL" | "MILD_BULL" | "NEUTRAL" | "MILD_BEAR" | "STRONG_BEAR" | "DIVERGENCE";

export interface Module1OiMetrics {
  timestamp: string;
  dataSource: "LIVE_MARKET_API" | "SIMULATOR";
  tin: number;
  c_tl: number; c_mn: number; c_hig: number; c_low: number;
  c_buy: number; c_sell: number;
  f_buy: number; f_sell: number;
  p_tl: number; p_mn: number; p_hig: number; p_low: number;
  p_buy: number; p_sell: number;
  callSignal: OiSignal;
  putSignal: OiSignal;
}

export interface Module1IndicatorState {
  symbol: string;
  callState: string;
  putState: string;
  divergencePct: number;
  hasDivergenceWarning: boolean;
}

interface AppState {
  // Authentication State
  user: UserSession | null;
  accessToken: string | null;
  setAuth: (user: UserSession | null, token: string | null) => void;
  clearAuth: () => void;
  clearAppAuth: () => void;

  // Module 1: OI matrix + indicator state + indicator room
  oiMetrics: Module1OiMetrics | null;
  setOiMetrics: (m: Module1OiMetrics) => void;
  module1IndicatorState: Module1IndicatorState | null;
  setModule1IndicatorState: (i: Module1IndicatorState) => void;
  module1IndicatorRoom: string | null;
  setModule1IndicatorRoom: (room: string | null) => void;

  // Module-level authentication tokens (sessionStorage-persisted)
  module1Token: string | null;
  module2Token: string | null;
  setModule1Token: (token: string | null) => void;
  setModule2Token: (token: string | null) => void;

  // Module connection status
  module1Status: "idle" | "authenticating" | "authenticated" | "error";
  module2Status: "idle" | "authenticating" | "authenticated" | "error";
  module1Error: string | null;
  module2Error: string | null;
  setModule1Status: (status: "idle" | "authenticating" | "authenticated" | "error", error?: string | null) => void;
  setModule2Status: (status: "idle" | "authenticating" | "authenticated" | "error", error?: string | null) => void;

  // Module 2 live broker connection state (set by broker_status socket events)
  module2BrokerStatus: "live" | "broker-disconnected" | "session-expired" | "reconnecting" | null;
  setModule2BrokerStatus: (status: "live" | "broker-disconnected" | "session-expired" | "reconnecting" | null) => void;

  // Watchlist & Column Preferences State
  watchlist: string[];
  columnPrefs: Record<string, boolean>;
  setWatchlist: (symbols: string[]) => void;
  setColumnPrefs: (prefs: Record<string, boolean>) => void;

  // Module 1: selected instrument and timeframe
  selectedSymbol: string;
  selectedTimeframe: string;
  setSelectedSymbol: (symbol: string) => void;
  setSelectedTimeframe: (tf: string) => void;

  // Live Pricing Feed Cache (populated by WebSocket ticks)
  prices: Record<string, { ltp: number; lastUpdated: Date }>;
  updatePrice: (symbol: string, ltp: number) => void;

  // Market readiness flag — set true when first valid NIFTY-FUT tick is confirmed by backend
  marketDataReady: boolean;
  setMarketDataReady: (ready: boolean) => void;

  // Module 2 Tracker Session State
  activeSession: Module2SessionData | null;
  setActiveSession: (session: Module2SessionData | null) => void;
  updateSessionStrikes: (strikes: string[]) => void;
  appendTrackerCell: (strike: string, cell: Module2Cell | null, stateUpdate: Partial<Module2StrikeState>) => void;
  updateFuturesOI: (futuresOI: any) => void;
}

export const useStore = create<AppState>((set) => ({
  // Authentication State
  user: null,
  accessToken: null,
  setAuth: (user, token) => set({ user, accessToken: token }),
  clearAuth: () => {
    sessionStorage.removeItem("m1_token");
    sessionStorage.removeItem("m2_token");
    set({
      user: null,
      accessToken: null,
      activeSession: null,
      module1Token: null,
      module2Token: null,
      module1Status: "idle",
      module2Status: "idle",
      module1Error: null,
      module2Error: null,
      marketDataReady: false,
      prices: {},
    });
  },
  clearAppAuth: () => {
    set({ user: null, accessToken: null, activeSession: null });
  },

  // Module 1: OI metrics + indicator state
  oiMetrics: null,
  setOiMetrics: (m) => set({ oiMetrics: m }),
  module1IndicatorState: null,
  setModule1IndicatorState: (i) => set({ module1IndicatorState: i }),
  module1IndicatorRoom: null,
  setModule1IndicatorRoom: (room) => set({ module1IndicatorRoom: room }),

  // Module token state
  module1Token: sessionStorage.getItem("m1_token") || null,
  module2Token: sessionStorage.getItem("m2_token") || null,
  setModule1Token: (token) => {
    if (token) sessionStorage.setItem("m1_token", token);
    else sessionStorage.removeItem("m1_token");
    set({ module1Token: token });
  },
  setModule2Token: (token) => {
    if (token) sessionStorage.setItem("m2_token", token);
    else sessionStorage.removeItem("m2_token");
    set({ module2Token: token });
  },

  // Module connection status
  module1Status: "idle",
  module2Status: "idle",
  module1Error: null,
  module2Error: null,
  setModule1Status: (status, error = null) => set({ module1Status: status, module1Error: error }),
  setModule2Status: (status, error = null) => set({ module2Status: status, module2Error: error }),

  module2BrokerStatus: null,
  setModule2BrokerStatus: (status) => set({ module2BrokerStatus: status }),

  // Watchlist State
  watchlist: ["NIFTY-SPOT", "NIFTY-FUT"],
  columnPrefs: {},
  setWatchlist: (symbols) => set({ watchlist: symbols }),
  setColumnPrefs: (prefs) => set({ columnPrefs: prefs }),

  // Module 1: selected instrument and timeframe
  selectedSymbol: "NIFTY-FUT",
  selectedTimeframe: "5m",
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
  setSelectedTimeframe: (tf) => set({ selectedTimeframe: tf }),

  // Live Price Cache
  prices: {},
  updatePrice: (symbol, ltp) =>
    set((state) => ({
      prices: {
        ...state.prices,
        [symbol]: { ltp, lastUpdated: new Date() }
      }
    })),

  // Market readiness
  marketDataReady: false,
  setMarketDataReady: (ready) => set({ marketDataReady: ready }),

  // Module 2 Session State
  activeSession: null,
  setActiveSession: (session) => set({ activeSession: session }),
  updateSessionStrikes: (strikes) =>
    set((state) => {
      if (!state.activeSession) return {};
      return {
        activeSession: {
          ...state.activeSession,
          selectedStrikes: strikes
        }
      };
    }),
  appendTrackerCell: (strike, cell, stateUpdate) =>
    set((state) => {
      if (!state.activeSession) return {};

      const currentStrikeState = state.activeSession.strikes?.[strike] || {
        strike,
        dayOpen: (stateUpdate as any)?.dayOpen || (stateUpdate as any)?.ltp || 0,
        dayHigh: (stateUpdate as any)?.dayHigh || 0,
        dayLow: (stateUpdate as any)?.dayLow || 0,
        grid: [],
        trendBadge: "FLAT",
        isDowntrendActive: false,
        isDeepLoss: false,
        pctChange: 0
      };
      const gridCopy = [...(currentStrikeState.grid || [])];

      if (cell) {
        const existingCellIdx = gridCopy.findIndex((c) => c.minute === cell.minute || c.timestamp === cell.timestamp);
        if (existingCellIdx >= 0) {
          gridCopy[existingCellIdx] = {
            ...gridCopy[existingCellIdx],
            ...cell
          };
        } else {
          gridCopy.push(cell);
        }
      }

      if (stateUpdate && (stateUpdate as any).ltp && gridCopy.length > 0) {
        const latestCell = gridCopy[gridCopy.length - 1];
        gridCopy[gridCopy.length - 1] = {
          ...latestCell,
          ltp: (stateUpdate as any).ltp,
          isHigh: (stateUpdate as any).dayHigh ? (stateUpdate as any).ltp === (stateUpdate as any).dayHigh : latestCell.isHigh,
          isLow: (stateUpdate as any).dayLow ? (stateUpdate as any).ltp === (stateUpdate as any).dayLow : latestCell.isLow
        };
      }

      const updatedStrikeState: Module2StrikeState = {
        ...currentStrikeState,
        ...stateUpdate,
        grid: gridCopy
      };

      return {
        activeSession: {
          ...state.activeSession,
          strikes: {
            ...state.activeSession.strikes,
            [strike]: updatedStrikeState
          }
        }
      };
    }),
  updateFuturesOI: (futuresOI) =>
    set((state) => {
      if (!state.activeSession) return {};
      return {
        activeSession: {
          ...state.activeSession,
          futuresOI: {
            ...state.activeSession.futuresOI,
            ...futuresOI
          }
        }
      };
    })
}));
