// @ts-ignore
import io from "socket.io-client-v2";
import { getMarketDataToken, getMarketDataUser, isMarketDataAuthenticated } from "./marketDataSessionService";
import { marketDataEvents } from "./marketDataEvents";

/**
 * Market Data WebSocket Connection Manager (Phase 5, consolidated in Phase 6).
 *
 * This is the ONLY component in the backend allowed to create, destroy, or
 * reconnect the Symphony XTS Market Data socket. It owns connection lifecycle,
 * heartbeat, and health status — nothing else.
 *
 * Other services never touch the socket directly. They consume it in one of
 * two ways:
 *   1. onRawSocketEvent() — register a listener that gets re-attached to
 *      every socket instance this manager creates (survives reconnects),
 *      for business-specific concerns like tick payload handling.
 *   2. marketDataEvents — CONNECTED / DISCONNECTED / RECONNECTED are emitted
 *      here so unrelated services (subscription sync, broker-status
 *      broadcast) can react without importing each other.
 *
 * This service still knows nothing about subscriptions or tick payloads
 * itself — see subscriptionSyncService.ts (Phase 6) and
 * aetramMarketDataService.ts's raw-listener registrations for those.
 */

export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING";

export interface ConnectionHealth {
  state: ConnectionState;
  authenticated: boolean;
  connectionStartedAt: string | null;
  connectedAt: string | null;
  lastHeartbeatAt: string | null;
  lastDisconnectAt: string | null;
  reconnectAttempts: number;
  lastError: string | null;
}

export interface ConnectResult {
  ok: boolean;
  reason?: string;
  status: ConnectionHealth;
}

// Exponential-ish backoff schedule (ms). Attempts beyond the array length reuse the last value.
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const MAX_RECONNECT_ATTEMPTS = Number(process.env.MOD2_WS_MAX_RECONNECT_ATTEMPTS) || 5;
const CONNECT_TIMEOUT_MS = Number(process.env.MOD2_WS_CONNECT_TIMEOUT_MS) || 12000;
const IDLE_TIMEOUT_MS = Number(process.env.MOD2_WS_IDLE_TIMEOUT_MS) || 45000;
const HEARTBEAT_CHECK_INTERVAL_MS = Number(process.env.MOD2_WS_HEARTBEAT_CHECK_INTERVAL_MS) || 10000;

const getBaseUrl = () => (process.env.AETRAM_MARKETDATA_API_BASE_URL || "").trim();

// ── Internal state ──────────────────────────────────────────────────────────
let socket: any = null;
let state: ConnectionState = "DISCONNECTED";
let connectionStartedAt: Date | null = null;
let connectedAt: Date | null = null;
let lastHeartbeatAt: Date | null = null;
let lastDisconnectAt: Date | null = null;
let reconnectAttempts = 0;
let lastError: string | null = null;

// Set right before any intentional teardown (manual disconnect(), or the
// idle-timeout watchdog closing a stale socket) so the "disconnect" event
// handler knows not to schedule an automatic reconnect for it.
let manualTeardown = false;

let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatCheckTimer: NodeJS.Timeout | null = null;

// Listeners registered by consumers (e.g. aetramMarketDataService's tick handlers)
// that must be re-attached to every new socket instance this manager creates,
// so a business-logic consumer never needs to know when a reconnect happened.
const rawListeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

/**
 * Registers a listener to be attached to the underlying socket — now (if one
 * exists) and on every future socket this manager creates. This is the ONLY
 * way another service should observe raw socket events; it never gets a
 * reference to the socket itself, so it cannot create/destroy/reconnect it.
 */
export const onRawSocketEvent = (event: string, handler: (...args: any[]) => void): void => {
  if (!rawListeners.some((l) => l.event === event && l.handler === handler)) {
    rawListeners.push({ event, handler });
  }
  if (socket) {
    socket.off(event, handler);
    socket.on(event, handler);
  }
};

const attachRawListeners = (target: any) => {
  for (const { event, handler } of rawListeners) {
    target.off(event, handler);
    target.on(event, handler);
  }
};

const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};

const stopHeartbeatMonitor = () => {
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
    heartbeatCheckTimer = null;
  }
};

const startHeartbeatMonitor = () => {
  stopHeartbeatMonitor();
  lastHeartbeatAt = new Date();
  heartbeatCheckTimer = setInterval(() => {
    if (state !== "CONNECTED" || !lastHeartbeatAt) return;
    const idleMs = Date.now() - lastHeartbeatAt.getTime();
    if (idleMs > IDLE_TIMEOUT_MS) {
      console.warn(`[MarketDataWS] Heartbeat idle timeout (${idleMs}ms) — connection considered stale. Forcing reconnect.`);
      forceReconnectDueToStaleConnection();
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
};

const teardownSocket = () => {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
};

const buildHost = (): string | null => {
  const baseUrl = getBaseUrl();
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
};

/** Central place that decides whether a dropped connection gets an automatic retry. */
const handleUnexpectedDisconnect = (reason: string) => {
  lastDisconnectAt = new Date();
  stopHeartbeatMonitor();
  console.warn(`[MarketDataWS] Connection Closed — reason: ${reason}`);
  marketDataEvents.emit("DISCONNECTED", { reason, manual: false });

  state = "RECONNECTING";
  scheduleReconnect();
};

const scheduleReconnect = () => {
  reconnectAttempts += 1;

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error(`[MarketDataWS] Reconnect Failed — giving up after ${MAX_RECONNECT_ATTEMPTS} attempts.`);
    state = "DISCONNECTED";
    lastError = `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded.`;
    return;
  }

  const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1)];
  console.log(`[MarketDataWS] Reconnect Started — attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms.`);

  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    attemptConnect().catch((err) => {
      console.error("[MarketDataWS] Reconnect attempt threw unexpectedly:", err?.message || err);
    });
  }, delay);
};

const forceReconnectDueToStaleConnection = () => {
  manualTeardown = true;
  teardownSocket();
  state = "RECONNECTING";
  lastDisconnectAt = new Date();
  // Idle-timeout reconnects don't count against the backoff budget as a "failure" in the
  // same sense as a dropped socket, but still go through the same attempt/backoff bookkeeping
  // so a persistently stale endpoint doesn't retry forever either.
  scheduleReconnect();
};

/**
 * Attempts a single connection cycle. Resolves true if connected within
 * CONNECT_TIMEOUT_MS, false otherwise (a failed attempt schedules the next
 * automatic retry via scheduleReconnect unless called from a fresh connect()/
 * reconnect() where the caller manages that decision).
 */
const attemptConnect = async (): Promise<boolean> => {
  const token = getMarketDataToken();
  const userID = getMarketDataUser();

  if (!token || !userID) {
    lastError = "Not authenticated — no active Market Data session.";
    console.warn("[MarketDataWS] Connection attempt aborted — Market Data session not authenticated.");
    state = "DISCONNECTED";
    return false;
  }

  const host = buildHost();
  if (!host) {
    lastError = "AETRAM_MARKETDATA_API_BASE_URL is missing or invalid.";
    console.error("[MarketDataWS] Cannot connect — invalid or missing Market Data base URL.");
    state = "DISCONNECTED";
    return false;
  }

  teardownSocket();
  manualTeardown = false;
  state = state === "RECONNECTING" ? "RECONNECTING" : "CONNECTING";
  if (!connectionStartedAt) connectionStartedAt = new Date();

  const attemptLabel = reconnectAttempts > 0 ? `reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}` : "initial attempt";
  const maskedToken = token.length > 8 ? `${token.substring(0, 4)}...${token.substring(token.length - 4)}` : "***";

  let socketPath = "/apimarketdata/socket.io";
  try {
    const parsedPath = new URL(getBaseUrl()).pathname.replace(/\/$/, "");
    if (parsedPath) socketPath = `${parsedPath}/socket.io`;
  } catch { }

  const fullUrl = `${host}${socketPath}?token=${maskedToken}&userID=${userID}&apiType=MARKETDATA&publishFormat=JSON`;

  console.log(`[AETRAM][WS][STATE] before-connect`);
  console.log(`[AETRAM][WS][STATE] connecting`);
  console.log(`[AETRAM][WS] Connecting (${attemptLabel})...`);
  console.log(`----------------------------------------------------
[MarketDataWS/Debug] Initiating Socket.IO Connection
Timestamp     : ${new Date().toISOString()}
Socket Host   : ${host}
Socket Path   : ${socketPath}
Full Conn URL : ${fullUrl}
Token (masked): ${maskedToken}
UserID        : ${userID}
publishFormat : JSON
apiType       : MARKETDATA
Attempt       : ${attemptLabel}
----------------------------------------------------`);

  socket = io(host, {
    path: socketPath,
    query: { token, userID, apiType: "MARKETDATA", publishFormat: "JSON" },
    transports: ["polling", "websocket"],
    reconnection: false,
    timeout: CONNECT_TIMEOUT_MS,
  });

  socket.on("connect", () => {
    console.log(`[AETRAM][WS][STATE] connected`);
    console.log(`[AETRAM][WS] Connected (Socket ID: ${socket?.id})`);
    console.log(`[MarketDataWS/Debug] EVENT: connect (Socket ID: ${socket?.id})`);
  });

  socket.on("disconnect", (reason: string) => {
    console.warn(`[AETRAM][WS][STATE] disconnected`);
    console.warn(`[AETRAM][WS] Disconnected (Reason: ${reason})`);
    console.log(`[MarketDataWS/Debug] EVENT: disconnect (Reason: ${reason})`);
    if (manualTeardown) {
      console.log(`[MarketDataWS] Socket closed (${reason}) — manual/graceful, no auto-reconnect.`);
      return;
    }
    handleUnexpectedDisconnect(reason);
  });

  socket.on("error", (err: any) => {
    lastError = err?.message || String(err);
    console.error(`[AETRAM][WS] Connection error: ${lastError}`);
    console.error("[MarketDataWS/Debug] EVENT: error:", lastError, err);
  });

  socket.on("joined", (data: any) => {
    console.log("[MarketDataWS/Debug] EVENT: joined:", JSON.stringify(data));
  });

  const engine: any = (socket as any).io?.engine;
  if (engine) {
    engine.on("packet", (packet: any) => {
      if (packet?.type === "ping" || packet?.type === "pong") {
        lastHeartbeatAt = new Date();
      }
    });
  }

  // Re-attach every consumer-registered listener (e.g. tick handlers) to this
  // fresh socket instance — consumers never see the socket itself.
  attachRawListeners(socket);

  const connected = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[AETRAM][WS] Connection error: Connection timed out after ${CONNECT_TIMEOUT_MS}ms.`);
      console.warn(`[MarketDataWS] Connection timed out after ${CONNECT_TIMEOUT_MS}ms.`);
      resolve(false);
    }, CONNECT_TIMEOUT_MS);

    socket!.once("connect", () => {
      clearTimeout(timer);
      resolve(true);
    });

    socket!.once("connect_error", (err: any) => {
      clearTimeout(timer);
      lastError = err?.message || String(err);
      const reqStatus = err?.req?.status || err?.status || err?.context?.status;
      const respData = err?.req?.responseText || err?.data || err?.context?.data;
      console.error(`[AETRAM][WS] Connection error: ${lastError}`);
      console.error(`----------------------------------------------------
[MarketDataWS/Debug] EVENT: connect_error
Error Message : ${err?.message || err}
HTTP Status   : ${reqStatus || 'N/A'}
Namespace     : ${(socket as any)?.nsp || '/'}
Path          : ${socketPath}
Response Body : ${respData || 'N/A'}
----------------------------------------------------`);
      resolve(false);
    });
  });

  if (connected) {
    const wasReconnect = reconnectAttempts > 0;
    state = "CONNECTED";
    connectedAt = new Date();
    lastError = null;
    reconnectAttempts = 0;
    startHeartbeatMonitor();
    console.log(`[AETRAM][WS][STATE] ready-for-subscription`);
    console.log(wasReconnect ? "[AETRAM][WS] Reconnected" : "[AETRAM][WS] Connected");
    marketDataEvents.emit(wasReconnect ? "RECONNECTED" : "CONNECTED", { connectedAt: connectedAt.toISOString() });
    return true;
  }

  // Failed attempt — if we're in a reconnect cycle, schedule the next one;
  // a fresh connect() call surfaces the failure to its caller instead.
  if (state === "RECONNECTING") {
    scheduleReconnect();
  } else {
    state = "DISCONNECTED";
  }
  return false;
};

/**
 * POST /module2/ws/connect
 * Establishes the initial connection. Idempotent — returns current status if
 * already connected.
 */
export const connect = async (): Promise<ConnectResult> => {
  if (state === "CONNECTED") {
    return { ok: true, status: getStatus() };
  }
  if (state === "CONNECTING" || state === "RECONNECTING") {
    return { ok: false, reason: `Connection already in progress (state=${state}).`, status: getStatus() };
  }

  reconnectAttempts = 0;
  connectionStartedAt = new Date();
  const connected = await attemptConnect();
  return { ok: connected, reason: connected ? undefined : lastError || "Connection failed.", status: getStatus() };
};

/**
 * POST /module2/ws/disconnect
 * Graceful shutdown — closes the socket and does not schedule a reconnect.
 */
export const disconnect = (): ConnectResult => {
  clearReconnectTimer();
  stopHeartbeatMonitor();
  manualTeardown = true;
  teardownSocket();

  const wasConnected = state !== "DISCONNECTED";
  state = "DISCONNECTED";
  lastDisconnectAt = new Date();
  reconnectAttempts = 0;
  connectionStartedAt = null;
  connectedAt = null;

  if (wasConnected) {
    console.log("[MarketDataWS] Connection Closed — graceful shutdown requested.");
    marketDataEvents.emit("DISCONNECTED", { reason: "manual disconnect", manual: true });
  }
  return { ok: true, status: getStatus() };
};

/**
 * POST /module2/ws/reconnect
 * Forces a fresh connection cycle regardless of current state (manual override
 * of the automatic backoff — resets the attempt counter).
 */
export const reconnect = async (): Promise<ConnectResult> => {
  console.log("[MarketDataWS] Reconnect Started — manual request.");
  clearReconnectTimer();
  stopHeartbeatMonitor();
  manualTeardown = true;
  teardownSocket();

  reconnectAttempts = 0;
  connectionStartedAt = new Date();
  const connected = await attemptConnect();
  return { ok: connected, reason: connected ? undefined : lastError || "Reconnect failed.", status: getStatus() };
};

/**
 * GET /module2/ws/status
 */
export const getStatus = (): ConnectionHealth => ({
  state,
  authenticated: isMarketDataAuthenticated(),
  connectionStartedAt: connectionStartedAt ? connectionStartedAt.toISOString() : null,
  connectedAt: connectedAt ? connectedAt.toISOString() : null,
  lastHeartbeatAt: lastHeartbeatAt ? lastHeartbeatAt.toISOString() : null,
  lastDisconnectAt: lastDisconnectAt ? lastDisconnectAt.toISOString() : null,
  reconnectAttempts,
  lastError,
});
