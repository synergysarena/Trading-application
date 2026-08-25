import { Server, Socket } from "socket.io";
import { marketDataEvents } from "./marketDataEvents";
import { NormalizedMarketEvent } from "./marketDataPipelineService";
import { MinuteCandle } from "./minuteAggregationService";

/**
 * Socket.IO Broadcast Layer (Phase 12).
 *
 * Socket.IO is a CONSUMER of the backend, not part of the market-data
 * pipeline — this file only listens to marketDataEvents and re-broadcasts
 * normalized, domain-level events to the frontend. It never touches Redis,
 * MongoDB, the pipeline's decoders, or the broker socket; it reuses the
 * single shared Socket.IO server (the same `io` instance socketService.ts
 * already initializes) by registering its own independent `io.on("connection", ...)`
 * listener — Socket.IO supports multiple connection listeners on one server,
 * so this never creates a second server and never modifies socketService.ts.
 *
 * Frontend never sees raw XTS packets or packet type codes — every payload
 * broadcast here is built from an already-normalized event and explicitly
 * excludes internal-only fields like rawPacketType.
 */

export type RoomScope = "instrument" | "session";

const instrumentRoom = (instrumentId: string): string => `market:instrument:${instrumentId}`;
const sessionRoom = (sessionId: string): string => `market:session:${sessionId}`;

interface ClientInfo {
  socketId: string;
  userId: string | null;
  connectedAt: string;
  lastSeenAt: string;
  rooms: Set<string>;
}

const clients = new Map<string, ClientInfo>();

const broadcastCounts: Record<string, number> = {
  "market:update": 0,
  "market:candle": 0,
  "market:connection": 0,
  "market:subscription": 0,
};

let ioRef: Server | null = null;
let initialized = false;

const bumpCount = (event: keyof typeof broadcastCounts) => {
  broadcastCounts[event] += 1;
};

const touchClient = (socketId: string) => {
  const info = clients.get(socketId);
  if (info) info.lastSeenAt = new Date().toISOString();
};

/** Only the fields the frontend is allowed to see — rawPacketType is deliberately excluded. */
const toMarketUpdatePayload = (event: NormalizedMarketEvent) => ({
  exchangeSegment: event.exchangeSegment,
  exchangeInstrumentID: event.exchangeInstrumentID,
  timestamp: event.timestamp,
  lastPrice: event.lastPrice,
  openInterest: event.openInterest,
  volume: event.volume,
  bid: event.bid,
  ask: event.ask,
});

const toCandlePayload = (candle: MinuteCandle) => ({ ...candle });

/**
 * Called once at server startup with the SAME io instance socketService.ts
 * uses. Registers a second, independent "connection" listener — does not
 * touch or wrap socketService.ts in any way.
 */
export const initMarketBroadcast = (io: Server): void => {
  if (initialized) return;
  initialized = true;
  ioRef = io;

  io.on("connection", (socket: Socket) => {
    clients.set(socket.id, {
      socketId: socket.id,
      userId: (socket.data as any)?.userId ?? null,
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      rooms: new Set(),
    });
    console.log(`[MarketBroadcast] Client connected: ${socket.id}`);

    // Step 3/4: clients opt into exactly the instruments/sessions they need —
    // nothing is pushed to a client that hasn't joined the relevant room.
    socket.on("market:join", (payload: { scope: RoomScope; id: string }) => {
      if (!payload?.scope || !payload?.id) return;
      const room = payload.scope === "instrument" ? instrumentRoom(payload.id) : sessionRoom(payload.id);
      socket.join(room);
      clients.get(socket.id)?.rooms.add(room);
      touchClient(socket.id);
      console.log(`[MarketBroadcast] ${socket.id} joined ${room}`);
    });

    socket.on("market:leave", (payload: { scope: RoomScope; id: string }) => {
      if (!payload?.scope || !payload?.id) return;
      const room = payload.scope === "instrument" ? instrumentRoom(payload.id) : sessionRoom(payload.id);
      socket.leave(room);
      clients.get(socket.id)?.rooms.delete(room);
      touchClient(socket.id);
      console.log(`[MarketBroadcast] ${socket.id} left ${room}`);
    });

    // Heartbeat: any inbound activity (including engine.io's own ping/pong)
    // refreshes lastSeenAt for the /socket/clients endpoint.
    socket.onAny(() => touchClient(socket.id));
    socket.conn.on("packet", (packet: { type: string }) => {
      if (packet.type === "ping" || packet.type === "pong") touchClient(socket.id);
    });

    // Disconnect: Socket.IO's server-side model has no separate "reconnect"
    // event — a client reconnecting is simply a new "connection" with a new
    // socket.id, tracked the same way as any first-time connection above.
    socket.on("disconnect", (reason: string) => {
      clients.delete(socket.id);
      console.log(`[MarketBroadcast] Client disconnected: ${socket.id} (${reason})`);
    });
  });

  marketDataEvents.on("MARKET_DATA", (event: NormalizedMarketEvent) => {
    if (!event.exchangeInstrumentID) return;
    io.to(instrumentRoom(event.exchangeInstrumentID)).emit("market:update", toMarketUpdatePayload(event));
    bumpCount("market:update");
  });

  marketDataEvents.on("CANDLE_COMPLETED", (candle: MinuteCandle) => {
    io.to(instrumentRoom(candle.exchangeInstrumentID)).emit("market:candle", toCandlePayload(candle));
    bumpCount("market:candle");
  });

  marketDataEvents.on("CONNECTED", (payload: { connectedAt: string }) => {
    io.emit("market:connection", { status: "CONNECTED", ...payload });
    bumpCount("market:connection");
  });

  marketDataEvents.on("RECONNECTED", (payload: { connectedAt: string }) => {
    io.emit("market:connection", { status: "RECONNECTED", ...payload });
    bumpCount("market:connection");
  });

  marketDataEvents.on("DISCONNECTED", (payload: { reason: string; manual: boolean }) => {
    io.emit("market:connection", { status: "DISCONNECTED", ...payload });
    bumpCount("market:connection");
  });

  marketDataEvents.on("SUBSCRIBED", (payload: { count: number; exchangeInstrumentIDs: string[] }) => {
    for (const id of payload.exchangeInstrumentIDs) {
      io.to(instrumentRoom(id)).emit("market:subscription", { status: "SUBSCRIBED", exchangeInstrumentID: id });
    }
    bumpCount("market:subscription");
  });

  marketDataEvents.on("UNSUBSCRIBED", (payload: { subscriptionId: string; exchangeInstrumentID: string; sessionId: string }) => {
    io.to(instrumentRoom(payload.exchangeInstrumentID))
      .to(sessionRoom(payload.sessionId))
      .emit("market:subscription", {
        status: "UNSUBSCRIBED",
        exchangeInstrumentID: payload.exchangeInstrumentID,
        subscriptionId: payload.subscriptionId,
      });
    bumpCount("market:subscription");
  });

  console.log("[MarketBroadcast] Initialized — broadcasting normalized market events over Socket.IO.");
};

export const getBroadcastStats = () => {
  const rooms = ioRef ? Array.from(ioRef.sockets.adapter.rooms.keys()) : [];
  return {
    connectedClients: clients.size,
    broadcastCounts: { ...broadcastCounts },
    activeInstrumentRooms: rooms.filter((r) => r.startsWith("market:instrument:")).length,
    activeSessionRooms: rooms.filter((r) => r.startsWith("market:session:")).length,
  };
};

export const getConnectedClients = () =>
  Array.from(clients.values()).map((c) => ({
    socketId: c.socketId,
    userId: c.userId,
    connectedAt: c.connectedAt,
    lastSeenAt: c.lastSeenAt,
    rooms: Array.from(c.rooms),
  }));
