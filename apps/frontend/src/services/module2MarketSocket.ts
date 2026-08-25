import { io, Socket } from "socket.io-client";

/**
 * Market Data Socket.IO client (Phase 13, Step 3).
 *
 * A SEPARATE socket.io-client connection from the one hooks/useSocket.ts
 * already manages for Module 1 / the old Module 2 tracker — mirroring the
 * backend's own Phase 12 design, where marketBroadcastService registers an
 * independent listener on the shared server rather than touching
 * socketService.ts. Here, the existing useSocket() hook is a large,
 * tightly-coupled hook this task must not modify; a second, independent
 * client-side connection keeps this integration fully isolated.
 *
 * This module is a singleton — every hook that uses it shares the SAME
 * connection and the SAME room-membership bookkeeping, so:
 *   - only one socket ever connects, however many hooks/components mount
 *   - joining/leaving a room is reference-counted: if two hooks both want
 *     "market:instrument:26000", the room is only actually left once BOTH
 *     have released it — otherwise the first to unmount would silently cut
 *     off the other's live updates
 *   - registering the same handler for the same event twice is a no-op
 *     (Set-based), so re-rendering a component can never create duplicate
 *     listeners
 *
 * Event names (market:update, market:candle, market:connection,
 * market:subscription, market:join, market:leave) are exactly the backend's
 * Phase 12 contract — nothing here invents or renames an event.
 */

export type MarketSocketEvent =
  | "market:update"
  | "market:candle"
  | "market:connection"
  | "market:subscription"
  | "connect"
  | "disconnect"
  | "connect_error";

type Handler = (...args: any[]) => void;

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || "";

class MarketSocketClient {
  private socket: Socket | null = null;
  private token: string | null = null;
  private listeners = new Map<MarketSocketEvent, Set<Handler>>();
  private roomRefCounts = new Map<string, number>();

  isConnected(): boolean {
    return !!this.socket?.connected;
  }

  /** Idempotent — calling connect() again with the same token is a no-op. */
  connect(token: string): void {
    if (this.socket && this.token === token) return;
    if (this.socket) this.teardown();

    this.token = token;
    this.socket = SOCKET_URL
      ? io(SOCKET_URL, { auth: { token }, transports: ["websocket", "polling"] })
      : io({ auth: { token }, transports: ["websocket", "polling"] });

    // Re-attach every previously-registered handler and re-join every
    // previously-held room whenever a (re)connection completes — this is
    // what makes hook-level "join on mount" survive an underlying
    // disconnect/reconnect without each hook needing to know it happened.
    this.socket.on("connect", () => {
      for (const room of this.roomRefCounts.keys()) {
        this.socket?.emit("market:join", this.parseRoom(room));
      }
    });

    for (const [event, handlers] of this.listeners.entries()) {
      for (const handler of handlers) this.socket.on(event, handler);
    }
  }

  disconnect(): void {
    this.teardown();
    this.token = null;
  }

  /** Forces a fresh connection using the last-known token. */
  reconnect(): void {
    if (!this.token) return;
    const token = this.token;
    this.teardown();
    this.connect(token);
  }

  private teardown(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }

  private parseRoom(room: string): { scope: "instrument" | "session"; id: string } {
    const [, scope, id] = room.split(":");
    return { scope: scope as "instrument" | "session", id };
  }

  private roomName(scope: "instrument" | "session", id: string): string {
    return `market:${scope}:${id}`;
  }

  /** Joins a room, incrementing its reference count. Safe to call from multiple hooks for the same id. */
  joinRoom(scope: "instrument" | "session", id: string): void {
    const room = this.roomName(scope, id);
    const count = this.roomRefCounts.get(room) ?? 0;
    this.roomRefCounts.set(room, count + 1);
    if (count === 0) {
      this.socket?.emit("market:join", { scope, id });
    }
  }

  /** Releases one reference to a room; only actually leaves once the count reaches zero. */
  leaveRoom(scope: "instrument" | "session", id: string): void {
    const room = this.roomName(scope, id);
    const count = this.roomRefCounts.get(room) ?? 0;
    if (count <= 1) {
      this.roomRefCounts.delete(room);
      this.socket?.emit("market:leave", { scope, id });
    } else {
      this.roomRefCounts.set(room, count - 1);
    }
  }

  /** Registers `handler` for `event` — a no-op if the exact same handler is already registered. */
  on(event: MarketSocketEvent, handler: Handler): void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    if (handlers.has(handler)) return;
    handlers.add(handler);
    this.socket?.on(event, handler);
  }

  off(event: MarketSocketEvent, handler: Handler): void {
    this.listeners.get(event)?.delete(handler);
    this.socket?.off(event, handler);
  }
}

/** Shared singleton — every hook imports and uses this same instance. */
export const marketSocketClient = new MarketSocketClient();
