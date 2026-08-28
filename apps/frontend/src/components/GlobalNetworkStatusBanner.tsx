import { useState, useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { useDashStore } from "../modules/dashboard/store";
import { api } from "../utils/api";
import { getGlobalSocket } from "../hooks/useSocket";

export type GlobalBannerState = "offline" | "requires-relogin" | "socket-interrupted" | null;

export function GlobalNetworkStatusBanner() {
  const clearAuth = useStore((s) => s.clearAuth);
  const feedStatus = useDashStore((s) => s.feedStatus);

  const [bannerState, setBannerState] = useState<GlobalBannerState>(() => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return "offline";
    }
    return null;
  });

  const hadNetworkLossRef = useRef<boolean>(typeof navigator !== "undefined" ? !navigator.onLine : false);

  useEffect(() => {
    const handleOffline = () => {
      hadNetworkLossRef.current = true;
      setBannerState("offline");
    };

    const handleOnline = () => {
      // When network comes back after being offline, enter requires-relogin state
      if (hadNetworkLossRef.current) {
        setBannerState("requires-relogin");
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  // React to socket status when browser is online
  useEffect(() => {
    const isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
    if (!isOnline) {
      if (bannerState !== "offline") setBannerState("offline");
      return;
    }

    if (bannerState === "requires-relogin") {
      // Must stay in requires-relogin until user logs out
      return;
    }

    if (feedStatus === "reconnecting" || feedStatus === "no-network") {
      setBannerState("socket-interrupted");
    } else if (feedStatus === "live" && bannerState === "socket-interrupted") {
      setBannerState(null);
    }
  }, [feedStatus, bannerState]);

  if (!bannerState) return null;

  const handleLogoutAndRelogin = async () => {
    const sock = getGlobalSocket();
    try {
      await api.post("/auth/logout", {}, { headers: sock?.id ? { "x-socket-id": sock.id } : undefined });
    } catch {}
    clearAuth();
    window.location.href = "/login";
  };

  if (bannerState === "offline") {
    return (
      <div
        role="alert"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 9999,
          background: "#FEF2F2",
          borderBottom: "1.5px solid #FCA5A5",
          color: "#991B1B",
          padding: "10px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 14,
          fontWeight: 700,
          boxShadow: "0 2px 6px rgba(153, 27, 27, 0.12)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>🔴 Network connection lost. Please check your internet connection.</span>
        </div>
      </div>
    );
  }

  if (bannerState === "requires-relogin") {
    return (
      <div
        role="alert"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 9999,
          background: "#F0FDF4",
          borderBottom: "1.5px solid #86EFAC",
          color: "#166534",
          padding: "10px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 14,
          fontWeight: 700,
          boxShadow: "0 2px 6px rgba(22, 101, 52, 0.12)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>🟢 Network connection restored. Please logout and login again to continue.</span>
        </div>
        <button
          onClick={handleLogoutAndRelogin}
          style={{
            background: "#DC2626",
            color: "#FFFFFF",
            border: "none",
            borderRadius: 6,
            padding: "6px 16px",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
            transition: "background 0.15s",
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = "#B91C1C")}
          onMouseOut={(e) => (e.currentTarget.style.background = "#DC2626")}
        >
          Logout &amp; Login Again
        </button>
      </div>
    );
  }

  if (bannerState === "socket-interrupted") {
    return (
      <div
        role="alert"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 9999,
          background: "#FFFBEB",
          borderBottom: "1.5px solid #FCD34D",
          color: "#92400E",
          padding: "10px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 14,
          fontWeight: 700,
          boxShadow: "0 2px 6px rgba(146, 64, 14, 0.1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>⚠️ Connection interrupted. Reconnecting...</span>
        </div>
      </div>
    );
  }

  return null;
}
