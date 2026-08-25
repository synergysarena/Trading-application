import { useState, useCallback } from "react";
import { useStore } from "../store/useStore";
import { api } from "../utils/api";
import { LoginSchema } from "@stock/shared";
import { LoginDezproxFooter } from "./branding/Dezprox";

const GREEN = "#047857";
const OTP_ENABLED = import.meta.env.VITE_APP_OTP_ENABLED === "true";

export const Auth: React.FC = () => {
  const setAuth = useStore((s) => s.setAuth);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors]       = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // OTP step state
  const [otpStep, setOtpStep]         = useState(false);
  const [loginToken, setLoginToken]   = useState("");
  const [otp, setOtp]                 = useState("");
  const [otpError, setOtpError]       = useState("");
  const [otpLoading, setOtpLoading]   = useState(false);

  const handleLogin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setErrors({});
      setServerError("");

      const result = LoginSchema.safeParse({ username, password });
      if (!result.success) {
        const fe: Record<string, string> = {};
        result.error.errors.forEach((err) => {
          const f = err.path[0] as string;
          if (!fe[f]) fe[f] = err.message;
        });
        setErrors(fe);
        return;
      }

      setIsLoading(true);
      try {
        const response = await api.post("/auth/login", { username, password }, { skipAuth: true });

        // C-3: if backend signals OTP required (and frontend flag enabled) → show OTP step
        if (OTP_ENABLED && response.otpRequired && response.loginToken) {
          setLoginToken(response.loginToken);
          setOtpStep(true);
          setIsLoading(false);
          return;
        }

        setIsSuccess(true);
        setTimeout(() => setAuth(response.user, response.accessToken), 800);
      } catch (err: any) {
        setIsLoading(false);
        setServerError(err?.message || "Invalid username or password.");
      }
    },
    [username, password, setAuth]
  );

  const handleVerifyOtp = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setOtpError("");

      if (!otp.trim()) {
        setOtpError("Please enter the OTP.");
        return;
      }

      setOtpLoading(true);
      try {
        const response = await api.post("/auth/verify-otp", { loginToken, otp }, { skipAuth: true });
        setIsSuccess(true);
        setTimeout(() => setAuth(response.user, response.accessToken), 800);
      } catch (err: any) {
        setOtpLoading(false);
        setOtpError(err?.message || "Invalid OTP. Please try again.");
      }
    },
    [otp, loginToken, setAuth]
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

        @keyframes auth-enter {
          from { opacity: 0; transform: translateY(14px) scale(0.99); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .auth-card { animation: auth-enter 0.45s cubic-bezier(0.16,1,0.3,1) both; }

        .auth-input {
          width: 100%; box-sizing: border-box; background: #f8fafc;
          border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 11px 14px;
          font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 500;
          color: #0f172a; outline: none; transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
        }
        .auth-input:focus {
          border-color: ${GREEN}; box-shadow: 0 0 0 3px rgba(4,120,87,0.12); background: #fff;
        }
        .auth-input::placeholder { color: #94a3b8; }
        .auth-input:disabled     { opacity: 0.55; cursor: not-allowed; }
        .auth-input.err          { border-color: #ef4444; }
        .auth-input.err:focus    { border-color: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,0.1); }

        .auth-pw-wrap { position: relative; }
        .auth-pw-wrap .auth-input { padding-right: 56px; }
        .auth-pw-toggle {
          position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
          background: none; border: none; cursor: pointer; padding: 0;
          font-family: 'Inter', sans-serif; font-size: 11px; font-weight: 700;
          color: #94a3b8; transition: color 0.15s;
        }
        .auth-pw-toggle:hover { color: ${GREEN}; }

        .auth-btn {
          width: 100%; background: ${GREEN}; color: #fff; border: none; border-radius: 8px;
          padding: 13px; font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 700;
          letter-spacing: 0.02em; cursor: pointer; transition: opacity 0.2s, transform 0.1s;
          box-shadow: 0 4px 14px rgba(4,120,87,0.28);
          display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .auth-btn:hover:not(:disabled)  { opacity: 0.9; }
        .auth-btn:active:not(:disabled) { transform: scale(0.99); }
        .auth-btn:disabled { opacity: 0.55; cursor: not-allowed; }

        @keyframes auth-spin { to { transform: rotate(360deg); } }
        .auth-spinner {
          width: 14px; height: 14px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff;
          animation: auth-spin 0.7s linear infinite; display: inline-block; flex-shrink: 0;
        }
      `}</style>

      <div style={{
        width: "100%", minHeight: "100vh", position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, fontFamily: "'Inter', sans-serif",
        overflow: "hidden",
      }}>
        {/* Background photo — blurred + darkened so it reads as texture/mood,
            never competes with the form. Scaled up slightly so the blur's
            soft edge never shows a hard border at the viewport edge. */}
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: "url(/login-bg.jpg)",
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "blur(3px) brightness(0.8) saturate(1.2)",
          transform: "scale(1.08)",
        }} />
        {/* Brand-colour scrim on top of the photo for contrast + cohesion
            with the app's green accent. */}
        <div style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(135deg, rgba(4,120,87,0.32) 0%, rgba(15,23,42,0.78) 55%, rgba(15,23,42,0.88) 100%)",
        }} />

        <div
          className="auth-card"
          style={{
            width: "100%", maxWidth: 440,
            position: "relative", zIndex: 1,
            background: "#fff",
            border: "1.5px solid #e2e8f0",
            borderRadius: 16,
            boxShadow: "0 20px 50px -12px rgba(0,0,0,0.45), 0 4px 12px -4px rgba(0,0,0,0.15)",
            overflow: "hidden",
          }}
        >
          <div style={{ height: 4, background: `linear-gradient(90deg, ${GREEN}, #10b981)` }} />

          <div style={{ padding: "40px 40px 36px" }}>
            {/* App brand */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 36 }}>
              <div style={{
                width: 42, height: 42, borderRadius: 12,
                background: "rgba(4,120,87,0.1)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="2.5">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
              </div>
              <div>
                <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.02em" }}>
                  TradePro
                </h1>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 600, color: "#94a3b8", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Trading Analytics Suite
                </p>
              </div>
            </div>

            {/* ── SUCCESS ── */}
            {isSuccess ? (
              <div style={{
                background: "rgba(4,120,87,0.06)",
                border: "1.5px solid rgba(4,120,87,0.2)",
                borderRadius: 10, padding: "28px 24px", textAlign: "center",
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: "50%", background: GREEN,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 14, boxShadow: "0 4px 16px rgba(4,120,87,0.35)",
                }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: GREEN }}>
                  Access Authorized
                </p>
                <p style={{ margin: 0, fontSize: 12, fontWeight: 500, color: "#64748b" }}>
                  Opening dashboard…
                </p>
              </div>

            ) : otpStep ? (
              /* ── OTP STEP (C-3) ── */
              <>
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.01em", marginBottom: 4 }}>
                    Verification Code
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#64748b" }}>
                    Enter the one-time password to complete sign-in.
                  </div>
                </div>

                <form onSubmit={handleVerifyOtp} noValidate style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  <div>
                    <label style={{
                      display: "block", fontSize: 11, fontWeight: 600, color: "#64748b",
                      textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      OTP
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={otp}
                      onChange={(e) => setOtp(e.target.value)}
                      placeholder="Enter OTP"
                      autoComplete="one-time-code"
                      disabled={otpLoading}
                      className={`auth-input${otpError ? " err" : ""}`}
                      autoFocus
                    />
                    {otpError && (
                      <p style={{ margin: "6px 0 0", fontSize: 12, fontWeight: 500, color: "#ef4444" }}>
                        {otpError}
                      </p>
                    )}
                  </div>

                  <button type="submit" disabled={otpLoading} className="auth-btn">
                    {otpLoading && <span className="auth-spinner" />}
                    {otpLoading ? "Verifying…" : "Verify OTP"}
                  </button>

                  <button
                    type="button"
                    onClick={() => { setOtpStep(false); setOtp(""); setOtpError(""); }}
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      fontSize: 13, fontWeight: 500, color: "#64748b", padding: 0,
                    }}
                  >
                    ← Back to sign in
                  </button>
                </form>
              </>

            ) : (
              /* ── SIGN IN FORM ── */
              <>
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.01em", marginBottom: 4 }}>
                    Application Sign In
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#64748b" }}>
                    Enter your credentials to access the dashboard.
                  </div>
                </div>

                <form onSubmit={handleLogin} noValidate style={{ display: "flex", flexDirection: "column", gap: 18 }}>

                  <div>
                    <label style={{
                      display: "block", fontSize: 11, fontWeight: 600, color: "#64748b",
                      textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      Username
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="Enter username"
                      autoComplete="username"
                      disabled={isLoading}
                      className={`auth-input${errors.username ? " err" : ""}`}
                    />
                    {errors.username && (
                      <p style={{ margin: "6px 0 0", fontSize: 12, fontWeight: 500, color: "#ef4444" }}>
                        {errors.username}
                      </p>
                    )}
                  </div>

                  <div>
                    <label style={{
                      display: "block", fontSize: 11, fontWeight: 600, color: "#64748b",
                      textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      Password
                    </label>
                    <div className="auth-pw-wrap">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter password"
                        autoComplete="current-password"
                        disabled={isLoading}
                        className={`auth-input${errors.password ? " err" : ""}`}
                      />
                      <button
                        type="button"
                        className="auth-pw-toggle"
                        onClick={() => setShowPassword((v) => !v)}
                        tabIndex={-1}
                      >
                        {showPassword ? "Hide" : "Show"}
                      </button>
                    </div>
                    {errors.password && (
                      <p style={{ margin: "6px 0 0", fontSize: 12, fontWeight: 500, color: "#ef4444" }}>
                        {errors.password}
                      </p>
                    )}
                  </div>

                  {serverError && (
                    <div style={{
                      padding: "12px 14px", borderRadius: 8,
                      background: "rgba(239,68,68,0.06)",
                      border: "1.5px solid rgba(239,68,68,0.2)",
                      fontSize: 13, fontWeight: 500, color: "#dc2626",
                    }}>
                      {serverError}
                    </div>
                  )}

                  <button type="submit" disabled={isLoading} className="auth-btn">
                    {isLoading && <span className="auth-spinner" />}
                    {isLoading ? "Signing in…" : "Sign In"}
                  </button>

                </form>
              </>
            )}

            <p style={{
              textAlign: "center", marginTop: 28,
              fontSize: 11, fontWeight: 500, color: "#cbd5e1",
            }}>
              Pivot Intelligence v1.0 · Authorised Access Only
            </p>

            <LoginDezproxFooter />
          </div>
        </div>
      </div>
    </>
  );
};

export default Auth;
