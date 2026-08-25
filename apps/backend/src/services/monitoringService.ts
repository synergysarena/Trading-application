import { readLive } from "./redisWriteBuffer";
import { isZebuLiveConnected } from "./zebuMarketDataClient";
import { isAetramConnected, getActiveSubscribedInstruments } from "./aetramMarketDataService";
import { getStatus as getWebSocketStatus } from "./marketDataWebSocketService";
import { isMarketDataAuthenticated } from "./marketDataSessionService";

let lastTickTimeModule1 = Date.now();
let lastTickTimeModule2 = Date.now();
let lastAlertSummary = "";

/**
 * Call this whenever a new tick is received to update the freshness timestamp for the specified module.
 */
export const recordTickReceived = (moduleId: "module1" | "module2" = "module1") => {
  const now = Date.now();
  if (moduleId === "module2") {
    lastTickTimeModule2 = now;
    console.log(`[MODULE2][MONITOR] module2 lastTickAt updated: ${new Date(now).toISOString()}`);
  } else {
    lastTickTimeModule1 = now;
  }
};

/**
 * Evaluates the status of the live data feed, cached prices, and generates alerts if needed.
 * Module 1 (Zebu) and Module 2 (Aetram) are evaluated completely independently.
 */
export const getMonitoringStatus = async () => {
  const now = Date.now();
  const secondsSinceModule1Tick = (now - lastTickTimeModule1) / 1000;
  const secondsSinceModule2Tick = (now - lastTickTimeModule2) / 1000;
  
  // Memory-first cached price reads for spot and fut
  const spotLtp = await readLive("ltp:NIFTY-SPOT");
  const futLtp = await readLive("ltp:NIFTY-FUT");
  
  const alerts: string[] = [];

  // ── Module 1 (Zebu) Independent Evaluation ─────────────────────────
  const zebuLive = isZebuLiveConnected();
  let module1Status: "LIVE" | "DISCONNECTED" | "STALE" = "DISCONNECTED";

  if (zebuLive) {
    if (secondsSinceModule1Tick > 30) {
      module1Status = "STALE";
      alerts.push(`Module 1 (Zebu) live feed data freshness alert: No ticks received for ${secondsSinceModule1Tick.toFixed(1)} seconds.`);
    } else {
      module1Status = "LIVE";
    }

    if (!spotLtp || parseFloat(spotLtp) === 0) {
      alerts.push("Spot LTP is missing or zero.");
    }
    if (!futLtp || parseFloat(futLtp) === 0) {
      alerts.push("Futures LTP is missing or zero.");
    }
  } else {
    module1Status = "DISCONNECTED";
    alerts.push("Module 1 (Zebu): DISCONNECTED — waiting for broker login/reconnection.");
  }

  // ── Module 2 (Aetram) Independent Evaluation ────────────────────────
  const aetramWs = getWebSocketStatus();
  const aetramAuth = isMarketDataAuthenticated();
  const activeSubsCount = getActiveSubscribedInstruments().length;
  let module2Status: "LIVE" | "DISCONNECTED" | "RECONNECTING" | "STALE" = "DISCONNECTED";

  if (aetramWs.state === "CONNECTED" && aetramAuth) {
    if (secondsSinceModule2Tick > 30 && activeSubsCount > 0) {
      module2Status = "STALE";
      alerts.push(`Module 2 (Aetram) live feed data freshness alert: No ticks received for ${secondsSinceModule2Tick.toFixed(1)} seconds.`);
    } else {
      module2Status = "LIVE";
    }
  } else if (aetramWs.state === "CONNECTING" || aetramWs.state === "RECONNECTING") {
    module2Status = "RECONNECTING";
    alerts.push(`Module 2 (Aetram) live feed reconnecting (state: ${aetramWs.state}).`);
  } else {
    module2Status = "DISCONNECTED";
    alerts.push("Module 2 (Aetram): DISCONNECTED — waiting for broker login/reconnection.");
  }

  // ── Diagnostic Logging & Alert Deduplication ───────────────────────
  const currentAlertSummary = alerts.join(" | ");
  if (currentAlertSummary !== lastAlertSummary) {
    lastAlertSummary = currentAlertSummary;
    console.log(`[MONITOR][STATUS] Module1: ${module1Status} | Module2: ${module2Status} (AetramWS: ${aetramWs.state}, Auth: ${aetramAuth ? "ACTIVE" : "INACTIVE"}, Subs: ${activeSubsCount}, LastTick: ${secondsSinceModule2Tick.toFixed(1)}s ago)`);
    if (alerts.length > 0) {
      console.warn(`[MONITOR] Active Alerts:\n${alerts.map(a => ` - ${a}`).join("\n")}`);
    }
  }

  return {
    status: alerts.length === 0 ? "OK" : "WARNING",
    module1Status,
    module2Status,
    lastTickTimeModule1: new Date(lastTickTimeModule1),
    lastTickTimeModule2: new Date(lastTickTimeModule2),
    secondsSinceModule1Tick,
    secondsSinceModule2Tick,
    aetramWsState: aetramWs.state,
    aetramAuth,
    activeSubsCount,
    alerts,
    metrics: {
      spotLtp: spotLtp ? parseFloat(spotLtp) : null,
      futLtp: futLtp ? parseFloat(futLtp) : null,
    }
  };
};

let monitoringInterval: NodeJS.Timeout | null = null;

/**
 * Starts a background loop to perform validation checks every 10 seconds.
 * Safe to call multiple times — prevents duplicate intervals.
 */
export const startMonitoringLoop = () => {
  if (monitoringInterval) return;
  console.log("[MonitoringService] Active validation and freshness loop started.");
  monitoringInterval = setInterval(async () => {
    try {
      await getMonitoringStatus();
    } catch (err) {
      console.error("[MonitoringService] Error running monitoring status checks:", err);
    }
  }, 10000);
};

export const stopMonitoringLoop = () => {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
};

