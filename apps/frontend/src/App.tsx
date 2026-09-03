import { useEffect, useState } from "react";
import { Routes, Route, Navigate, Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useSocket, getGlobalSocket } from "./hooks/useSocket";
import { useStore } from "./store/useStore";
import { api, API_BASE } from "./utils/api";
import { Auth } from "./components/Auth";
import { ModuleSelection } from "./components/ModuleSelection";
import ModuleWorkspace from "./components/ModuleWorkspace";
import { DocsPage } from "./modules/docs";
import { GlobalNetworkStatusBanner } from "./components/GlobalNetworkStatusBanner";
import { ShutdownConfirmationModal } from "./components/ShutdownConfirmationModal";
import { PanelLeftClose, PanelLeftOpen, Power } from "lucide-react";
import { SidebarDezproxFooter } from "./components/branding/Dezprox";

const GREEN = "#16a34a";

// ── Route guards ───────────────────────────────────────────────────────────────

// Requires app-level auth. Redirects to /login if no app token.
function RequireAppAuth({ children }: { children: React.ReactNode }) {
  const accessToken = useStore((s) => s.accessToken);
  if (!accessToken) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// ── Module dashboard top bar ───────────────────────────────────────────────────

function ModuleTopBar({
  user,
  handleLogout,
  isSidebarCollapsed,
  toggleSidebar,
  isMarketClosed,
}: {
  user: any;
  handleLogout: () => void;
  isSidebarCollapsed: boolean;
  toggleSidebar: () => void;
  isMarketClosed: boolean;
}) {
  const [time, setTime] = useState(new Date());
  const selectedTimeframe    = useStore((s) => s.selectedTimeframe);
  const setSelectedTimeframe = useStore((s) => s.setSelectedTimeframe);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const timeStr = time.toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  const handleCustomTf = async () => {
    const val = window.prompt("Enter custom timeframe in minutes (e.g. 10, 15, 30):", "10");
    if (!val) return;
    const mins = parseInt(val);
    if (isNaN(mins) || mins <= 0) { alert("Please enter a valid positive number."); return; }
    const customTf = `${mins}m`;
    try {
      await api.post("/api/market/custom-timeframe", { timeframe: customTf });
      setSelectedTimeframe(customTf);
    } catch (err: any) {
      alert("Failed to configure custom timeframe: " + err.message);
    }
  };

  const isCustomTf = !["1m", "3m", "5m"].includes(selectedTimeframe);

  const tfBtn = (active: boolean): React.CSSProperties => ({
    fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 700,
    letterSpacing: "0.05em", padding: "5px 14px", borderRadius: 6,
    border: `1.5px solid ${active ? GREEN : "#d8e0ea"}`,
    background: active ? GREEN : "transparent",
    color: active ? "#fff" : "#5b6b82",
    cursor: "pointer", transition: "all 0.15s",
  });

  const [isShutdownModalOpen, setIsShutdownModalOpen] = useState(false);

  return (
    <>
      <ShutdownConfirmationModal
        isOpen={isShutdownModalOpen}
        onClose={() => setIsShutdownModalOpen(false)}
      />
      <header style={{
        height: 60, display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 24px", background: "#ffffff", borderBottom: "1.5px solid #d8e0ea",
        position: "sticky", top: 0, zIndex: 100,
        boxShadow: "0 1px 4px rgba(15,32,51,0.06)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button
            onClick={toggleSidebar}
            className="hidden md:flex sidebar-toggle-btn"
            title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            {isSidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingRight: 20, borderRight: "1.5px solid #d8e0ea" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8", letterSpacing: "0.08em", textTransform: "uppercase" }}>Time</span>
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 800, color: "#102033" }}>{timeStr}</span>
          </div>

          <div style={{ display: "none", alignItems: "center", gap: 6, paddingRight: 20, borderRight: "1.5px solid #d8e0ea" }}>
            {[{ key: "1m", label: "1M" }, { key: "3m", label: "3M" }, { key: "5m", label: "5M" }].map((tf) => (
              <button key={tf.key} onClick={() => setSelectedTimeframe(tf.key)} style={tfBtn(selectedTimeframe === tf.key)}>
                {tf.label}
              </button>
            ))}
            <button onClick={handleCustomTf} style={tfBtn(isCustomTf)}>
              {isCustomTf ? selectedTimeframe.toUpperCase() : "Custom"}
            </button>
          </div>

          <div style={{ display: "none", alignItems: "center", gap: 6 }}>
            <span style={{
              width: 7, height: 7, borderRadius: "50%", display: "inline-block",
              background: isMarketClosed ? "#dc2626" : GREEN,
              boxShadow: isMarketClosed ? "0 0 0 2px rgba(220,38,38,0.2)" : "0 0 0 2px rgba(22,163,74,0.2)",
            }} className={isMarketClosed ? "" : "animate-pulse"} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#5b6b82" }}>
              Market: <span style={{ color: isMarketClosed ? "#dc2626" : GREEN }}>{isMarketClosed ? "Closed" : "Live"}</span>
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "right", paddingRight: 12, borderRight: "1.5px solid #d8e0ea" }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em" }}>User</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#102033" }}>{user?.name || user?.username || "—"}</div>
          </div>
          <button
            onClick={() => setIsShutdownModalOpen(true)}
            title="Administrative control to shutdown all live market feeds globally"
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 11,
              fontWeight: 700,
              padding: "5px 12px",
              borderRadius: 6,
              border: "1.5px solid #FCA5A5",
              background: "#FEF2F2",
              color: "#991B1B",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              transition: "all 0.15s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = "#FEE2E2";
              e.currentTarget.style.borderColor = "#F87171";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = "#FEF2F2";
              e.currentTarget.style.borderColor = "#FCA5A5";
            }}
          >
            <Power size={13} color="#DC2626" />
            <span>Shutdown All Market Data</span>
          </button>
          <button onClick={handleLogout} style={{
            fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700,
            padding: "5px 14px", borderRadius: 6,
            border: "1.5px solid rgba(220,38,38,0.4)", background: "transparent",
            color: "#dc2626", cursor: "pointer",
          }}>Logout</button>
        </div>
      </header>
    </>
  );
}

// ── Module dashboard sidebar ───────────────────────────────────────────────────

function ModuleSidebar({
  isSidebarCollapsed,
  moduleStatus,
}: {
  isSidebarCollapsed: boolean;
  moduleStatus: { module1: string; module2: string } | undefined;
}) {
  const location     = useLocation();
  const module1Status = useStore((s) => s.module1Status);
  const module2Status = useStore((s) => s.module2Status);

  const navItem = (to: string, label: string, sublabel: string, badge: string, locked: boolean) => {
    const isActive = location.pathname === to;
    return (
      <Link
        to={locked ? "#" : to}
        onClick={(e) => { if (locked) e.preventDefault(); }}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px", borderRadius: 8,
          background: isActive ? GREEN : "transparent",
          textDecoration: "none", transition: "background 0.15s",
          opacity: locked ? 0.45 : 1,
          cursor: locked ? "not-allowed" : "pointer",
        }}
      >
        <span style={{
          fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 800,
          padding: "3px 7px", borderRadius: 5,
          background: isActive ? "rgba(255,255,255,0.2)" : `${GREEN}18`,
          color: isActive ? "#fff" : GREEN, letterSpacing: "0.05em",
        }}>{badge}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: isActive ? "#fff" : "#102033" }}>{label}</span>
          <span style={{ fontSize: 10, fontWeight: 500, color: isActive ? "rgba(255,255,255,0.75)" : "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em" }}>{sublabel}</span>
        </div>
        {locked && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" style={{ marginLeft: "auto", flexShrink: 0 }}>
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        )}
      </Link>
    );
  };

  return (
    <aside className={`hidden md:flex sidebar-aside ${isSidebarCollapsed ? "collapsed" : ""}`}>
      <div style={{ width: 240, display: "flex", flexDirection: "column", height: "100%", flexShrink: 0 }}>
        {/* Logo */}
        <div style={{ height: 72, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 20px", borderBottom: "1.5px solid #d8e0ea" }}>
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 22, fontWeight: 900, color: "#102033", letterSpacing: "-0.01em" }}>TradePro</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 1 }}>Analytics Suite</div>
        </div>

        {/* Back to dashboard */}
        <div style={{ padding: "12px 12px 4px" }}>
          <Link to="/dashboard" style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "7px 10px", borderRadius: 6,
            background: "#f8fafc", border: "1px solid #e2e8f0",
            textDecoration: "none", transition: "all 0.15s",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5b6b82" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#5b6b82" }}>Module Selection</span>
          </Link>
        </div>

        {/* Section label */}
        <div style={{ padding: "12px 20px 6px" }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.15em" }}>Modules</span>
        </div>

        {/* Nav links */}
        <nav style={{ flex: 1, padding: "0 12px", display: "flex", flexDirection: "column", gap: 3 }}>
          {navItem("/dashboard/module-1", "Module 1", "OI Analytics",    "M1",  false)}
          {navItem("/dashboard/module-2", "Module 2", "Strike Tracker",  "M2",  false)}
          <div style={{ height: 1, background: "#e2e8f0", margin: "6px 2px" }} />
          {navItem("/dashboard/docs",     "📖 Documentation", "Platform Guide", "DOC", false)}
        </nav>

        {/* Module connection status */}
        <div style={{ padding: "14px 20px", borderTop: "1.5px solid #d8e0ea", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.15em" }}>Connection Status</div>
          {[
            { label: "Module 1 (Zebu)",   storeStatus: module1Status, apiStatus: moduleStatus?.module1 },
            { label: "Module 2 (Aetram)", storeStatus: module2Status, apiStatus: moduleStatus?.module2 },
          ].map(({ label, storeStatus, apiStatus }) => {
            // Prioritize store status (real auth state) over API status
            let displayStatus = storeStatus === "authenticated" ? "CONNECTED" : storeStatus === "authenticating" ? "WAITING" : apiStatus || "OFFLINE";
            const isConnected = displayStatus === "CONNECTED";
            const waiting = displayStatus === "WAITING";
            const color = isConnected ? GREEN : waiting ? "#d97706" : "#dc2626";
            
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#102033" }}>{label}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", boxShadow: `0 0 0 2px ${color}30` }} />
                  {isConnected ? "Live" : waiting ? "Authenticating" : "Offline"}
                </span>
              </div>
            );
          })}
        </div>

        <SidebarDezproxFooter />
      </div>
    </aside>
  );
}

// ── Module dashboard layout (initializes socket only when inside a module) ─────

function ModuleDashboardLayout({ children }: { children: React.ReactNode }) {
  // Socket is initialized ONLY here — not at the App root.
  // This prevents connect/disconnect loops on login pages.
  useSocket();

  const user      = useStore((s) => s.user);
  const clearAuth = useStore((s) => s.clearAuth);
  const navigate  = useNavigate();

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    () => localStorage.getItem("sidebar-collapsed") === "true"
  );
  const toggleSidebar = () =>
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });

  const { data: marketStatus } = useQuery<{ status: "LIVE" | "CLOSED" }>({
    queryKey: ["market-status"],
    queryFn: () => api.get("/api/market/status"),
    refetchInterval: 15000,
  });

  const { data: moduleStatus } = useQuery<{ module1: string; module2: string }>({
    queryKey: ["module-status"],
    queryFn: () => api.get("/api/module/status"),
    refetchInterval: 10000,
  });

  const handleLogout = async () => {
    const sock = getGlobalSocket();
    try {
      await api.post("/auth/logout", {}, { headers: sock?.id ? { "x-socket-id": sock.id } : undefined });
    } catch {}
    clearAuth();
    navigate("/login", { replace: true });
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#f5f7fa" }}>
      <ModuleSidebar isSidebarCollapsed={isSidebarCollapsed} moduleStatus={moduleStatus} />
      <div className={`main-layout ${isSidebarCollapsed ? "collapsed" : ""}`}>
        <ModuleTopBar
          user={user}
          handleLogout={handleLogout}
          isSidebarCollapsed={isSidebarCollapsed}
          toggleSidebar={toggleSidebar}
          isMarketClosed={marketStatus?.status === "CLOSED"}
        />
        <main style={{ flex: 1, overflowY: "auto" }}>{children}</main>
      </div>
    </div>
  );
}

// ── Root app ───────────────────────────────────────────────────────────────────

function App() {
  const accessToken = useStore((s) => s.accessToken);
  const setAuth     = useStore((s) => s.setAuth);

  const [isInitializing, setIsInitializing] = useState(true);

  if (import.meta.env.DEV) {
    console.log("[App] App() render — isInitializing:", isInitializing, "| accessToken:", !!accessToken);
  }

  // Silent app token refresh on load — only affects app-level auth
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch(`${API_BASE}/auth/refresh`, { method: "POST", credentials: "include" });
        if (import.meta.env.DEV) {
          console.log("[App] /auth/refresh response:", response.status, response.ok);
        }
        if (response.ok) {
          const data = await response.json();
          if (data.accessToken && data.user) {
            setAuth(data.user, data.accessToken);
          }
        }
      } catch (err) {
        console.warn("[App] /auth/refresh failed:", err);
      } finally {
        setIsInitializing(false);
      }
    };
    checkAuth();
  }, [setAuth]);

  // Cross-tab synchronization strictly for Global Shutdown
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("tradepro_global_channel");
    bc.onmessage = (event) => {
      const type = event.data?.type;
      if (type === "GLOBAL_SHUTDOWN") {
        console.log("[App/CrossTab] Global shutdown event received across tabs");
        sessionStorage.removeItem("m1_token");
        sessionStorage.removeItem("m2_token");
        useStore.setState({
          module1Token: null,
          module2Token: null,
          module1Status: "idle",
          module2Status: "idle",
          module2BrokerStatus: "broker-disconnected",
        });
        if (window.location.pathname.includes("/dashboard/module-")) {
          window.location.href = "/dashboard";
        }
      }
    };
    return () => {
      bc.close();
    };
  }, []);



  if (isInitializing) {
    return (
      <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "#f5f7fa", fontFamily: "'Inter', sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <span style={{ width: 28, height: 28, borderRadius: "50%", border: `3px solid ${GREEN}`, borderTopColor: "transparent", display: "inline-block" }} className="animate-spin" />
          <span style={{ fontSize: 13, fontWeight: 600, color: "#5b6b82" }}>Synchronising session…</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');`}</style>
      <GlobalNetworkStatusBanner />
      <Routes>
        {/* ── PUBLIC: App login ─────────────────────────────────────────── */}
        <Route path="/login" element={accessToken ? <Navigate to="/dashboard" replace /> : <Auth />} />

        {/* ── DASHBOARD SHELL: all /dashboard/* routes share the same layout ─ */}
        <Route
          path="/dashboard/*"
          element={
            <RequireAppAuth>
              <ModuleDashboardLayout>
                <Outlet />
              </ModuleDashboardLayout>
            </RequireAppAuth>
          }
        >
          <Route index element={<ModuleSelection />} />
          <Route path="home" element={<ModuleSelection />} />
          <Route path="module-1" element={<ModuleWorkspace moduleId="module1" />} />
          <Route path="module-2" element={<ModuleWorkspace moduleId="module2" />} />
          <Route path="docs" element={<DocsPage />} />
        </Route>

        {/* ── Catch-all ─────────────────────────────────────────────────── */}
        <Route path="*" element={<Navigate to={accessToken ? "/dashboard" : "/login"} replace />} />
      </Routes>
    </>
  );
}

export default App;
