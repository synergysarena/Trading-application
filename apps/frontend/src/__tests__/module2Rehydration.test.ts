import { describe, it, expect, beforeEach } from "vitest";
import {
  floorToMinuteMs,
  getCanonicalMinuteDate,
  normalizeCandleTimestamp,
  Module2SessionData,
  Module2StrikeState,
} from "@stock/shared";
import { useStore } from "../store/useStore";

const strikeState = (strike: string, ltps: number[]): Module2StrikeState => ({
  strike,
  dayOpen: ltps[0] ?? 0,
  dayHigh: Math.max(0, ...ltps),
  dayLow: ltps.length ? Math.min(...ltps) : 0,
  grid: ltps.map((ltp, i) => ({
    ltp,
    minute: i,
    timestamp: `09:${String(30 + i).padStart(2, "0")}`,
    isHigh: false,
    isLow: false,
    oi: 0,
    oiDelta: 0,
    oiBuy: 0,
    oiSell: 0,
  })),
  trendBadge: "FLAT",
  isDowntrendActive: false,
  isDeepLoss: false,
  pctChange: 0,
});

const session = (id: string, strikes: Record<string, Module2StrikeState>): Module2SessionData => ({
  sessionId: id,
  userId: "u1",
  sessionType: "CE",
  indexSymbol: "NIFTY50",
  expiryDate: "2026-09-11",
  selectedStrikes: Object.keys(strikes),
  dayOpenPrices: {},
  strikes,
  status: "ACTIVE",
  createdAt: new Date(),
});

describe("PHASE A — canonical minute timestamp", () => {
  it("floors any instant in a minute to a single UTC minute boundary", () => {
    const a = getCanonicalMinuteDate(Date.parse("2026-09-08T10:30:00.001Z")).getTime();
    const b = getCanonicalMinuteDate(Date.parse("2026-09-08T10:30:59.999Z")).getTime();
    expect(a).toBe(b);
    expect(a).toBe(Date.parse("2026-09-08T10:30:00.000Z"));
  });

  it("normalizeCandleTimestamp exposes minuteStartMs equal to floorToMinuteMs", () => {
    const ts = Date.parse("2026-09-08T13:44:29.500Z");
    expect(normalizeCandleTimestamp(ts).minuteStartMs).toBe(floorToMinuteMs(ts));
    expect(new Date(floorToMinuteMs(ts)).getUTCSeconds()).toBe(0);
  });
});

describe("PHASE F — hydrateActiveSession (browser refresh / reconnect)", () => {
  beforeEach(() => {
    useStore.setState({ activeSession: null });
  });

  it("restores a session when none is loaded", () => {
    const s = session("sess-1", { NIFTY24800CE: strikeState("NIFTY24800CE", [10, 11, 12]) });
    useStore.getState().hydrateActiveSession(s);
    expect(useStore.getState().activeSession?.sessionId).toBe("sess-1");
    expect(useStore.getState().activeSession?.strikes.NIFTY24800CE.grid.length).toBe(3);
  });

  it("ignores null (does not wipe an existing session)", () => {
    const s = session("sess-1", { NIFTY24800CE: strikeState("NIFTY24800CE", [10]) });
    useStore.setState({ activeSession: s });
    useStore.getState().hydrateActiveSession(null);
    expect(useStore.getState().activeSession?.sessionId).toBe("sess-1");
  });

  it("does not clobber a longer live grid with a shorter server snapshot", () => {
    const live = session("sess-1", { NIFTY24800CE: strikeState("NIFTY24800CE", [10, 11, 12, 13, 14]) });
    useStore.setState({ activeSession: live });
    const serverSnapshot = session("sess-1", { NIFTY24800CE: strikeState("NIFTY24800CE", [10, 11]) });
    useStore.getState().hydrateActiveSession(serverSnapshot);
    expect(useStore.getState().activeSession?.strikes.NIFTY24800CE.grid.length).toBe(5);
  });

  it("adopts a fuller server grid when the live grid is behind (post-restart recovery)", () => {
    const live = session("sess-1", { NIFTY24800CE: strikeState("NIFTY24800CE", [10]) });
    useStore.setState({ activeSession: live });
    const recovered = session("sess-1", { NIFTY24800CE: strikeState("NIFTY24800CE", [10, 11, 12, 13]) });
    useStore.getState().hydrateActiveSession(recovered);
    expect(useStore.getState().activeSession?.strikes.NIFTY24800CE.grid.length).toBe(4);
  });

  it("replaces outright when the session id differs", () => {
    useStore.setState({ activeSession: session("old", { A: strikeState("A", [1, 2, 3]) }) });
    useStore.getState().hydrateActiveSession(session("new", { B: strikeState("B", [9]) }));
    expect(useStore.getState().activeSession?.sessionId).toBe("new");
    expect(useStore.getState().activeSession?.strikes.B).toBeTruthy();
    expect(useStore.getState().activeSession?.strikes.A).toBeUndefined();
  });
});
