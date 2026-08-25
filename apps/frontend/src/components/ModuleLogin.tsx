import { useState, useCallback } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useStore } from "../store/useStore";
import { api } from "../utils/api";

type ModuleId = "module1" | "module2";

const MODULE_META: Record<ModuleId, {
  label: string; subtitle: string; broker: string;
  accentColor: string; bgAccent: string; borderAccent: string;
  dashboardPath: string; endpoint: string; icon: React.ReactNode;
}> = {
  module1: {
    label: "Module 1", subtitle: "OI Analytics", broker: "Zebu (MYNT)",
    accentColor: "#16a34a", bgAccent: "#f0fdf4", borderAccent: "#86efac",
    dashboardPath: "/module-1/dashboard", endpoint: "/auth/module1-broker-login",
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  },
  module2: {
    label: "Module 2", subtitle: "Strike Tracker", broker: "Aetram (Symphony)",
    accentColor: "#2563eb", bgAccent: "#eff6ff", borderAccent: "#bfdbfe",
    dashboardPath: "/module-2/dashboard", endpoint: "/auth/module2-broker-login",
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>,
  },
};

interface FieldDef { key: string; label: string; placeholder: string; type: "text" | "password"; hint?: string; }

const MODULE1_FIELDS: FieldDef[] = [
  { key: "userId",   label: "User ID",         type: "text",     placeholder: "Zebu Client ID (e.g. Z71763)" },
  { key: "password", label: "Password",         type: "password", placeholder: "Zebu trading password"        },
  { key: "factor2",  label: "Factor 2 / TOTP", type: "text",     placeholder: "e.g. 17121973",
    hint: "Enter the Factor2 value registered with Zebu — this can be your PAN, date of birth, or a TOTP code." },
];

const MODULE2_FIELDS: FieldDef[] = [
  { key: "username", label: "Broker Username", type: "text",     placeholder: "Aetram Client ID (e.g. ATM013924)" },
  { key: "password", label: "Broker Password", type: "password", placeholder: "Aetram trading password"           },
  { key: "otp",      label: "Daily OTP",       type: "text",     placeholder: "Daily OTP / TOTP code"             },
];


// Debug trace entry
interface TraceEntry { ts: string; label: string; value: string; level: "info" | "warn" | "error" | "ok"; }

const isDev = import.meta.env.DEV;

export const ModuleLogin: React.FC = () => {
  const location        = useLocation();
  const navigate        = useNavigate();
  const setModule1Token = useStore((s) => s.setModule1Token);
  const setModule2Token = useStore((s) => s.setModule2Token);

  const mid    = (location.pathname.startsWith("/module-2") ? "module2" : "module1") as ModuleId;
  const meta   = MODULE_META[mid];
  const fields = mid === "module1" ? MODULE1_FIELDS : MODULE2_FIELDS;

  const [values,    setValues]    = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error,     setError]     = useState<{ title: string; detail?: string } | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [trace,     setTrace]     = useState<TraceEntry[]>([]);
  const [showDebug, setShowDebug] = useState(false);

  const setValue = (key: string, val: string) => setValues((prev) => ({ ...prev, [key]: val }));

  const addTrace = (label: string, value: string, level: TraceEntry["level"] = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setTrace((prev) => [...prev, { ts, label, value, level }]);
    const prefix = level === "error" ? "✗" : level === "ok" ? "✓" : level === "warn" ? "!" : "→";
    console.log(`[Module1Login] ${prefix} ${label}:`, value);
  };

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setTrace([]);

    // Validate
    for (const field of fields) {
      if (!values[field.key]?.trim()) {
        setError({ title: `${field.label} is required.` });
        return;
      }
    }

    setIsLoading(true);

    // Build payload (mask password/secret in trace)
    const payload: Record<string, string> = {};
    for (const field of fields) payload[field.key] = values[field.key].trim();

    const maskedPayload: Record<string, string> = { ...payload };
    if (maskedPayload.password)  maskedPayload.password  = "•".repeat(maskedPayload.password.length);
    if (maskedPayload.secretKey) maskedPayload.secretKey = "•".repeat(maskedPayload.secretKey.length);

    addTrace("Route", location.pathname);
    addTrace("Endpoint", meta.endpoint);
    addTrace("Payload (masked)", JSON.stringify(maskedPayload, null, 2));
    addTrace("Request sent", `POST ${meta.endpoint}`);

    try {
      const response = await api.post(meta.endpoint, payload, { skipAuth: true });

      addTrace("HTTP status", "200 OK", "ok");
      addTrace("Response keys", Object.keys(response).join(", "), "ok");

      const { moduleToken } = response;
      if (!moduleToken) {
        addTrace("Token missing", "moduleToken not in response", "error");
        setError({ title: "Server returned success but no module token.", detail: JSON.stringify(response) });
        setIsLoading(false);
        return;
      }

      addTrace("Module token", `${moduleToken.substring(0, 20)}...`, "ok");
      if (mid === "module1") setModule1Token(moduleToken);
      else                   setModule2Token(moduleToken);

      addTrace("Session stored", `${mid} token saved to sessionStorage`, "ok");
      addTrace("Redirecting", meta.dashboardPath, "ok");

      setIsSuccess(true);
      setTimeout(() => navigate(meta.dashboardPath, { replace: true }), 800);

    } catch (err: any) {
      addTrace("HTTP error", err?.message || "Unknown error", "error");

      // Extract structured error from server
      const brokerStat    = err?.brokerStat;
      const brokerEmsg    = err?.brokerEmsg;
      const gatewayStatus = err?.gatewayStatus;
      const gatewayResp   = err?.gatewayResponse;

      if (brokerEmsg) addTrace("Broker emsg", brokerEmsg, "error");
      if (brokerStat) addTrace("Broker stat", brokerStat, "warn");
      if (gatewayStatus) addTrace("Gateway HTTP", String(gatewayStatus), "warn");
      if (gatewayResp)   addTrace("Gateway body", JSON.stringify(gatewayResp), "error");

      // Build human-readable error
      const title = brokerEmsg
        ? `Broker rejected login: ${brokerEmsg}`
        : gatewayStatus
        ? `Broker gateway error (HTTP ${gatewayStatus})`
        : err?.message || "Authentication failed. Check your credentials.";

      const detail = gatewayResp
        ? `Gateway response: ${JSON.stringify(gatewayResp)}`
        : brokerStat
        ? `Broker status: ${brokerStat}`
        : undefined;

      setError({ title, detail });
      if (isDev) setShowDebug(true);
      setIsLoading(false);
    }
  }, [values, fields, mid, meta, navigate, setModule1Token, setModule2Token, location.pathname]);

  const ac = meta.accentColor;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');

        .ml-root { min-height: 100vh; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 60%, #e8f0fe 100%); display: flex; align-items: flex-start; justify-content: center; padding: 32px 24px; font-family: 'Inter', sans-serif; }

        @keyframes ml-enter { from { opacity:0; transform:translateY(16px) scale(0.98); } to { opacity:1; transform:translateY(0) scale(1); } }
        .ml-card { animation: ml-enter 0.4s cubic-bezier(0.16,1,0.3,1) both; }

        .ml-input { width:100%; box-sizing:border-box; background:#f8fafc; border:1.5px solid #e2e8f0; border-radius:8px; padding:11px 14px; font-family:'Inter',sans-serif; font-size:14px; font-weight:500; color:#0f172a; outline:none; transition:border-color 0.2s, box-shadow 0.2s; }
        .ml-input:focus { border-color:${ac}; box-shadow:0 0 0 3px ${ac}18; background:#fff; }
        .ml-input::placeholder { color:#94a3b8; }
        .ml-input.err { border-color:#ef4444; }

        .ml-btn { width:100%; background:${ac}; color:#fff; border:none; border-radius:8px; padding:13px; font-family:'Inter',sans-serif; font-size:14px; font-weight:700; cursor:pointer; box-shadow:0 4px 14px ${ac}40; transition:opacity 0.2s, transform 0.1s; }
        .ml-btn:hover:not(:disabled) { opacity:0.9; }
        .ml-btn:active:not(:disabled) { transform:scale(0.99); }
        .ml-btn:disabled { opacity:0.5; cursor:not-allowed; }

        .ml-lbl { display:block; font-size:11px; font-weight:600; color:#64748b; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:6px; }
        .ml-hint { font-size:11px; color:#94a3b8; margin-top:5px; line-height:1.5; }
        .ml-back { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:600; color:#5b6b82; text-decoration:none; transition:color 0.15s; margin-bottom:22px; }
        .ml-back:hover { color:${ac}; }

        /* Debug panel */
        .ml-debug { background:#0f172a; border-radius:8px; padding:12px; margin-top:14px; font-family:'JetBrains Mono',monospace; font-size:10px; max-height:220px; overflow-y:auto; }
        .ml-debug::-webkit-scrollbar { width:4px; }
        .ml-debug::-webkit-scrollbar-thumb { background:#334155; border-radius:2px; }
        .ml-trace-info  { color:#94a3b8; }
        .ml-trace-ok    { color:#4ade80; }
        .ml-trace-warn  { color:#fbbf24; }
        .ml-trace-error { color:#f87171; }
        .ml-trace-ts    { color:#334155; margin-right:8px; }
      `}</style>

      <div className="ml-root">
        <div style={{ width: "100%", maxWidth: 500 }}>
          <div className="ml-card" style={{ background: "#fff", border: "1.5px solid #e2e8f0", borderRadius: 16, boxShadow: "0 10px 30px -5px rgba(0,0,0,0.08)", overflow: "hidden" }}>
            <div style={{ height: 4, background: `linear-gradient(90deg, ${ac}, ${ac}88)` }} />

            <div style={{ padding: "32px 36px 28px" }}>
              <Link to="/dashboard" className="ml-back">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                Back to Module Selection
              </Link>

              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: meta.bgAccent, border: `1.5px solid ${meta.borderAccent}`, display: "flex", alignItems: "center", justifyContent: "center", color: ac, flexShrink: 0 }}>
                  {meta.icon}
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.02em" }}>{meta.label} Login</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: ac, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 2 }}>{meta.broker}</div>
                </div>
              </div>

              {isSuccess ? (
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <div style={{ width: 44, height: 44, borderRadius: "50%", background: ac, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: ac }}>Broker session active</p>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 500, color: "#64748b" }}>Opening {meta.label} dashboard…</p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {fields.map((field) => (
                    <div key={field.key}>
                      <label className="ml-lbl">{field.label}</label>
                      <input
                        type={field.type}
                        value={values[field.key] || ""}
                        onChange={(e) => setValue(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        autoComplete={field.type === "password" ? "current-password" : "off"}
                        className={`ml-input${error ? " err" : ""}`}
                      />
                      {field.hint && <p className="ml-hint">{field.hint}</p>}
                    </div>
                  ))}

                  {/* Error block — shows structured broker errors */}
                  {error && (
                    <div style={{ padding: "12px 14px", borderRadius: 8, background: "rgba(239,68,68,0.06)", border: "1.5px solid rgba(239,68,68,0.2)" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#dc2626", marginBottom: error.detail ? 4 : 0 }}>
                        {error.title}
                      </div>
                      {error.detail && (
                        <div style={{ fontSize: 11, fontWeight: 500, color: "#ef4444", fontFamily: "'JetBrains Mono', monospace", marginTop: 4, wordBreak: "break-all" }}>
                          {error.detail}
                        </div>
                      )}
                    </div>
                  )}

                  <button type="submit" disabled={isLoading} className="ml-btn" style={{ marginTop: 4 }}>
                    {isLoading ? "Authenticating with broker…" : `Connect ${meta.label}`}
                  </button>
                </form>
              )}

              <p style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: "#94a3b8", fontWeight: 500 }}>
                These are your <strong>{meta.broker}</strong> credentials, not your TradePro login.
              </p>
            </div>
          </div>

          {/* Debug trace panel — only shown in development when there's trace data */}
          {isDev && trace.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button
                onClick={() => setShowDebug((v) => !v)}
                style={{ background: "none", border: "1px solid #334155", color: "#64748b", fontSize: 11, fontWeight: 700, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace", width: "100%" }}
              >
                {showDebug ? "▲ Hide" : "▼ Show"} Auth Trace ({trace.length} entries)
              </button>

              {showDebug && (
                <div className="ml-debug">
                  {trace.map((entry, i) => (
                    <div key={i} style={{ marginBottom: 3 }}>
                      <span className="ml-trace-ts">{entry.ts}</span>
                      <span className={`ml-trace-${entry.level}`}>
                        [{entry.label}] {entry.value}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default ModuleLogin;
