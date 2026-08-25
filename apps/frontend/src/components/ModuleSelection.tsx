import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "../store/useStore";
import { api } from "../utils/api";

const GREEN = "#16a34a";

interface ModuleStatus {
  module1: string;
  module2: string;
}

function StatusBadge({ status }: { status: string | undefined }) {
  const isConnected = status === "CONNECTED";
  const isWaiting   = status?.includes("WAITING") || status?.includes("CONFIG");
  const color   = isConnected ? GREEN : isWaiting ? "#d97706" : "#dc2626";
  const bgColor = isConnected ? "#f0fdf4" : isWaiting ? "#fffbeb" : "#fef2f2";
  const label   = isConnected ? "Connected" : isWaiting ? "Waiting Config" : "Disconnected";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, background: bgColor, border: `1px solid ${color}20`, fontSize: 11, fontWeight: 700, color }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}

export const ModuleSelection: React.FC = () => {
  const navigate  = useNavigate();
  const user      = useStore((s) => s.user);
  const module1Token = useStore((s) => s.module1Token);
  const module2Token = useStore((s) => s.module2Token);

  const { data: moduleStatus } = useQuery<ModuleStatus>({
    queryKey: ["module-status"],
    queryFn: () => api.get("/api/module/status"),
    refetchInterval: 10000,
  });

  const modules = [
    {
      id: "module1" as const,
      label: "Module 1",
      subtitle: "OI Analytics",
      description: "Real-time Open Interest change tracker with Call/Put analysis matrix, signal generation, ATM strike panel, and VWAP market data.",
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
      ),
      status: moduleStatus?.module1,
      token: module1Token,
      dashboardPath: "/dashboard/module-1",
      accentColor: GREEN,
      bgAccent: "#f0fdf4",
      borderAccent: "#86efac",
    },
    {
      id: "module2" as const,
      label: "Module 2",
      subtitle: "Strike Tracker",
      description: "Per-minute strike price tracker with trend detection, deep loss alerts, OI build-up analysis, and futures open interest sidebar.",
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
        </svg>
      ),
      status: moduleStatus?.module2,
      token: module2Token,
      dashboardPath: "/dashboard/module-2",
      accentColor: "#2563eb",
      bgAccent: "#eff6ff",
      borderAccent: "#bfdbfe",
    },
  ];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

        .ms-root { min-height: 100vh; background: #f5f7fa; font-family: 'Inter', sans-serif; }

        .ms-topbar {
          height: 60px; display: flex; align-items: center; justify-content: space-between;
          padding: 0 32px;
          background: #ffffff; border-bottom: 1.5px solid #d8e0ea;
          box-shadow: 0 1px 4px rgba(15,32,51,0.06);
        }

        .ms-card {
          background: #ffffff; border: 1.5px solid #d8e0ea; border-radius: 16px;
          overflow: hidden; transition: box-shadow 0.2s, transform 0.2s;
          box-shadow: 0 2px 8px rgba(15,32,51,0.06);
        }
        .ms-card:hover { box-shadow: 0 8px 24px rgba(15,32,51,0.12); transform: translateY(-2px); }

        .ms-launch-btn {
          width: 100%; padding: 13px; border: none; border-radius: 10px;
          font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 700;
          cursor: pointer; transition: opacity 0.15s, transform 0.1s;
          letter-spacing: 0.02em;
        }
        .ms-launch-btn:hover { opacity: 0.9; }
        .ms-launch-btn:active { transform: scale(0.99); }

        .ms-logout-btn {
          background: none; border: 1.5px solid #d8e0ea; color: #5b6b82;
          font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 700;
          padding: 6px 16px; border-radius: 6px; cursor: pointer; transition: all 0.15s;
        }
        .ms-logout-btn:hover { border-color: #dc2626; color: #dc2626; background: #fef2f2; }

        @keyframes ms-enter {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .ms-card { animation: ms-enter 0.45s cubic-bezier(0.16,1,0.3,1) both; }
        .ms-card:nth-child(2) { animation-delay: 0.08s; }
      `}</style>

      <div className="ms-root">
        {/* Top bar */}
        {/* <div className="ms-topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: `${GREEN}15`, display: "flex", alignItems: "center", justifyContent: "center", color: GREEN }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 900, color: "#102033", letterSpacing: "-0.01em" }}>TradePro</div>
              <div style={{ fontSize: 10, fontWeight: 500, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em" }}>Trading Analytics Suite</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Logged in as</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#102033" }}>{user?.name || user?.username}</div>
            </div>
            <button className="ms-logout-btn" onClick={handleLogout}>Logout</button>
          </div>
        </div> */}

        {/* Content */}
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "60px 24px" }}>
          {/* Page heading */}
          <div style={{ textAlign: "center", marginBottom: 56 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: GREEN, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10 }}>
              Welcome back, {user?.name || user?.username}
            </div>
            <h1 style={{ margin: "0 0 12px", fontSize: 34, fontWeight: 900, color: "#102033", letterSpacing: "-0.03em" }}>
              Select a Module
            </h1>
            <p style={{ margin: 0, fontSize: 15, color: "#5b6b82", fontWeight: 500, maxWidth: 480, marginInline: "auto" }}>
              Each module requires its own login. Choose a module to continue.
            </p>
          </div>

          {/* Module cards */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            {modules.map((mod) => (
              <div key={mod.id} className="ms-card">
                {/* Accent top bar */}
                <div style={{ height: 4, background: `linear-gradient(90deg, ${mod.accentColor}, ${mod.accentColor}88)` }} />

                <div style={{ padding: "28px 28px 24px" }}>
                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
                    <div style={{ width: 52, height: 52, borderRadius: 12, background: mod.bgAccent, border: `1.5px solid ${mod.borderAccent}`, display: "flex", alignItems: "center", justifyContent: "center", color: mod.accentColor, flexShrink: 0 }}>
                      {mod.icon}
                    </div>
                    <StatusBadge status={mod.status} />
                  </div>

                  {/* Title */}
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: "#102033", letterSpacing: "-0.02em" }}>{mod.label}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: mod.accentColor, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 2 }}>{mod.subtitle}</div>
                  </div>

                  {/* Description */}
                  <p style={{ margin: "0 0 24px", fontSize: 13, color: "#5b6b82", lineHeight: 1.6, fontWeight: 500 }}>
                    {mod.description}
                  </p>

                  {/* Session badge if already authenticated */}
                  {mod.token && (
                    <div style={{ marginBottom: 12, padding: "7px 12px", background: mod.bgAccent, border: `1px solid ${mod.borderAccent}`, borderRadius: 8, display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={mod.accentColor} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      <span style={{ fontSize: 11, fontWeight: 700, color: mod.accentColor }}>Active session — re-enter or continue</span>
                    </div>
                  )}

                  {/* Launch button */}
                  <button
                    className="ms-launch-btn"
                    style={{ background: mod.accentColor, color: "#ffffff", boxShadow: `0 4px 12px ${mod.accentColor}40` }}
                    onClick={() => navigate(mod.dashboardPath)}
                  >
                    {mod.token ? `Open ${mod.label} Dashboard` : `Login to ${mod.label}`}
                  </button>

                  {/* If has token, also show re-login link */}
                  {mod.token && (
                    <button
                      onClick={() => {
                        // Clear the module token and navigate back to show login panel
                        if (mod.id === "module1") {
                          useStore.setState({ module1Token: null });
                        } else {
                          useStore.setState({ module2Token: null });
                        }
                        navigate(mod.dashboardPath);
                      }}
                      style={{ background: "none", border: "none", cursor: "pointer", marginTop: 10, width: "100%", textAlign: "center", fontSize: 12, fontWeight: 600, color: "#94a3b8", textDecoration: "underline" }}>
                      Switch credentials
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Footer note */}
          <p style={{ textAlign: "center", marginTop: 48, fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>
            Module sessions are active for 8 hours. You must re-authenticate after expiry.
          </p>
        </div>
      </div>
    </>
  );
};

export default ModuleSelection;
