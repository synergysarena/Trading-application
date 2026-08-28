import { Router } from "express";
import rateLimit from "express-rate-limit";
import { register, login, refresh, logout, me, verifyOtp } from "../controllers/auth";
import {
  module1BrokerLogin,
  module1ResumeSession,
  module2BrokerLogin,
  module2ResumeSession,
} from "../controllers/brokerAuth";
import { authenticate } from "../middleware/auth";

const router = Router();

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: "Too many authentication requests. Please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Application auth
router.post("/register",    authRateLimiter, register);
router.post("/login",       authRateLimiter, login);
router.post("/verify-otp",  authRateLimiter, verifyOtp);
router.post("/refresh",     refresh);
router.post("/logout",      authenticate, logout);
router.get("/me",           authenticate, me);

// Broker auth
router.post("/module1-broker-login", authRateLimiter, module1BrokerLogin);
router.post("/module2-broker-login", authRateLimiter, module2BrokerLogin);
// Session-restore reconnection — no credentials accepted, resumes from persisted broker session
router.post("/module1-resume-session", authRateLimiter, module1ResumeSession);
router.post("/module2-resume-session", authRateLimiter, module2ResumeSession);

export default router;

