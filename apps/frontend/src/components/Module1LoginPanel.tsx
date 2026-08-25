import React, { useState } from "react";
import { api } from "../utils/api";
import { useStore } from "../store/useStore";

const GREEN = "#16a34a";
const GREEN_BG = "#f0fdf4";
const GREEN_BORDER = "#86efac";

export function Module1LoginPanel() {
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [factor2, setFactor2] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setModule1Token = useStore((s) => s.setModule1Token);
  const setModule1Status = useStore((s) => s.setModule1Status);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    setLoading(true);
    setModule1Status("authenticating");

    try {
      const res = await api.post("/auth/module1-broker-login", { userId, password, factor2 }, { skipAuth: true });
      const token = res?.moduleToken;
      if (!token) throw new Error(res?.error || "Authentication failed");

      setSuccess(true);
      setModule1Token(token);
      setModule1Status("authenticated");
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      setError(errMsg);
      setModule1Status("error", errMsg);
    } finally {
      setLoading(false);
    }
  };

  const statusBadge = success
    ? { label: "Connected", color: GREEN, bg: GREEN_BG, dot: GREEN }
    : loading
    ? { label: "Connecting…", color: "#d97706", bg: "#fffbeb", dot: "#d97706" }
    : error
    ? { label: "Authentication Failed", color: "#dc2626", bg: "#fef2f2", dot: "#dc2626" }
    : { label: "Not Connected", color: "#5b6b82", bg: "#f5f7fa", dot: "#94a3b8" };

  return (
    <>
      <style>{`
        .m1lp-input {
          width: 100%; box-sizing: border-box;
          padding: 10px 14px;
          background: #f8fafc;
          border: 1.5px solid #d8e0ea;
          border-radius: 8px;
          font-family: 'Inter', sans-serif;
          font-size: 14px; font-weight: 500; color: #102033;
          outline: none; transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
        }
        .m1lp-input:focus {
          border-color: ${GREEN};
          box-shadow: 0 0 0 3px ${GREEN}18;
          background: #fff;
        }
        .m1lp-input::placeholder { color: #94a3b8; }
        .m1lp-input:disabled { opacity: 0.55; cursor: not-allowed; }
        .m1lp-input.err { border-color: #ef4444; }

        .m1lp-pw-wrap { position: relative; }
        .m1lp-pw-wrap .m1lp-input { padding-right: 52px; }
        .m1lp-pw-toggle {
          position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
          background: none; border: none; cursor: pointer;
          font-size: 11px; font-weight: 700; color: #94a3b8;
          font-family: 'Inter', sans-serif; padding: 0; transition: color 0.15s;
        }
        .m1lp-pw-toggle:hover { color: ${GREEN}; }

        .m1lp-btn {
          width: 100%; padding: 13px;
          background: ${GREEN}; color: #fff;
          border: none; border-radius: 8px;
          font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 700;
          cursor: pointer; transition: opacity 0.2s, transform 0.1s;
          box-shadow: 0 4px 14px ${GREEN}38;
          display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .m1lp-btn:hover:not(:disabled) { opacity: 0.9; }
        .m1lp-btn:active:not(:disabled) { transform: scale(0.99); }
        .m1lp-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        @keyframes m1lp-spin { to { transform: rotate(360deg); } }
        .m1lp-spinner {
          width: 14px; height: 14px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.35);
          border-top-color: #fff;
          animation: m1lp-spin 0.7s linear infinite;
          display: inline-block; flex-shrink: 0;
        }

        @keyframes m1lp-enter {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .m1lp-card { animation: m1lp-enter 0.35s cubic-bezier(0.16,1,0.3,1) both; }
        .m1lp-info { animation: m1lp-enter 0.35s cubic-bezier(0.16,1,0.3,1) 0.06s both; }
      `}</style>

      <div style={{ padding: "32px", fontFamily: "'Inter', sans-serif" }}>
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", maxWidth: 980 }}>

          {/* ── Login Card ─────────────────────────────────────────────────── */}
          <div
            className="m1lp-card"
            style={{
              width: 460, flexShrink: 0,
              background: "#ffffff",
              border: "1.5px solid #d8e0ea",
              borderRadius: 16,
              boxShadow: "0 1px 8px rgba(15,23,42,0.06)",
              overflow: "hidden",
            }}
          >
            <div style={{ height: 4, background: `linear-gradient(90deg, ${GREEN}, ${GREEN}70)` }} />

            <div style={{ padding: "28px 32px 32px" }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 12,
                  background: GREEN_BG, border: `1.5px solid ${GREEN_BORDER}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: GREEN, flexShrink: 0,
                }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: "#102033", letterSpacing: "-0.02em", lineHeight: 1.2 }}>
                    Module 1
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: GREEN, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 3 }}>
                    Connect to Zebu Trading Account
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
                    background: GREEN,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    marginBottom: 14,
                    boxShadow: `0 4px 16px ${GREEN}40`,
                  }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </div>
                  <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: GREEN }}>
                    Connected Successfully
                  </p>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 500, color: "#64748b" }}>
                    Opening Module 1 dashboard…
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                  {/* User ID */}
                  <div>
                    <label style={{
                      display: "block", fontSize: 11, fontWeight: 600,
                      color: "#5b6b82", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      User ID
                    </label>
                    <input
                      className={`m1lp-input${error ? " err" : ""}`}
                      type="text"
                      placeholder="Zebu Client ID (e.g. Z71763)"
                      value={userId}
                      onChange={(e) => setUserId(e.target.value)}
                      disabled={loading}
                      autoComplete="username"
                    />
                  </div>

                  {/* Password */}
                  <div>
                    <label style={{
                      display: "block", fontSize: 11, fontWeight: 600,
                      color: "#5b6b82", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      Password
                    </label>
                    <div className="m1lp-pw-wrap">
                      <input
                        className={`m1lp-input${error ? " err" : ""}`}
                        type={showPassword ? "text" : "password"}
                        placeholder="Zebu trading password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={loading}
                        autoComplete="current-password"
                      />
                      <button type="button" className="m1lp-pw-toggle" onClick={() => setShowPassword((v) => !v)}>
                        {showPassword ? "Hide" : "Show"}
                      </button>
                    </div>
                  </div>

                  {/* Factor 2 */}
                  <div>
                    <label style={{
                      display: "block", fontSize: 11, fontWeight: 600,
                      color: "#5b6b82", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
                    }}>
                      Factor 2 / TOTP
                    </label>
                    <input
                      className={`m1lp-input${error ? " err" : ""}`}
                      type="text"
                      placeholder="e.g. 17121973"
                      value={factor2}
                      onChange={(e) => setFactor2(e.target.value)}
                      disabled={loading}
                      autoComplete="off"
                    />
                    <p style={{ margin: "5px 0 0", fontSize: 11, color: "#94a3b8", lineHeight: 1.5 }}>
                      Enter the Factor 2 registered with Zebu — PAN, date of birth, or TOTP.
                    </p>
                  </div>

                  {/* Remember */}
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      style={{ width: 15, height: 15, cursor: "pointer", accentColor: GREEN }}
                    />
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#5b6b82" }}>Remember Credentials</span>
                  </label>

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
                  <button type="submit" disabled={loading} className="m1lp-btn" style={{ marginTop: 4 }}>
                    {loading && <span className="m1lp-spinner" />}
                    {loading ? "Authenticating…" : "Connect to Module 1"}
                  </button>

                </form>
              )}
            </div>
          </div>

          {/* ── Info Panel ─────────────────────────────────────────────────── */}
          <div
            className="m1lp-info"
            style={{
              flex: 1, minWidth: 0,
              background: "#ffffff",
              border: "1.5px solid #d8e0ea",
              borderRadius: 16,
              boxShadow: "0 1px 8px rgba(15,23,42,0.06)",
              overflow: "hidden",
            }}
          >
            <div style={{ height: 4, background: `linear-gradient(90deg, ${GREEN}44, transparent)` }} />
            <div style={{ padding: "24px 24px 28px" }}>
              <div style={{
                fontSize: 9, fontWeight: 700, color: "#94a3b8",
                textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 18,
              }}>
                Available After Login
              </div>

              {[
                {
                  icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
                  title: "OI Analytics",
                  desc: "Real-time Open Interest change tracker with minute-by-minute updates.",
                },
                {
                  icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>,
                  title: "Call / Put Matrix",
                  desc: "Excel-style C_MT formula matrix with signal generation across all strikes.",
                },
                {
                  icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
                  title: "ATM Strike Detection",
                  desc: "Live at-the-money strike panel with directional bias indicators.",
                },
                {
                  icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="2.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
                  title: "VWAP Market Data",
                  desc: "Volume-weighted average price feed via Zebu broker WebSocket.",
                },
              ].map(({ icon, title, desc }) => (
                <div key={title} style={{
                  display: "flex", gap: 12, marginBottom: 16, alignItems: "flex-start",
                }}>
                  <div style={{
                    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                    background: GREEN_BG, border: `1px solid ${GREEN_BORDER}`,
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
                  ["Broker", "Zebu (MYNT)"],
                  ["Credentials", "Your Zebu client login"],
                  ["Session", "Active for 8 hours"],
                  ["Data source", "Live WebSocket feed"],
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

export default Module1LoginPanel;
