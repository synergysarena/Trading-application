import React, { useState } from "react";
import { api } from "../utils/api";
import { useStore } from "../store/useStore";

const BLUE = "#2563eb";
const BLUE_BG = "#eff6ff";
const BLUE_BORDER = "#bfdbfe";

export function Module2LoginPanel() {
  const [username, setUsername] = useState("ATM013924");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setModule2Token = useStore((s) => s.setModule2Token);
  const setModule2Status = useStore((s) => s.setModule2Status);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    setLoading(true);
    setModule2Status("authenticating");

    try {
      const res = await api.post("/auth/module2-broker-login", { username, password, otp });
      const token = res?.moduleToken;
      if (!token) throw new Error(res?.error || "Authentication failed");

      setSuccess(true);
      setModule2Token(token);
      setModule2Status("authenticated");
    } catch (err: any) {
      console.error(`----------------------------------------------------
[Module2/UI]

Broker Login Failed

HTTP Status: ${err?.status || 'N/A'}
Response JSON: ${JSON.stringify(err?.rawResponse || err?.details || err || {})}
Backend Error: ${err?.error || err?.message || 'N/A'}
Reason: ${err?.reason || 'N/A'}
Description: ${err?.rawResponse?.description || err?.details?.description || 'N/A'}
Code: ${err?.code || 'N/A'}
----------------------------------------------------`, err);

      const errMsg = err?.error || err?.message || String(err);
      setError(errMsg);
      setModule2Status("error", errMsg);
    } finally {
      setLoading(false);
    }
  };

  const statusBadge = success
    ? { label: "Connected", color: BLUE, bg: BLUE_BG, dot: BLUE }
    : loading
    ? { label: "Connecting…", color: "#d97706", bg: "#fffbeb", dot: "#d97706" }
    : error
    ? { label: "Authentication Failed", color: "#dc2626", bg: "#fef2f2", dot: "#dc2626" }
    : { label: "Not Connected", color: "#5b6b82", bg: "#f5f7fa", dot: "#94a3b8" };

  return (
    <>
      <style>{`
        .m2lp-input {
          width: 100%; box-sizing: border-box;
          padding: 10px 14px;
          background: #f8fafc;
          border: 1.5px solid #d8e0ea;
          border-radius: 8px;
          font-family: 'Inter', sans-serif;
          font-size: 14px; font-weight: 500; color: #102033;
          outline: none; transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
        }
        .m2lp-input:focus {
          border-color: ${BLUE};
          box-shadow: 0 0 0 3px ${BLUE}18;
          background: #fff;
        }
        .m2lp-input::placeholder { color: #94a3b8; }
        .m2lp-input:disabled { opacity: 0.55; cursor: not-allowed; }
        .m2lp-input.err { border-color: #ef4444; }

        .m2lp-pw-wrap { position: relative; }
        .m2lp-pw-wrap .m2lp-input { padding-right: 52px; }
        .m2lp-pw-toggle {
          position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
          background: none; border: none; cursor: pointer;
          font-size: 11px; font-weight: 700; color: #94a3b8;
          font-family: 'Inter', sans-serif; padding: 0; transition: color 0.15s;
        }
        .m2lp-pw-toggle:hover { color: ${BLUE}; }

        .m2lp-btn {
          width: 100%; padding: 13px;
          background: ${BLUE}; color: #fff;
          border: none; border-radius: 8px;
          font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 700;
          cursor: pointer; transition: opacity 0.2s, transform 0.1s;
          box-shadow: 0 4px 14px ${BLUE}38;
          display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .m2lp-btn:hover:not(:disabled) { opacity: 0.9; }
        .m2lp-btn:active:not(:disabled) { transform: scale(0.99); }
        .m2lp-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        @keyframes m2lp-spin { to { transform: rotate(360deg); } }
        .m2lp-spinner {
          width: 14px; height: 14px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.35);
          border-top-color: #fff;
          animation: m2lp-spin 0.7s linear infinite;
          display: inline-block; flex-shrink: 0;
        }

        @keyframes m2lp-enter {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .m2lp-card { animation: m2lp-enter 0.35s cubic-bezier(0.16,1,0.3,1) both; }
        .m2lp-info { animation: m2lp-enter 0.35s cubic-bezier(0.16,1,0.3,1) 0.06s both; }
      `}</style>

      <div style={{ padding: "32px", fontFamily: "'Inter', sans-serif" }}>
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", maxWidth: 980 }}>

          {/* ── Login Card ─────────────────────────────────────────────────── */}
          <div
            className="m2lp-card"
            style={{
              width: 460, flexShrink: 0,
              background: "#ffffff",
              border: "1.5px solid #d8e0ea",
              borderRadius: 16,
              boxShadow: "0 1px 8px rgba(15,23,42,0.06)",
              overflow: "hidden",
            }}
          >
            <div style={{ height: 4, background: `linear-gradient(90deg, ${BLUE}, ${BLUE}70)` }} />

            <div style={{ padding: "28px 32px 32px" }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 12,
                  background: BLUE_BG, border: `1.5px solid ${BLUE_BORDER}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: BLUE, flexShrink: 0,
                }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: "#102033", letterSpacing: "-0.02em", lineHeight: 1.2 }}>
                    Module 2
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: BLUE, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 3 }}>
                    Connect to AETRAM Market Data
                  </div>
                </div>
              </div>

              {/* Description */}
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "#5b6b82", fontWeight: 500, lineHeight: 1.5 }}>
                Enter your broker credentials to establish a secure connection.
              </p>

              {/* Status badge */}
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "4px 12px", borderRadius: 20, marginBottom: 22,
                background: statusBadge.bg,
                border: `1px solid ${statusBadge.color}22`,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: statusBadge.dot, display: "inline-block",
                  boxShadow: loading ? `0 0 0 3px ${statusBadge.dot}30` : "none",
                }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: statusBadge.color }}>
                  {statusBadge.label}
                </span>
              </div>

              {/* Success state */}
              {success ? (
                <div style={{ textAlign: "center", padding: "24px 0" }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: "50%",
                    background: BLUE,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    marginBottom: 14,
                    boxShadow: `0 4px 16px ${BLUE}40`,
                  }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </div>
                  <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: BLUE }}>
                    Connected Successfully
                  </p>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 500, color: "#64748b" }}>
                    Opening Module 2 dashboard…
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                  {/* Broker Username */}
                  <div>
                    <label style={{
                      display: "block", fontSize: 11, fontWeight: 600,
                      color: "#5b6b82", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      Broker Username
                    </label>
                    <input
                      className={`m2lp-input${error ? " err" : ""}`}
                      type="text"
                      placeholder="Aetram Client ID (e.g. ATM013924)"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      disabled={loading}
                      autoComplete="username"
                    />
                  </div>

                  {/* Broker Password */}
                  <div>
                    <label style={{
                      display: "block", fontSize: 11, fontWeight: 600,
                      color: "#5b6b82", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      Broker Password
                    </label>
                    <div className="m2lp-pw-wrap">
                      <input
                        className={`m2lp-input${error ? " err" : ""}`}
                        type={showPassword ? "text" : "password"}
                        placeholder="Aetram trading password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={loading}
                        autoComplete="current-password"
                      />
                      <button type="button" className="m2lp-pw-toggle" onClick={() => setShowPassword((v) => !v)}>
                        {showPassword ? "Hide" : "Show"}
                      </button>
                    </div>
                  </div>

                  {/* Daily OTP */}
                  <div>
                    <label style={{
                      display: "block", fontSize: 11, fontWeight: 600,
                      color: "#5b6b82", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      Daily OTP
                    </label>
                    <input
                      className={`m2lp-input${error ? " err" : ""}`}
                      type="text"
                      placeholder="Daily OTP / TOTP code"
                      value={otp}
                      onChange={(e) => setOtp(e.target.value)}
                      disabled={loading}
                    />
                  </div>

                  {/* Error */}
                  {error && (
                    <div style={{
                      padding: "11px 14px",
                      background: "rgba(239,68,68,0.06)",
                      border: "1.5px solid rgba(239,68,68,0.2)",
                      borderRadius: 8,
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#dc2626" }}>{error}</div>
                    </div>
                  )}

                  {/* Submit */}
                  <button type="submit" disabled={loading} className="m2lp-btn" style={{ marginTop: 4 }}>
                    {loading && <span className="m2lp-spinner" />}
                    {loading ? "Authenticating…" : "Connect to Module 2"}
                  </button>

                </form>
              )}
            </div>
          </div>

          {/* ── Info Panel ─────────────────────────────────────────────────── */}
          <div
            className="m2lp-info"
            style={{
              flex: 1, minWidth: 0,
              background: "#ffffff",
              border: "1.5px solid #d8e0ea",
              borderRadius: 16,
              boxShadow: "0 1px 8px rgba(15,23,42,0.06)",
              overflow: "hidden",
            }}
          >
            <div style={{ height: 4, background: `linear-gradient(90deg, ${BLUE}44, transparent)` }} />
            <div style={{ padding: "24px 24px 28px" }}>
              <div style={{
                fontSize: 9, fontWeight: 700, color: "#94a3b8",
                textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 18,
              }}>
                Available After Login
              </div>

              {[
                {
                  icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
                  title: "Strike Tracker",
                  desc: "Per-minute strike price tracker across CE and PE across all selected strikes.",
                },
                {
                  icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth="2.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
                  title: "Trend Detection",
                  desc: "L→H, H→L and reversal signal detection with visual badges.",
                },
                {
                  icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
                  title: "Deep Loss Alerts",
                  desc: "Automatic alerts when a strike drops below −15% from day open.",
                },
                {
                  icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth="2.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
                  title: "OI Build-Up Analysis",
                  desc: "Open interest build-up with futures sidebar and session export.",
                },
              ].map(({ icon, title, desc }) => (
                <div key={title} style={{
                  display: "flex", gap: 12, marginBottom: 16, alignItems: "flex-start",
                }}>
                  <div style={{
                    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                    background: BLUE_BG, border: `1px solid ${BLUE_BORDER}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {icon}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#102033", marginBottom: 2 }}>{title}</div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "#5b6b82", lineHeight: 1.45 }}>{desc}</div>
                  </div>
                </div>
              ))}

              <div style={{
                marginTop: 6, paddingTop: 16, borderTop: "1.5px solid #d8e0ea",
              }}>
                {[
                  ["Broker", "Aetram (Symphony)"],
                  ["Credentials", "App Key + Secret Key"],
                  ["Session", "Active for 8 hours"],
                  ["Data source", "Live Symphony API"],
                ].map(([label, value]) => (
                  <div key={label} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "6px 0",
                    borderBottom: "1px solid #f1f5f9",
                    fontSize: 12,
                  }}>
                    <span style={{ fontWeight: 600, color: "#5b6b82" }}>{label}</span>
                    <span style={{ fontWeight: 700, color: "#102033" }}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}

export default Module2LoginPanel;
