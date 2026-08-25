import { Request, Response } from "express";
import { connect, disconnect, reconnect, getStatus } from "../services/marketDataWebSocketService";

/**
 * POST /module2/ws/connect
 */
export const module2WsConnect = async (_req: Request, res: Response) => {
  try {
    const result = await connect();
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (error: any) {
    console.error("[Module2WebSocket] Connect endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * POST /module2/ws/disconnect
 */
export const module2WsDisconnect = (_req: Request, res: Response) => {
  try {
    const result = disconnect();
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("[Module2WebSocket] Disconnect endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * POST /module2/ws/reconnect
 */
export const module2WsReconnect = async (_req: Request, res: Response) => {
  try {
    const result = await reconnect();
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (error: any) {
    console.error("[Module2WebSocket] Reconnect endpoint error:", error?.message || error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * GET /module2/ws/status
 */
export const module2WsStatus = (_req: Request, res: Response) => {
  return res.status(200).json(getStatus());
};
