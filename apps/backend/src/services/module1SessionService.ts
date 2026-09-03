import { resumeDataFeedFromPersistedSession } from "./dataFeed";
import { isZebuLiveConnected } from "./zebuMarketDataClient";
import crypto from "crypto";

export interface Module1Session {
  sessionId: string;
  userId: string;
  socketId: string;
  connectedAt: Date;
  lastSeenAt: Date;
  status: "active" | "stale" | "disconnected";
}

// ── Session Registry State ──────────────────────────────────────────────────
// Maps socketId -> Module1Session (each active Socket.IO connection is one session)
const sessionsBySocket = new Map<string, Module1Session>();
// Maps userId -> Set of socketIds
const socketIdsByUser = new Map<string, Set<string>>();

// ── Broker Lifecycle State ──────────────────────────────────────────────────
let staleCheckInterval: NodeJS.Timeout | null = null;

/**
 * Reacts to transitions in the active Module 1 session count.
 * Client socket presence does NOT control the market-data feed lifecycle.
 * The feed continues running in the background even when active socket count reaches 0.
 */
const handleSessionCountTransition = (prevCount: number, currentCount: number) => {
  if (prevCount === 0 && currentCount >= 1) {
    // If broker is not currently connected when the first client connects, attempt to auto-resume
    // from persisted broker session if one exists in Redis.
    if (!isZebuLiveConnected()) {
      resumeDataFeedFromPersistedSession().then((result) => {
        console.log(`[Module1/Broker] Auto-resume check on active client connection: ${result}`);
      }).catch((err) => {
        console.warn("[Module1/Broker] Auto-resume check failed on client connection:", err?.message || err);
      });
    } else {
      console.log(`[Module1/Broker] Client connected to live feed (active sockets: ${currentCount})`);
    }
  } else if (currentCount > 0) {
    console.log(`[Module1/Broker] Active client sockets: ${currentCount}`);
  } else if (currentCount === 0) {
    // All client tabs closed/disconnected: feed continues running independently in background
    console.log("[Module1/Broker] Zero active client sockets. Live feed and storage continue running in background.");
  }
};

/**
 * Registers a new Module 1 session for an authenticated Socket.IO connection.
 * Prevents duplicate registration of the same Socket.IO connection.
 */
export const registerModule1Session = (userId: string, socketId: string): Module1Session => {
  const safeUserId = userId || "unknown";
  const existing = sessionsBySocket.get(socketId);
  if (existing) {
    existing.lastSeenAt = new Date();
    existing.status = "active";
    console.log(`[Module1/Session] REGISTER socket=${socketId} user=${safeUserId} active=${sessionsBySocket.size}`);
    return existing;
  }

  const prevCount = sessionsBySocket.size;
  const sessionId = `m1_sess_${crypto.randomBytes(8).toString("hex")}`;
  const now = new Date();

  const session: Module1Session = {
    sessionId,
    userId: safeUserId,
    socketId,
    connectedAt: now,
    lastSeenAt: now,
    status: "active",
  };

  sessionsBySocket.set(socketId, session);

  let userSockets = socketIdsByUser.get(safeUserId);
  if (!userSockets) {
    userSockets = new Set<string>();
    socketIdsByUser.set(safeUserId, userSockets);
  }
  userSockets.add(socketId);

  const currentCount = sessionsBySocket.size;
  console.log(`[Module1/Session] REGISTER socket=${socketId} user=${safeUserId} active=${currentCount}`);
  console.log(`[Module1/Session] CURRENT sockets=${Array.from(sessionsBySocket.keys()).join(",") || "none"} active=${currentCount}`);

  handleSessionCountTransition(prevCount, currentCount);

  return session;
};

/**
 * Removes a session when its Socket.IO connection closes (browser close, network disconnect, tab close, logout).
 * Idempotent: safe against multiple invocations.
 */
export const removeModule1SessionBySocket = (socketId: string): boolean => {
  const session = sessionsBySocket.get(socketId);
  if (!session) {
    console.log(`[Module1/Session] REMOVE_SOCKET socket=${socketId} removed=false active=${sessionsBySocket.size}`);
    return false;
  }

  const prevCount = sessionsBySocket.size;
  sessionsBySocket.delete(socketId);

  const userSockets = socketIdsByUser.get(session.userId);
  if (userSockets) {
    userSockets.delete(socketId);
    if (userSockets.size === 0) {
      socketIdsByUser.delete(session.userId);
    }
  }

  const currentCount = sessionsBySocket.size;
  console.log(`[Module1/Session] REMOVE_SOCKET socket=${socketId} removed=true active=${currentCount}`);
  console.log(`[Module1/Session] CURRENT sockets=${Array.from(sessionsBySocket.keys()).join(",") || "none"} active=${currentCount}`);

  handleSessionCountTransition(prevCount, currentCount);
  return true;
};

/**
 * Invalids / removes sessions for a specific user ID.
 * Optional excludeSocketId allows keeping a specific socket alive if needed.
 * Idempotent: safe against multiple invocations.
 */
export const removeModule1SessionsByUser = (userId: string, excludeSocketId?: string): number => {
  const userSockets = socketIdsByUser.get(userId);
  if (!userSockets || userSockets.size === 0) {
    console.log(`[Module1/Session] REMOVE_USER user=${userId} removedSockets=0 active=${sessionsBySocket.size}`);
    return 0;
  }

  const prevCount = sessionsBySocket.size;
  const socketsToRemove = Array.from(userSockets).filter((s) => s !== excludeSocketId);
  if (socketsToRemove.length === 0) {
    console.log(`[Module1/Session] REMOVE_USER user=${userId} removedSockets=0 active=${sessionsBySocket.size}`);
    return 0;
  }

  for (const socketId of socketsToRemove) {
    sessionsBySocket.delete(socketId);
    userSockets.delete(socketId);
  }
  if (userSockets.size === 0) {
    socketIdsByUser.delete(userId);
  }

  const currentCount = sessionsBySocket.size;
  console.log(`[Module1/Session] REMOVE_USER user=${userId} removedSockets=${socketsToRemove.length} active=${currentCount}`);
  console.log(`[Module1/Session] CURRENT sockets=${Array.from(sessionsBySocket.keys()).join(",") || "none"} active=${currentCount}`);

  handleSessionCountTransition(prevCount, currentCount);
  return socketsToRemove.length;
};

/**
 * Updates lastSeenAt timestamp for a session on socket activity.
 */
export const touchModule1Session = (socketId: string): void => {
  const session = sessionsBySocket.get(socketId);
  if (session) {
    session.lastSeenAt = new Date();
  }
};

/**
 * Returns total count of active Module 1 sessions derived strictly from the session map.
 */
export const getActiveModule1SessionCount = (): number => {
  return sessionsBySocket.size;
};

/**
 * Returns a list of current active Module 1 sessions.
 */
export const getActiveModule1Sessions = (): Module1Session[] => {
  return Array.from(sessionsBySocket.values());
};

/**
 * Periodic stale session sweeper (runs every 60 seconds).
 * Removes sessions that have been inactive for > 5 minutes without a socket heartbeat.
 */
const initStaleSessionSweeper = () => {
  if (staleCheckInterval) return;

  staleCheckInterval = setInterval(() => {
    const now = Date.now();
    const STALE_TIMEOUT_MS = 5 * 60 * 1000;
    const staleSocketIds: string[] = [];

    for (const [socketId, session] of sessionsBySocket.entries()) {
      if (now - session.lastSeenAt.getTime() > STALE_TIMEOUT_MS) {
        staleSocketIds.push(socketId);
      }
    }

    if (staleSocketIds.length > 0) {
      console.log(`[Module1/Session] Removing ${staleSocketIds.length} stale session(s)...`);
      for (const socketId of staleSocketIds) {
        removeModule1SessionBySocket(socketId);
      }
    }
  }, 60000);
};

initStaleSessionSweeper();

/**
 * Clears all active module 1 sessions during global shutdown.
 */
export const clearAllModule1Sessions = () => {
  const clearedCount = sessionsBySocket.size;
  sessionsBySocket.clear();
  socketIdsByUser.clear();
  console.log(`[Module1/Session] Cleared all ${clearedCount} active sessions on global shutdown`);
};

/**
 * Cleanup function for server shutdown.
 */
export const stopSessionManager = () => {
  if (staleCheckInterval) {
    clearInterval(staleCheckInterval);
    staleCheckInterval = null;
  }
  sessionsBySocket.clear();
  socketIdsByUser.clear();
};
