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

// Module-level stable socket singleton to prevent duplicate creation
// or teardown across re-renders and token rotations.
let globalSocket: Socket | null = null;
let isExplicitlyDisconnected = false;

export const useSocket = () => {
  const socketRef = useRef<Socket | null>(globalSocket);

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

  // Helper to re-establish active subscriptions
  const restoreAllSubscriptions = (socket: Socket) => {
    console.log("[Module1/Socket] Restoring subscriptions (core + selected options + indicators)...");

    // Always subscribe to core instruments for live Spot/Future display.
    socket.emit("join:symbol", "NIFTY-SPOT");
    socket.emit("join:symbol", "NIFTY-FUT");
    console.log("[Module1/Socket] Subscribed to core symbols (NIFTY-SPOT, NIFTY-FUT)");

    const currentSelectedSymbol = useStore.getState().selectedSymbol;
    if (currentSelectedSymbol) {
      socket.emit("join:symbol", currentSelectedSymbol);
    }

    const currentActiveSessionId = useStore.getState().activeSession?.sessionId;
    if (currentActiveSessionId) {
      socket.emit("join:tracker", currentActiveSessionId);
    }

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
      console.log("[Module1/Socket] Module 1 option subscriptions restored on (re)connect");
    }

    const room = useStore.getState().module1IndicatorRoom;
    if (room) {
      const parsed = parseIndicatorRoom(room);
      if (parsed) socket.emit("join:indicators", parsed);
    }
  };

  // -- Connect / disconnect on auth state change ------------------------------
  useEffect(() => {
    if (!accessToken) {
      if (globalSocket) {
        console.log("[Module1/Socket] Disconnecting - no access token (auth cleared)");
        isExplicitlyDisconnected = true;
        globalSocket.disconnect();
        globalSocket = null;
        socketRef.current = null;
      }
      return;
    }

    // Reuse existing alive socket if available
    if (globalSocket && globalSocket.connected) {
      socketRef.current = globalSocket;
      return;
    }

    if (!globalSocket) {
      console.log("[Module1/Socket] Initializing Module 1 socket (token present)...");
      isExplicitlyDisconnected = false;

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
      globalSocket = socket;
      socketRef.current = socket;

      socket.on("connect", () => {
        const transportName = (socket.io?.engine?.transport?.name) || "unknown";
        console.log(`[Module1/Socket] Connected - ID: ${socket.id} (Transport: ${transportName})`);

        // Restore all subscriptions upon connection
        restoreAllSubscriptions(socket);

        // Update dashboard status to live or trigger recovery on successful (re)connect
        const dash = useDashStore.getState();
        if (
          dash.feedStatus === "reconnecting" ||
          dash.feedStatus === "no-network" ||
          dash.feedStatus === "api-error" ||
          dash.feedStatus === "broker-disconnected" ||
          dash.feedStatus === "connecting"
        ) {
          console.log("[Module1/UI] Triggering dashboard reload / recovery after socket connect");
          dash.bumpReloadKey();
        }
      });

      socket.on("connect_error", (err) => {
        console.warn(`[Module1/Socket] Connection error: ${err.message}`);
      });

      socket.on("reconnect_attempt", (attempt) => {
        console.log(`[Module1/Socket] Reconnecting: attempt #${attempt}...`);
      });

      socket.on("reconnect", (attempt) => {
        console.log(`[Module1/Socket] Reconnected successfully after ${attempt} attempts.`);
        restoreAllSubscriptions(socket);

        const dash = useDashStore.getState();
        if (dash.feedStatus !== "market-closed") {
          dash.bumpReloadKey();
        }
      });

      socket.on("disconnect", (reason) => {
        console.log(
          `[Module1/Socket] Disconnected - reason: ${reason} (wasManualDisconnect: ${isExplicitlyDisconnected}, route: ${window.location.pathname})`
        );
        // Only mark state as reconnecting/no-network if this wasn't an explicit logout
        if (!isExplicitlyDisconnected) {
          const dash = useDashStore.getState();
          if (dash.feedStatus === "live" || dash.feedStatus === "connecting") {
            dash.setFeedStatus(reason === "transport close" || reason === "transport error" || reason === "ping timeout" ? "reconnecting" : "no-network");
          }
        }
      });

      // Raw price ticks -> price cache
      socket.on("tick", (tick: Tick) => {
        updatePrice(tick.symbol, tick.ltp);
        const dash = useDashStore.getState();
        if ((dash.feedStatus === "api-error" || dash.feedStatus === "no-network") && dash.rows.length > 0) {
          console.log("[Module1/UI] Clearing temporary error - valid tick received");
          dash.setFeedStatus("live");
        }
      });

      // Market readiness confirmation from backend - emitted after first valid NIFTY-FUT tick.
      // On receipt, the frontend knows all readiness conditions are met and can auto-generate.
      socket.on("market_ready", (data: { ltp: number; symbol: string; timestamp: string }) => {
        console.log(
          `[Module1/Socket] ✓ market_ready received - symbol=${data.symbol} ltp=${data.ltp} ts=${data.timestamp}`
        );
        setMarketDataReady(true);

        const dash = useDashStore.getState();
        if (
          dash.feedStatus === "api-error" ||
          dash.feedStatus === "broker-disconnected" ||
          dash.feedStatus === "reconnecting" ||
          dash.feedStatus === "no-network" ||
          (dash.feedStatus === "connecting" && dash.rows.length === 0)
        ) {
          console.log("[Module1/UI] Clearing temporary error - market_ready received, triggering data load");
          dash.bumpReloadKey();
        }
      });

      // Module 1 OI matrix
      socket.on("latest-oi", (data: Module1OiMetrics) => {
        setOiMetrics(data);
        const dash = useDashStore.getState();
        if ((dash.feedStatus === "api-error" || dash.feedStatus === "no-network") && dash.rows.length > 0) {
          console.log("[Module1/UI] Clearing temporary error - latest-oi received");
          dash.setFeedStatus("live");
        }
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
      socket.on("broker_status", (data: { status: string; moduleId?: string; detail?: string }) => {
        const mod = data.moduleId || "module1";
        console.log(`[Module1/Socket] broker_status[${mod}]:`, data.status, data.detail || "");

        // Module 2 (AETRAM) broker status
        if (mod === "module2") {
          const { setModule2BrokerStatus } = useStore.getState();
          const s = data.status as "live" | "broker-disconnected" | "session-expired" | "reconnecting";
          setModule2BrokerStatus(s === "live" ? null : s);
          return;
        }

        // Module 1 (Zebu) broker status -> update dashboard feed status
        const dash = useDashStore.getState();
        switch (data.status) {
          case "live":
            if (dash.feedStatus !== "market-closed") {
              if (
                dash.feedStatus === "idle" ||
                dash.feedStatus === "connecting" ||
                dash.feedStatus === "reconnecting" ||
                dash.feedStatus === "broker-disconnected" ||
                dash.feedStatus === "api-error" ||
                dash.feedStatus === "auth-error" ||
                dash.feedStatus === "no-network" ||
                dash.rows.length === 0
              ) {
                console.log("[Module1/UI] Clearing temporary error / recovering - broker became live");
                dash.bumpReloadKey();
              } else {
                dash.setFeedStatus("live");
              }
            }
            break;
          case "reconnecting":
            dash.setFeedStatus("reconnecting");
            break;
          case "broker-disconnected":
            // Only set broker-disconnected if not in the middle of fresh connect loading
            if (dash.feedStatus !== "connecting" || dash.rows.length > 0) {
              dash.setFeedStatus("broker-disconnected");
            }
            break;
          case "session-expired":
            dash.setFeedStatus("session-expired");
            break;
        }
      });
    }

    // Do NOT disconnect socket on effect cleanup when accessToken hasn't been cleared
  }, [accessToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Join / leave selected instrument tick room -----------------------------
  useEffect(() => {
    const socket = globalSocket;
    if (!socket || !socket.connected) return;

    socket.emit("join:symbol", selectedSymbol);
    return () => {
      socket.emit("leave:symbol", selectedSymbol);
    };
  }, [selectedSymbol]);

  // -- Re-subscribe core instruments after any symbol change ------------------
  useEffect(() => {
    const socket = globalSocket;
    if (!socket?.connected) return;
    socket.emit("join:symbol", "NIFTY-SPOT");
    socket.emit("join:symbol", "NIFTY-FUT");
  }, [selectedSymbol]);

  // -- Join / leave Module 1 indicator room ----------------------------------
  useEffect(() => {
    const socket = globalSocket;
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

  // -- Join / leave live option symbol rooms (CE / PE premium feed) ----------
  useEffect(() => {
    const socket = globalSocket;
    if (!socket?.connected) return;

    const prev = prevOptionSymsRef.current;
    const next = liveOptionSymbols;

    prev.filter(s => !next.includes(s)).forEach(s => socket.emit("leave:symbol", s));
    next.filter(s => {
      socket.emit("join:symbol", s);
      console.log(`[Module1/Socket] Subscribed to option room: ${s}`);
    });

    if (next.length > 0) {
      socket.emit("subscribe:options", {
        instrument: dashInstrument,
        expiry: expiryFmt,
        callStrike: dashType !== "Put" ? dashCallStrike : null,
        putStrike: dashType !== "Call" ? dashPutStrike : null,
        type: dashType,
      });
      console.log(`[Module1/Socket] subscribe:options requested - ${next.join(", ")}`);
    }

    prevOptionSymsRef.current = next;
  }, [liveOptionSymbolsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Join / leave Module 2 tracker session room ----------------------------
  useEffect(() => {
    const socket = globalSocket;
    if (!socket || !socket.connected || !activeSessionId) return;

    socket.emit("join:tracker", activeSessionId);
    return () => {
      socket.emit("leave:tracker", activeSessionId);
    };
  }, [activeSessionId]);

  return globalSocket;
};
