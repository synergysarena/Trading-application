import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { api } from "../utils/api";
import Module1LoginPanel from "./Module1LoginPanel";
import Module2LoginPanel from "./Module2LoginPanel";
import { Module1 } from "./Module1";
import { Module2 } from "./Module2";
import { Module2Live } from "./Module2Live";

// ── Module 1 session-restore reconnection ──────────────────────────────────
//
// module1Token (sessionStorage, 8h JWT) surviving a refresh/reopen only means
// the FRONTEND still considers itself authenticated. The actual Zebu live
// feed is a separate, backend-process-scoped resource (dataFeed.ts) that is
// only ever started from Module1LoginPanel's credentialed submit — nothing
// previously re-started it when a cached token skipped straight to the
// dashboard, so the dashboard sat Offline until the user manually cleared
// the token via "Switch Credentials" and logged in again.
//
// This fires exactly once, and ONLY when module1Token was ALREADY present on
// this component's very first render (a genuinely restored session — e.g.
// page reload, or navigating here with a still-valid cached token). It must
// NOT fire for a token that was just set by Module1LoginPanel's own submit
// within this same mount — that path already starts the feed itself, and
// re-triggering a resume immediately after would force a redundant
// close-then-reopen of the connection it just opened. hadTokenOnMount is
// captured once via useRef's lazy initializer, so a null->token transition
// during this mount's lifetime (fresh login) never flips it retroactively.
function useResumeModule1Session(active: boolean, module1Token: string | null) {
  const hadTokenOnMount = useRef(module1Token !== null);
  const fired = useRef(false);
  const setModule1Status = useStore((s) => s.setModule1Status);

  useEffect(() => {
    if (!active || !hadTokenOnMount.current || fired.current) return;
    fired.current = true;

    setModule1Status("authenticating");
    api.post("/auth/module1-resume-session", {}, { skipAuth: true })
      .then((res: { result?: string }) => {
        console.log(`[ModuleWorkspace] Module 1 session resume: ${res?.result ?? "unknown"}`);
        // Actual live/offline state still comes from the broker_status socket
        // event and the dashboard's own /api/market/status polling — this
        // just unblocks the sidebar's "storeStatus" badge from sitting at its
        // idle default after a restore, mirroring what a fresh login already
        // does for it.
        setModule1Status("authenticated");
      })
      .catch((err: any) => {
        console.warn("[ModuleWorkspace] Module 1 session resume failed:", err?.message || err);
        // Non-fatal: the dashboard's existing StatusPanel (broker-disconnected
        // / api-error, both with a Retry button) already handles "no live
        // feed" gracefully — this isn't a new failure mode, just an earlier
        // chance to recover from the same one automatically.
        setModule1Status("error", "Could not resume the previous broker session.");
      });
  }, [active, setModule1Status]);
}

const GREEN = "#047857";

// Toggle SHOW_LIVE_INSTRUMENT_WATCH_TAB to true if client wants to re-enable "Live Instrument Watch" tab UI
const SHOW_LIVE_INSTRUMENT_WATCH_TAB = false;

// Module2.tsx (Strike Tracker) is untouched — built on trackerService's
// session/grid model. Module2Live.tsx (Live Instrument Watch) is a separate
// screen wired to the Phase 3-12 instrument/subscription/socket backend.
// This tab switcher is the only "wiring" point between the two; neither
// screen knows the other exists.
function Module2Tabs() {
  const [tab, setTab] = useState<"tracker" | "live">("tracker");

  const tabBtn = (key: "tracker" | "live"): React.CSSProperties => ({
    fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 700,
    padding: "8px 16px", borderRadius: 8, cursor: "pointer",
    border: `1.5px solid ${tab === key ? GREEN : "var(--trading-border)"}`,
    background: tab === key ? GREEN : "transparent",
    color: tab === key ? "#fff" : "var(--trading-text-muted)",
  });

  if (!SHOW_LIVE_INSTRUMENT_WATCH_TAB) {
    return <Module2 />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ display: "flex", gap: 8, padding: "12px 24px 0", background: "var(--trading-bg)" }}>
        <button style={tabBtn("tracker")} onClick={() => setTab("tracker")}>Strike Tracker</button>
        <button style={tabBtn("live")} onClick={() => setTab("live")}>Live Instrument Watch</button>
      </div>
      {tab === "tracker" ? <Module2 /> : <Module2Live />}
    </div>
  );
}

export function ModuleWorkspace({ moduleId }: { moduleId: "module1" | "module2" }) {
  const module1Token = useStore((s) => s.module1Token);
  const module2Token = useStore((s) => s.module2Token);

  useResumeModule1Session(moduleId === "module1", module1Token);

  if (moduleId === "module1") {
    if (!module1Token) return <Module1LoginPanel />;
    return <Module1 />;
  }

  if (moduleId === "module2") {
    if (!module2Token) return <Module2LoginPanel />;
    return <Module2Tabs />;
  }

  return null;
}

export default ModuleWorkspace;
