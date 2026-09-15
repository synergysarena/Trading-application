import { getMonitoringStatus } from "./monitoringService";
import { getModule1FeedStats } from "./dataFeed";
import { getModule1PersistStats } from "./ohlcAggregator";
import { getCachedInstrumentTokens } from "./instrumentTokenService";
import { mongoConnectionStateName, isMongoConnected } from "../config/db";
import { getModule2RuntimeStats } from "./trackerService";

/**
 * A single concise health line for Module 1 and one for Module 2, every 5
 * minutes — purely observational, reading the same counters/state the
 * existing monitoring (monitoringService, module1PersistHealth,
 * getModule2RuntimeStats) already maintain. Never restarts, reconnects, or
 * mutates anything; it only reads and prints.
 */
const HEALTH_SUMMARY_INTERVAL_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;

const mark = (ok: boolean) => (ok ? "✓" : "✗"); // ✓ / ✗

const logModule1Health = (mongoOk: boolean, module1Status: string) => {
  const feed = getModule1FeedStats();
  const persist = getModule1PersistStats();
  const tokens = getCachedInstrumentTokens();
  const instrumentCount = tokens
    ? tokens.ceTokens.length + tokens.peTokens.length + (tokens.futToken ? 1 : 0)
    : null;

  const persistHealthy = persist.queueDepth < 2_000 && persist.permanentFailures === 0;
  const receiving = module1Status === "LIVE";

  const label = !feed.connected
    ? "DISCONNECTED"
    : receiving && persistHealthy && mongoOk
      ? "RUNNING"
      : "DEGRADED";
  const icon = label === "DISCONNECTED" ? "✗" : label === "RUNNING" ? "✓" : "⚠";

  console.log(
    `[MODULE1][HEALTH] ${icon} ${label} | Feed ${mark(feed.connected)}` +
    (instrumentCount !== null ? ` | Instruments: ${instrumentCount}` : "") +
    ` | Ticks ${mark(receiving)} | OHLC ${mark(persistHealthy)}` +
    ` | Mongo ${mark(mongoOk)} (${mongoConnectionStateName()})` +
    ` | Persist Queue: ${persist.queueDepth} | Reconnects: ${feed.totalReconnects}`
  );
};

const logModule2Health = (mongoOk: boolean, module2Status: string) => {
  const stats = getModule2RuntimeStats();
  const receiving = module2Status === "LIVE";
  const connected = module2Status === "LIVE" || module2Status === "STALE";
  const persistHealthy = stats.subscriptionFailures === 0;

  const label =
    module2Status === "DISCONNECTED"
      ? "DISCONNECTED"
      : module2Status === "RECONNECTING"
        ? "RECONNECTING"
        : receiving && persistHealthy && mongoOk
          ? "RUNNING"
          : "DEGRADED";
  const icon = label === "DISCONNECTED" ? "✗" : label === "RUNNING" ? "✓" : "⚠";

  console.log(
    `[MODULE2][HEALTH] ${icon} ${label} | Aetram/XTS ${mark(connected)}` +
    ` | Market Data ${mark(receiving)} | Selected Strikes: ${stats.selectedStrikes}` +
    ` | Persistence ${mark(persistHealthy)} | Mongo ${mark(mongoOk)} (${mongoConnectionStateName()})`
  );
};

const logHealthSummary = async (): Promise<void> => {
  const monitoring = await getMonitoringStatus();
  const mongoOk = isMongoConnected();
  logModule1Health(mongoOk, monitoring.module1Status);
  logModule2Health(mongoOk, monitoring.module2Status);
};

export const startHealthSummaryLogger = (): void => {
  if (timer) return;
  timer = setInterval(() => {
    logHealthSummary().catch((err: any) => {
      console.warn("[HEALTH] Summary logger error:", err?.message || err);
    });
  }, HEALTH_SUMMARY_INTERVAL_MS);
};

export const stopHealthSummaryLogger = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
