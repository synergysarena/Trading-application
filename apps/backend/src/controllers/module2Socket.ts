import { Request, Response } from "express";
import { getBroadcastStats, getConnectedClients } from "../services/marketBroadcastService";

/**
 * GET /module2/socket/stats
 */
export const module2GetSocketStats = (_req: Request, res: Response) => {
  return res.status(200).json(getBroadcastStats());
};

/**
 * GET /module2/socket/clients
 */
export const module2GetSocketClients = (_req: Request, res: Response) => {
  const clients = getConnectedClients();
  return res.status(200).json({ count: clients.length, clients });
};
