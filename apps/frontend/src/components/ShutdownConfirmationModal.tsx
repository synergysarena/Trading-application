import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../utils/api";
import { useDashStore } from "../modules/dashboard/store";
import { useStore } from "../store/useStore";
import { getGlobalSocket } from "../hooks/useSocket";
import { AlertTriangle } from "lucide-react";

interface ShutdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function ShutdownConfirmationModal({ isOpen, onClose, onSuccess }: ShutdownModalProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const setFeedStatus = useDashStore((s) => s.setFeedStatus);
  const setModule1Token = useStore((s) => s.setModule1Token);
  const setModule2Token = useStore((s) => s.setModule2Token);
  const setModule1Status = useStore((s) => s.setModule1Status);
  const setModule2Status = useStore((s) => s.setModule2Status);
  const setModule2BrokerStatus = useStore((s) => s.setModule2BrokerStatus);

  if (!isOpen) return null;

  const handleConfirmShutdown = async () => {
    if (isShuttingDown) return; // Prevent duplicate clicks
    setIsShuttingDown(true);
    setErrorMsg(null);

    const sock = getGlobalSocket();

    try {
      const response = await api.post(
        "/api/system/market-data/shutdown",
        {},
        { headers: sock?.id ? { "x-socket-id": sock.id } : undefined }
      );
      console.log("[System/MarketData] Global shutdown executed successfully:", response.data);

      // 1. Clear session tokens from storage and store
      sessionStorage.removeItem("m1_token");
      sessionStorage.removeItem("m2_token");
      setModule1Token(null);
      setModule2Token(null);

      // 2. Reset module & broker connection states
      setFeedStatus("broker-disconnected");
      setModule1Status("idle");
      setModule2Status("idle");
      setModule2BrokerStatus("broker-disconnected");

      // 3. Invalidate module status queries
      queryClient.invalidateQueries({ queryKey: ["module-status"] });

      // 4. Notify other tabs via BroadcastChannel
      if (typeof BroadcastChannel !== "undefined") {
        try {
          const bc = new BroadcastChannel("tradepro_global_channel");
          bc.postMessage({ type: "GLOBAL_SHUTDOWN" });
          bc.close();
        } catch {}
      }

      // 5. Notify & navigate to Module Selection
      alert("All market data has been shut down.");
      if (onSuccess) onSuccess();
      onClose();
      navigate("/dashboard");
    } catch (err: any) {
      console.error("[System/MarketData] Global shutdown request failed:", err);
      setErrorMsg(
        err.response?.data?.error ||
        err.message ||
        "Failed to execute global shutdown."
      );
    } finally {
      setIsShuttingDown(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        background: "rgba(15, 23, 42, 0.75)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isShuttingDown) onClose();
      }}
    >
      <div
        style={{
          background: "#FFFFFF",
          borderRadius: 12,
          padding: "24px 28px",
          width: "100%",
          maxWidth: 480,
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.2)",
          border: "1px solid #E2E8F0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div
            style={{
              background: "#FEE2E2",
              color: "#DC2626",
              borderRadius: "50%",
              width: 40,
              height: 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <AlertTriangle size={22} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#0F172A" }}>
              Shutdown All Market Data?
            </h3>
            <span style={{ fontSize: 12, color: "#64748B", fontWeight: 500 }}>
              Global market-data termination
            </span>
          </div>
        </div>

        <p style={{ fontSize: 14, color: "#334155", lineHeight: 1.6, margin: "0 0 12px 0" }}>
          This will disconnect Module 1 (Zebu) and Module 2 (Aetram), stop live market-data processing, and end the current active market-data sessions.
        </p>

        <div
          style={{
            background: "#FFFBEB",
            border: "1px solid #FCD34D",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 20,
            fontSize: 13,
            color: "#92400E",
            lineHeight: 1.5,
          }}
        >
          Make sure no other TradePro tab is currently using the market data.
        </div>

        {errorMsg && (
          <div
            style={{
              background: "#FEF2F2",
              border: "1px solid #FCA5A5",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 16,
              fontSize: 13,
              color: "#991B1B",
            }}
          >
            {errorMsg}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button
            onClick={onClose}
            disabled={isShuttingDown}
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 13,
              fontWeight: 600,
              padding: "8px 18px",
              borderRadius: 6,
              border: "1px solid #CBD5E1",
              background: "#F8FAFC",
              color: "#475569",
              cursor: isShuttingDown ? "not-allowed" : "pointer",
              transition: "all 0.15s",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmShutdown}
            disabled={isShuttingDown}
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 13,
              fontWeight: 700,
              padding: "8px 20px",
              borderRadius: 6,
              border: "none",
              background: isShuttingDown ? "#991B1B" : "#DC2626",
              color: "#FFFFFF",
              cursor: isShuttingDown ? "not-allowed" : "pointer",
              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
              transition: "background 0.15s",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
            onMouseOver={(e) => {
              if (!isShuttingDown) e.currentTarget.style.background = "#B91C1C";
            }}
            onMouseOut={(e) => {
              if (!isShuttingDown) e.currentTarget.style.background = "#DC2626";
            }}
          >
            {isShuttingDown ? (
              <>
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: "2px solid #ffffff",
                    borderTopColor: "transparent",
                    display: "inline-block",
                  }}
                  className="animate-spin"
                />
                Shutting Down...
              </>
            ) : (
              "Confirm Shutdown"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
