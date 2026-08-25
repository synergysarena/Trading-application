import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { useStore } from "../store/useStore";
import { useDashStore } from "../modules/dashboard/store";
import { Tick, Module2Cell, Module2StrikeState } from "@stock/shared";
import type { Module1OiMetrics, Module1IndicatorState } from "../store/useStore";
import { formatExpiryForBroker } from "../data/models";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || "";

function parseIndicatorRoom(room: string): { symbol: string; timeframe: string; method: string } | null {
  const parts = room.split(":");
  if (parts.length < 4) return null;
  return { symbol: parts[1], timeframe: parts[2], method: parts[3] };
}

export const useSocket = () => {
  const socketRef = useRef<Socket | null>(null);

  const accessToken        = useStore((s) => s.accessToken);
  const updatePrice        = useStore((s) => s.updatePrice);
  const appendTrackerCell  = useStore((s) => s.appendTrackerCell);
  const updateFuturesOI    = useStore((s) => s.updateFuturesOI);
  const setOiMetrics       = useStore((s) => s.setOiMetrics);
  const setModule1IndicatorState = useStore((s) => s.setModule1IndicatorState);
  const setMarketDataReady = useStore((s) => s.setMarketDataReady);

  const selectedSymbol     = useStore((s) => s.selectedSymbol);
  const activeSessionId    = useStore((s) => s.activeSession?.sessionId);
  const module1IndicatorRoom = useStore((s) => s.module1IndicatorRoom);

  const prevIndicatorRoomRef  = useRef<string | null>(null);
  const prevOptionSymsRef     = useRef<string[]>([]);

  // Derive CE/PE option symbols from dash config whenever isGenerated.
  const dashIsGenerated  = useDashStore((s) => s.isGenerated);
  const dashInstrument   = useDashStore((s) => s.instrument);
  const dashExpiryDate   = useDashStore((s) => s.expiryDate);
  const dashCallStrike   = useDashStore((s) => s.callStrike);
  const dashPutStrike    = useDashStore((s) => s.putStrike);
  const dashType         = useDashStore((s) => s.type);

  const expiryFmt        = formatExpiryForBroker(dashExpiryDate);
  const liveOptionSymbols: string[] = dashIsGenerated && expiryFmt ? [
    ...(dashType !== "Put"  && dashCallStrike ? [`${dashInstrument}${expiryFmt}C${dashCallStrike}`] : []),
    ...(dashType !== "Call" && dashPutStrike  ? [`${dashInstrument}${expiryFmt}P${dashPutStrike}`]  : []),
  ] : [];
  const liveOptionSymbolsKey = liveOptionSymbols.join(",");

  // ── Connect / disconnect on auth state change ──────────────────────────────
  useEffect(() => {
    if (!accessToken) {
      if (socketRef.current) {
        console.log("[Socket] Disconnecting — no access token");
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      return;
    }

    // Reuse existing alive socket if token is unchanged
    if (socketRef.current && socketRef.current.connected) {
      return;
    }

    console.log("[Socket] Initializing Module 1 socket (token present)...");
    const socketOpts = {
      auth: (cb: (data: object) => void) => {
        const currentToken = useStore.getState().accessToken || accessToken;
        cb({ token: currentToken });
      },
      transports: ["websocket", "polling"],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    };

    const socket = SOCKET_URL ? io(SOCKET_URL, socketOpts) : io(socketOpts);
    socketRef.current = socket;

    socket.on("connect", () => {
      const transportName = (socket.io?.engine?.transport?.name) || "unknown";
      console.log(`[Socket] Connected — ID: ${socket.id} (Transport: ${transportName})`);

      // Update dashboard status to live on successful (re)connect
      const dash = useDashStore.getState();
      if (
        dash.feedStatus === "reconnecting" ||
        dash.feedStatus === "no-network" ||
        dash.feedStatus === "api-error"
      ) {
        dash.bumpReloadKey();
      }

      // Always subscribe to core instruments for live Spot/Future display.
      // These are permanent — independent of Generate or any config selection.
      socket.emit("join:symbol", "NIFTY-SPOT");
      socket.emit("join:symbol", "NIFTY-FUT");
      console.log("[Socket] Subscribed to core symbols (NIFTY-SPOT, NIFTY-FUT)");

      // Re-subscribe to all active rooms on reconnect
      const currentSelectedSymbol = useStore.getState().selectedSymbol;
      if (currentSelectedSymbol) {
        socket.emit("join:symbol", currentSelectedSymbol);
      }

      const currentActiveSessionId = useStore.getState().activeSession?.sessionId;
      if (currentActiveSessionId) {
        socket.emit("join:tracker", currentActiveSessionId);
      }

      // Re-request on-demand option token subscription too — a reconnect means the
      // backend's broker connection may have restarted, so its runtime CE/PE subscriptions
      // need to be re-established, not just the frontend's socket room membership.
      const dashCfg = useDashStore.getState();
      if (dashCfg.isGenerated && dashCfg.expiryDate && (dashCfg.callStrike || dashCfg.putStrike)) {
        const exFmt = formatExpiryForBroker(dashCfg.expiryDate);

        if (dashCfg.type !== "Put" && dashCfg.callStrike) {
          socket.emit("join:symbol", `${dashCfg.instrument}${exFmt}C${dashCfg.callStrike}`);
        }
        if (dashCfg.type !== "Call" && dashCfg.putStrike) {
          socket.emit("join:symbol", `${dashCfg.instrument}${exFmt}P${dashCfg.putStrike}`);
        }

        socket.emit("subscribe:options", {
          instrument: dashCfg.instrument,
          expiry: exFmt,
          callStrike: dashCfg.type !== "Put" ? dashCfg.callStrike : null,
          putStrike: dashCfg.type !== "Call" ? dashCfg.putStrike : null,
          type: dashCfg.type,
        });
        console.log("[Socket] Module 1 option subscriptions restored on (re)connect");
      }

      const room = useStore.getState().module1IndicatorRoom;
      if (room) {
        const parsed = parseIndicatorRoom(room);
        if (parsed) socket.emit("join:indicators", parsed);
      }
    });

    socket.on("connect_error", (err) => {
      console.warn(`[Socket] Connection error: ${err.message}`);
    });

    socket.on("reconnect_attempt", (attempt) => {
      console.log(`[Socket] Reconnecting: attempt #${attempt}...`);
    });

    socket.on("reconnect", (attempt) => {
      console.log(`[Socket] Reconnected successfully after ${attempt} attempts.`);
    });

    socket.on("disconnect", (reason) => {
      console.log(`[Socket] Disconnected — reason: ${reason}`);
      // Only update to no-network for transport-level disconnects
      if (reason === "transport close" || reason === "transport error" || reason === "ping timeout") {
        const dash = useDashStore.getState();
        if (dash.feedStatus === "live") {
          useDashStore.getState().setFeedStatus("no-network");
        }
      }
    });

    // Raw price ticks → price cache
    socket.on("tick", (tick: Tick) => {
      updatePrice(tick.symbol, tick.ltp);
    });

    // Market readiness confirmation from backend — emitted after first valid NIFTY-FUT tick.
    // On receipt, the frontend knows all readiness conditions are met and can auto-generate.
    socket.on("market_ready", (data: { ltp: number; symbol: string; timestamp: string }) => {
      console.log(
        `[Socket] ✓ market_ready received — symbol=${data.symbol} ltp=${data.ltp} ts=${data.timestamp}`
      );
      setMarketDataReady(true);
    });

    // Module 1 OI matrix
    socket.on("latest-oi", (data: Module1OiMetrics) => {
      setOiMetrics(data);
    });

    // Module 1 indicator state
    socket.on("indicators", (data: Module1IndicatorState) => {
      setModule1IndicatorState(data);
    });

    // Module 2 tracker updates
    socket.on(
      "tracker_update",
      (data: { strike?: string; cell?: Module2Cell | null; state?: Partial<Module2StrikeState>; futuresOI?: any }) => {
        if (data.strike && data.state) {
          appendTrackerCell(data.strike, data.cell || null, data.state);
        }
        if (data.futuresOI) {
          updateFuturesOI(data.futuresOI);
        }
      }
    );

    // Broker connection status from backend.
    // moduleId tells us which broker sent the event so we only update the
    // correct module. Without this guard, AETRAM reconnect loops overwrote
    // Module 1's dashboard feed status continuously, causing "API Error".
    socket.on("broker_status", (data: { status: string; moduleId?: string; detail?: string }) => {
      const mod = data.moduleId || "module1"; // legacy events default to module1
      console.log(`[Socket] broker_status[${mod}]:`, data.status, data.detail || "");

      // Module 2 (AETRAM) broker status
      if (mod === "module2") {
        const { setModule2BrokerStatus } = useStore.getState();
        const s = data.status as "live" | "broker-disconnected" | "session-expired" | "reconnecting";
        setModule2BrokerStatus(s === "live" ? null : s);
        return; // Do NOT touch Module 1 dashboard status
      }

      // Module 1 (Zebu) broker status → update dashboard feed status
      const dash = useDashStore.getState();
      switch (data.status) {
        case "live":
          if (dash.feedStatus === "idle") {
            // Nothing has been fetched yet (Generate hasn't run) — a plain
            // flag flip is enough, Effect 1 will do the real fetch once it does.
            dash.setFeedStatus("live");
          } else if (
            dash.feedStatus === "reconnecting" ||
            dash.feedStatus === "broker-disconnected" ||
            dash.feedStatus === "api-error" ||
            dash.feedStatus === "auth-error" ||
            dash.feedStatus === "no-network"
          ) {
            // Effect 1 already ran and either exited early (api-error/auth-error/
            // no-network — one bad point-in-time check) or was mid-fetch when the
            // connection dropped (reconnecting/broker-disconnected). A bare status
            // flip here would show "live" over whatever rows (none, or stale) Effect 1
            // last produced. bumpReloadKey re-runs the full history fetch + live-bar
            // rebuild — the same recovery the manual Retry button performs — so the
            // dashboard actually reloads data instead of just relabelling itself.
            dash.bumpReloadKey();
          }
          break;
        case "reconnecting":
          dash.setFeedStatus("reconnecting");
          break;
        case "broker-disconnected":
          dash.setFeedStatus("broker-disconnected");
          break;
        case "session-expired":
          dash.setFeedStatus("session-expired");
          break;
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [accessToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Join / leave selected instrument tick room ─────────────────────────────
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return;

    socket.emit("join:symbol", selectedSymbol);
    return () => {
      socket.emit("leave:symbol", selectedSymbol);
    };
  }, [selectedSymbol]);

  // ── Re-subscribe core instruments after any symbol change ──────────────────
  // The selectedSymbol cleanup above may have sent a leave for NIFTY-FUT if
  // the user changed away from it. Re-join both core symbols to ensure the
  // Spot/Future live display is never interrupted by config changes.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit("join:symbol", "NIFTY-SPOT");
    socket.emit("join:symbol", "NIFTY-FUT");
  }, [selectedSymbol]);

  // ── Join / leave Module 1 indicator room ──────────────────────────────────
  useEffect(() => {
    const socket = socketRef.current;
    const prev = prevIndicatorRoomRef.current;
    const next = module1IndicatorRoom;

    if (socket?.connected) {
      if (prev && prev !== next) {
        const parsed = parseIndicatorRoom(prev);
        if (parsed) socket.emit("leave:indicators", parsed);
      }
      if (next && next !== prev) {
        const parsed = parseIndicatorRoom(next);
        if (parsed) socket.emit("join:indicators", parsed);
      }
    }

    prevIndicatorRoomRef.current = next;
  }, [module1IndicatorRoom]);

  // ── Join / leave live option symbol rooms (CE / PE premium feed) ──────────
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket?.connected) return;

    const prev = prevOptionSymsRef.current;
    const next = liveOptionSymbols;

    prev.filter(s => !next.includes(s)).forEach(s => socket.emit("leave:symbol", s));
    next.filter(s => !prev.includes(s)).forEach(s => {
      socket.emit("join:symbol", s);
      console.log(`[Socket] Subscribed to option room: ${s}`);
    });

    // Ask the backend to resolve + subscribe these exact strikes on the live broker
    // connection, independent of whatever ATM band it picked at connect time. This is
    // the frontend half of the "Call/Put OHLC empty" fix — see REPORT_MODULE1_DATAPATH.md.
    if (next.length > 0) {
      socket.emit("subscribe:options", {
        instrument: dashInstrument,
        expiry: expiryFmt,
        callStrike: dashType !== "Put" ? dashCallStrike : null,
        putStrike: dashType !== "Call" ? dashPutStrike : null,
        type: dashType,
      });
      console.log(`[Socket] subscribe:options requested — ${next.join(", ")}`);
    }

    prevOptionSymsRef.current = next;
  }, [liveOptionSymbolsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Join / leave Module 2 tracker session room ────────────────────────────
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !socket.connected || !activeSessionId) return;

    socket.emit("join:tracker", activeSessionId);
    return () => {
      socket.emit("leave:tracker", activeSessionId);
    };
  }, [activeSessionId]);

  return socketRef.current;
};
