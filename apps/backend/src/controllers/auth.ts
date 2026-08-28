import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { User } from "../models/User";
import { Watchlist } from "../models/Watchlist";
import { LoginSchema, RegisterSchema } from "@stock/shared";
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from "../utils/token";
import redis from "../config/redis";
import { AuthenticatedRequest, markTokenRevoked } from "../middleware/auth";


// Fixed user ID issued inside JWTs when authenticating via APP_LOGIN_* env vars.
// Used by refresh and me to bypass the database lookup for this synthetic user.
const ENV_USER_ID = "__app_env_user__";

const getCookie = (req: Request, name: string): string | null => {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").reduce((acc, curr) => {
    const [k, v] = curr.split("=");
    if (k && v) acc[k.trim()] = decodeURIComponent(v.trim());
    return acc;
  }, {} as Record<string, string>);
  return cookies[name] || null;
};

// Returns the env-var user object, or null if env credentials are not configured.
const getEnvUser = () => {
  const username = process.env.APP_LOGIN_USERNAME;
  const password = process.env.APP_LOGIN_PASSWORD;
  if (!username || !password) return null;
  return { id: ENV_USER_ID, username, name: username, password };
};

// Local in-memory users store for when MongoDB is offline
const inMemoryUsers = new Map<string, any>();

bcrypt.hash("password123", 12).then((hashed) => {
  inMemoryUsers.set("60c72b2f9b1d8a0015f8e567", {
    _id: "60c72b2f9b1d8a0015f8e567",
    username: "guest",
    password: hashed,
    name: "Guest User",
    status: "active",
  });
});

// POST /auth/login
export const login = async (req: Request, res: Response) => {
  try {
    const parseResult = LoginSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: "Validation failed", details: parseResult.error.errors });
    }

    const { username, password } = parseResult.data;

    // ── Env-var authentication path ────────────────────────────────────────────
    const envUser = getEnvUser();
    if (envUser) {
      if (username !== envUser.username || password !== envUser.password) {
        return res.status(401).json({ error: "Invalid username or password." });
      }

      // OTP step — issue a short-lived pending token instead of full session tokens
      if (process.env.APP_OTP_ENABLED === "true") {
        const secret = process.env.JWT_SECRET || "supersecretjwtkeyforstockdashboardintraday2026";
        const loginToken = jwt.sign(
          { sub: ENV_USER_ID, type: "otp-pending", username: envUser.username, name: envUser.name },
          secret,
          { expiresIn: "5m" }
        );
        return res.status(200).json({ otpRequired: true, loginToken });
      }

      const accessToken  = generateAccessToken(ENV_USER_ID);
      const refreshToken = generateRefreshToken(ENV_USER_ID);

      res.cookie("refresh", refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      return res.status(200).json({
        accessToken,
        user: { id: ENV_USER_ID, username: envUser.username, name: envUser.name },
      });
    }

    // ── Database authentication path (fallback when env credentials not set) ──
    let user = null;
    try {
      user = await User.findOne({ username });
    } catch (dbErr) {
      console.warn("[Auth] MongoDB offline. Authenticating via in-memory users.");
      user = Array.from(inMemoryUsers.values()).find((u) => u.username === username);
    }

    if (!user) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match || user.status === "inactive") {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const userId = user._id.toString();

    // OTP step for DB users
    if (process.env.APP_OTP_ENABLED === "true") {
      const secret = process.env.JWT_SECRET || "supersecretjwtkeyforstockdashboardintraday2026";
      const loginToken = jwt.sign(
        { sub: userId, type: "otp-pending", username: user.username, name: user.name || user.username },
        secret,
        { expiresIn: "5m" }
      );
      return res.status(200).json({ otpRequired: true, loginToken });
    }

    const accessToken  = generateAccessToken(userId);
    const refreshToken = generateRefreshToken(userId);

    res.cookie("refresh", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      accessToken,
      user: { id: user._id, username: user.username, name: user.name || user.username },
    });
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// POST /auth/verify-otp — second step when APP_OTP_ENABLED=true
export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const { loginToken, otp } = req.body;
    if (!loginToken || !otp) {
      return res.status(400).json({ error: "loginToken and otp are required." });
    }

    const expectedOtp = process.env.APP_LOGIN_OTP;
    if (!expectedOtp) {
      return res.status(503).json({ error: "OTP is not configured on the server. Set APP_LOGIN_OTP in .env." });
    }

    if (String(otp).trim() !== String(expectedOtp).trim()) {
      return res.status(401).json({ error: "Invalid OTP." });
    }

    const secret = process.env.JWT_SECRET || "supersecretjwtkeyforstockdashboardintraday2026";
    let decoded: any;
    try {
      decoded = jwt.verify(loginToken, secret);
    } catch {
      return res.status(401).json({ error: "OTP session expired. Please sign in again." });
    }

    if (decoded.type !== "otp-pending") {
      return res.status(401).json({ error: "Invalid token type." });
    }

    const userId   = decoded.sub as string;
    const username = decoded.username as string;
    const name     = decoded.name as string;

    const accessToken  = generateAccessToken(userId);
    const refreshToken = generateRefreshToken(userId);

    res.cookie("refresh", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      accessToken,
      user: { id: userId, username, name },
    });
  } catch (error) {
    console.error("VerifyOtp Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// POST /auth/register — disabled when env-var authentication is active
export const register = async (req: Request, res: Response) => {
  if (getEnvUser()) {
    return res.status(403).json({ error: "Registration is disabled for this deployment." });
  }

  try {
    const parseResult = RegisterSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: "Validation failed", details: parseResult.error.errors });
    }

    const { username, password, name } = parseResult.data;

    let existingUser = null;
    try {
      existingUser = await User.findOne({ username });
    } catch (dbErr) {
      existingUser = Array.from(inMemoryUsers.values()).find((u) => u.username === username);
    }

    if (existingUser) {
      return res.status(409).json({ error: "Username is already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    let newUser;
    try {
      newUser = await User.create({ username, password: hashedPassword, name: name || username, status: "active" });
      await Watchlist.create({ user_id: newUser._id, symbols_json: [], column_prefs_json: {} });
    } catch (dbErr) {
      console.warn("[Auth] MongoDB offline. Registering user in memory.");
      const mockId = "mock-user-" + Date.now() + "-" + Math.random().toString(36).substring(2, 9);
      newUser = { _id: mockId, username, password: hashedPassword, name: name || username, status: "active" };
      inMemoryUsers.set(mockId, newUser);
    }

    const accessToken  = generateAccessToken(newUser._id.toString());
    const refreshToken = generateRefreshToken(newUser._id.toString());

    res.cookie("refresh", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      message: "Account created successfully!",
      accessToken,
      user: { id: newUser._id, username: newUser.username, name: newUser.name || newUser.username },
    });
  } catch (error) {
    console.error("Registration Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// POST /auth/refresh
export const refresh = async (req: Request, res: Response) => {
  try {
    const refreshToken = getCookie(req, "refresh");
    if (!refreshToken) {
      return res.status(401).json({ error: "Refresh token not provided" });
    }

    const decoded = verifyRefreshToken(refreshToken);

    // ── Env user refresh ───────────────────────────────────────────────────────
    if (decoded.userId === ENV_USER_ID) {
      const envUser = getEnvUser();
      if (!envUser) {
        return res.status(401).json({ error: "Session invalid." });
      }
      const newAccessToken  = generateAccessToken(ENV_USER_ID);
      const newRefreshToken = generateRefreshToken(ENV_USER_ID);
      res.cookie("refresh", newRefreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      return res.status(200).json({
        accessToken: newAccessToken,
        user: { id: ENV_USER_ID, username: envUser.username, name: envUser.name },
      });
    }

    // ── Database user refresh ──────────────────────────────────────────────────
    let user = null;
    try {
      user = await User.findById(decoded.userId);
    } catch (dbErr) {
      console.warn("[Auth] MongoDB offline. Finding user in-memory for refresh.");
      user = inMemoryUsers.get(decoded.userId);
    }

    if (!user || user.status === "inactive") {
      return res.status(401).json({ error: "User is no longer active" });
    }

    const newAccessToken  = generateAccessToken(user._id.toString());
    const newRefreshToken = generateRefreshToken(user._id.toString());
    res.cookie("refresh", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      accessToken: newAccessToken,
      user: { id: user._id, username: user.username, name: user.name || user.username },
    });
  } catch (error) {
    console.error("Token Refresh Error:", error);
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
};

// POST /auth/logout
export const logout = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      try {
        const decoded = jwt.decode(token) as any;
        if (decoded && decoded.exp) {
          const ttl = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
          if (ttl > 0) {
            // Durable blacklist (survives restarts) + in-process cache so the
            // auth middleware never needs a per-request Redis read.
            await redis.setex(`blacklist:${token}`, ttl, "1");
            markTokenRevoked(token, ttl);
          }
        }
      } catch (_) {}
    }

    const userId = (req as AuthenticatedRequest).user?.id || "unknown";
    const socketId = (req.headers["x-socket-id"] as string) || "unknown";
    console.log(`[Logout] REQUEST socket=${socketId} user=${userId}`);

    res.clearCookie("refresh", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });

    return res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// GET /auth/me
export const me = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ── Env user ───────────────────────────────────────────────────────────────
    if (userId === ENV_USER_ID) {
      const envUser = getEnvUser();
      if (!envUser) {
        return res.status(401).json({ error: "Session invalid." });
      }
      return res.status(200).json({
        user: { id: ENV_USER_ID, username: envUser.username, name: envUser.name },
      });
    }

    // ── Database user ──────────────────────────────────────────────────────────
    let user = null;
    try {
      user = await User.findById(userId);
    } catch (dbErr) {
      console.warn("[Auth] MongoDB offline. Finding user in-memory for me.");
      user = inMemoryUsers.get(userId);
    }

    if (!user || user.status === "inactive") {
      return res.status(404).json({ error: "User not found or inactive" });
    }

    return res.status(200).json({
      user: { id: user._id, username: user.username, name: user.name || user.username },
    });
  } catch (error) {
    console.error("Get Me Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// POST /auth/module-login (legacy — kept for compatibility)
export const moduleLogin = async (req: Request, res: Response) => {
  try {
    const { moduleId, username, password } = req.body;

    if (!moduleId || !["module1", "module2"].includes(moduleId)) {
      return res.status(400).json({ error: "Invalid moduleId. Must be 'module1' or 'module2'." });
    }
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const prefix   = moduleId === "module1" ? "MOD1" : "MOD2";
    const validUser = process.env[`${prefix}_ACCESS_USERNAME`] || (moduleId === "module1" ? "module1user" : "module2user");
    const validPass = process.env[`${prefix}_ACCESS_PASSWORD`] || "module123";

    if (username !== validUser || password !== validPass) {
      return res.status(401).json({ error: "Invalid module credentials." });
    }

    const secret = process.env.JWT_SECRET || "supersecretjwtkeyforstockdashboardintraday2026";
    const moduleToken = jwt.sign({ moduleId, type: "module-access" }, secret, { expiresIn: "8h" });

    return res.status(200).json({ moduleToken, moduleId });
  } catch (error) {
    console.error("Module Login Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
