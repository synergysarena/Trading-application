import { getModule1PersistStats } from "./ohlcAggregator";
import { getPivotQueueStats } from "./pivotService";
import { getModule1FeedStats } from "./dataFeed";
import { isMarketDataProcessingEnabled } from "./marketDataLifecycle";
import { mongoConnectionStateName } from "../config/db";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 instrumentation — a single throttled health line for the Module 1
// persistence + pivot pipeline. This is the production probe for "is the queue
// growing / are candles lagging / is the WS flapping / is memory climbing".
//
// Logging cadence:
//   • every HEALTHY_INTERVAL_MS while everything is nominal (quiet heartbeat),
//   • immediately (rate-limited to ALERT_MIN_GAP_MS) when a threshold trips.
// Never one line per tick / per candle.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 15_000;
const HEALTHY_INTERVAL_MS = 5 * 60_000;
const ALERT_MIN_GAP_MS = 15_000;

// Thresholds that flip the line from heartbeat → alert.
const PERSIST_QUEUE_WARN = 2_000;
const PERSIST_LAG_WARN_MS = 20_000;
const PIVOT_QUEUE_WARN = 4_000;
const RSS_WARN_MB = 900;

let timer: NodeJS.Timeout | null = null;
let lastHealthyLogAt = 0;
let lastAlertLogAt = 0;
let baselineReconnects = 0;

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

const sample = (): void => {
  if (!isMarketDataProcessingEnabled()) return;

  const persist = getModule1PersistStats();
  const pivot = getPivotQueueStats();
  const feed = getModule1FeedStats();
  const mem = process.memoryUsage();

  const rssMb = mb(mem.rss);
  const heapMb = mb(mem.heapUsed);
  const wsReconnects = feed.totalReconnects - baselineReconnects;

  const alerting =
    persist.queueDepth >= PERSIST_QUEUE_WARN ||
    persist.oldestQueuedAgeMs >= PERSIST_LAG_WARN_MS ||
    persist.permanentFailures > 0 ||
    persist.deadLetterSize > 0 ||
    pivot.queueDepth >= PIVOT_QUEUE_WARN ||
    pivot.dropped > 0 ||
    rssMb >= RSS_WARN_MB;

  const now = Date.now();
  if (!alerting && now - lastHealthyLogAt < HEALTHY_INTERVAL_MS) return;
  if (alerting && now - lastAlertLogAt < ALERT_MIN_GAP_MS) return;
  if (alerting) lastAlertLogAt = now;
  lastHealthyLogAt = now;

  const tag = alerting ? "[MODULE1][HEALTH][ALERT]" : "[MODULE1][HEALTH]";
  console.log(
    `${tag} ` +
    `persistQueue=${persist.queueDepth} persistLagMs=${persist.oldestQueuedAgeMs} ` +
    `persistBatch=${persist.lastBatchSize} persistWriteMs=${persist.lastWriteMs} ` +
    `persisted=${persist.persisted} persistRetries=${persist.retryCount} ` +
    `persistPermFail=${persist.permanentFailures} deadLetter=${persist.deadLetterSize} ` +
    `persistBackoffMs=${persist.backoffMs} | ` +
    `pivotQueue=${pivot.queueDepth} pivotProcessed=${pivot.processed} pivotDropped=${pivot.dropped} ` +
    `pivotExhausted=${pivot.exhausted} pivotWriteMs=${pivot.lastWriteMs} pivotBatch=${pivot.lastBatchSize} ` +
    `pivotErrors=${pivot.writeErrors} pivotRetries=${pivot.retries} pivotBackoffMs=${pivot.backoffMs} | ` +
    `wsConnected=${feed.connected} wsReconnects=${wsReconnects} wsLastReason="${feed.lastDisconnectReason}" | ` +
    `rssMB=${rssMb} heapMB=${heapMb} mongo=${mongoConnectionStateName()}`
  );
};

export const startModule1PersistHealthLogger = (): void => {
  if (timer) return;
  baselineReconnects = getModule1FeedStats().totalReconnects;
  timer = setInterval(() => {
    try { sample(); } catch (err: any) {
      console.warn("[MODULE1][HEALTH] sampler error:", err?.message || err);
    }
  }, SAMPLE_INTERVAL_MS);
  console.log(`[MODULE1][HEALTH] Persistence-health logger started (sample ${SAMPLE_INTERVAL_MS / 1000}s, heartbeat ${HEALTHY_INTERVAL_MS / 1000}s).`);
};

export const stopModule1PersistHealthLogger = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
