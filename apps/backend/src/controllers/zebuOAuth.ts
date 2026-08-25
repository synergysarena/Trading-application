import { Request, Response } from "express";
import { getZebuOAuthStatus, setZebuAuthCode } from "../services/zebuOAuthService";

export const zebuOAuthCallback = (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    return res.status(400).json({ error: "Missing OAuth code in callback." });
  }

  setZebuAuthCode(code);
  return res.status(200).json({
    message: "Zebu OAuth code received. Restart the Module1 data feed/backend to exchange it for a live session token.",
  });
};

export const getZebuOAuthStatusEndpoint = (_req: Request, res: Response) => {
  return res.status(200).json(getZebuOAuthStatus());
};
