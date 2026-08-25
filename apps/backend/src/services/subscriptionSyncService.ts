import { marketDataEvents } from "./marketDataEvents";
import { getAllActiveSubscriptions, SubscriptionRecord } from "./subscriptionService";
import { subscribeToInstruments } from "./aetramMarketDataService";
import { getStatus as getWebSocketStatus } from "./marketDataWebSocketService";

/**
 * Subscription Synchronization layer (Phase 6, Step 3).
 *
 * Bridges the Phase 4 subscription registry to the shared WebSocket
 * connection's lifecycle: whenever marketDataWebSocketService reports the
 * socket is (re)connected, this reads every ACTIVE subscription across all
 * sessions and re-sends them to Aetram via the existing (unchanged)
 * subscribeToInstruments REST call. On a real reconnect, Aetram's server-side
 * subscription state is tied to the old socket, so everything must be resent
 * — this is exactly what "automatically resubscribe all ACTIVE subscriptions"
 * means here.
 *
 * Also reacts to SUBSCRIPTION_REGISTERED (emitted by subscriptionService right
 * after subscribe()/bulkSubscribe() adds a new ACTIVE record): if the socket
 * is already CONNECTED at that moment, CONNECTED/RECONNECTED already fired in
 * the past and won't fire again until the next reconnect, so the new
 * subscription would otherwise never reach the broker until then. This does
 * not duplicate the CONNECTED/RECONNECTED path — it reuses the same
 * syncActiveSubscriptions() function, which always resends the full deduped
 * ACTIVE set and is guarded by the same `syncing` in-flight lock.
 *
 * Does NOT process ticks, decode packets, or touch Redis/Mongo — it only
 * decides what instruments the broker should be told about.
 */

export type SyncState = "IDLE" | "SYNCING" | "SYNCED" | "FAILED";
export type SyncTrigger = "CONNECTED" | "RECONNECTED" | "SUBSCRIPTION_REGISTERED";

export interface SyncStatus {
  state: SyncState;
  lastSyncedAt: string | null;
  lastSyncCount: number;
  lastError: string | null;
}

let state: SyncState = "IDLE";
let lastSyncedAt: Date | null = null;
let lastSyncCount = 0;
let lastError: string | null = null;
let syncing = false; // guards against an overlapping sync if CONNECTED/RECONNECTED fire in quick succession
let pendingRetrigger: SyncTrigger | null = null; // set when a trigger is skipped while syncing, so it isn't lost
let initialized = false;

/** Collapses cross-session duplicates — the broker subscribes by instrument token, not by our session concept. */
const dedupeByInstrumentId = (records: SubscriptionRecord[]): SubscriptionRecord[] => {
  const seen = new Set<string>();
  const deduped: SubscriptionRecord[] = [];
  for (const r of records) {
    if (seen.has(r.exchangeInstrumentID)) continue;
    seen.add(r.exchangeInstrumentID);
    deduped.push(r);
  }
  return deduped;
};

const syncActiveSubscriptions = async (trigger: SyncTrigger): Promise<void> => {
  if (syncing) {
    // Don't drop it — a subscription registered mid-sync must still reach the
    // broker. Record it and re-run once the in-flight sync finishes; that
    // re-run always reads the registry fresh, so it naturally includes
    // whatever prompted this trigger.
    console.warn(`[SubscriptionSync] Sync already in progress — deferring trigger (${trigger}) until it completes.`);
    pendingRetrigger = trigger;
    return;
  }
  syncing = true;
  state = "SYNCING";

  try {
    const active = getAllActiveSubscriptions();
    const deduped = dedupeByInstrumentId(active);
    const skipped = active.length - deduped.length;

    if (deduped.length === 0) {
      console.log(`[SubscriptionSync] ${trigger} — no active subscriptions to synchronize.`);
      state = "SYNCED";
      lastSyncedAt = new Date();
      lastSyncCount = 0;
      lastError = null;
      return;
    }

    console.log(
      `[SubscriptionSync] ${trigger} — synchronizing ${deduped.length} active subscription(s)` +
      (skipped > 0 ? ` (${skipped} cross-session duplicate(s) skipped).` : ".")
    );

    await subscribeToInstruments(deduped.map((r) => ({ segment: r.exchangeSegment, token: r.exchangeInstrumentID })));

    state = "SYNCED";
    lastSyncedAt = new Date();
    lastSyncCount = deduped.length;
    lastError = null;
    marketDataEvents.emit("SUBSCRIBED", {
      count: deduped.length,
      exchangeInstrumentIDs: deduped.map((r) => r.exchangeInstrumentID),
    });
    console.log(`[SubscriptionSync] Synchronized ${deduped.length} subscription(s).`);
  } catch (err: any) {
    state = "FAILED";
    lastError = err?.message || String(err);
    console.error("[SubscriptionSync] Sync failed:", lastError);
    marketDataEvents.emit("SUBSCRIPTION_FAILED", { reason: lastError, attemptedCount: 0 });
  } finally {
    syncing = false;
    if (pendingRetrigger) {
      const deferred = pendingRetrigger;
      pendingRetrigger = null;
      syncActiveSubscriptions(deferred);
    }
  }
};

/** Called once at server startup. Idempotent — a second call is a no-op. */
export const initSubscriptionSync = (): void => {
  if (initialized) return;
  initialized = true;

  marketDataEvents.on("CONNECTED", () => {
    syncActiveSubscriptions("CONNECTED");
  });
  marketDataEvents.on("RECONNECTED", () => {
    syncActiveSubscriptions("RECONNECTED");
  });
  marketDataEvents.on("SUBSCRIPTION_REGISTERED", () => {
    // Only relevant if the socket is already up right now — if it isn't, the
    // eventual CONNECTED handler above will pick up this subscription as part
    // of its full sync, so there is nothing to do here.
    if (getWebSocketStatus().state !== "CONNECTED") return;
    syncActiveSubscriptions("SUBSCRIPTION_REGISTERED");
  });

  console.log("[SubscriptionSync] Initialized — will resynchronize active subscriptions on CONNECTED/RECONNECTED/SUBSCRIPTION_REGISTERED.");
};

export const getSyncStatus = (): SyncStatus => ({
  state,
  lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
  lastSyncCount,
  lastError,
});
