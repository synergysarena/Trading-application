import jwt from "jsonwebtoken";

const INSECURE_PLACEHOLDERS = [
  "your_jwt_secret_here",
  "your_jwt_refresh_secret_here",
  "supersecretjwtkeyforstockdashboardintraday2026",
  "anotherrefreshsecretjwtkeyforstockdashboardintraday2026",
];

const isInsecure = (v?: string) => !v || INSECURE_PLACEHOLDERS.includes(v);

const resolveSecret = (envKey: string, label: string): string => {
  const val = process.env[envKey];
  if (!isInsecure(val)) return val!;

  if (process.env.NODE_ENV === "production") {
    // startupCheck.ts exits before we reach here in production, but be defensive.
    throw new Error(`[Auth] FATAL: ${label} (${envKey}) is not set or uses an insecure default in production.`);
  }

  // Development fallback — predictable so tokens survive restarts during dev.
  console.warn(`[Auth] ${envKey} not configured — using development fallback. Set a real value in .env before going to production.`);
  return `dev-only-${envKey.toLowerCase()}-not-for-production`;
};

const JWT_SECRET         = resolveSecret("JWT_SECRET",         "JWT access token secret");
const JWT_REFRESH_SECRET = resolveSecret("JWT_REFRESH_SECRET", "JWT refresh token secret");

export interface TokenPayload {
  userId: string;
}

export const generateAccessToken = (userId: string): string =>
  jwt.sign({ userId }, JWT_SECRET, { expiresIn: "8h" });

export const generateRefreshToken = (userId: string): string =>
  jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: "7d" });

export const verifyAccessToken = (token: string): TokenPayload =>
  jwt.verify(token, JWT_SECRET) as TokenPayload;

export const verifyRefreshToken = (token: string): TokenPayload =>
  jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;

export { JWT_SECRET, JWT_REFRESH_SECRET };
