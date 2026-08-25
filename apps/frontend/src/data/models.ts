// ── Trading-selection data models ─────────────────────────────────────────────
//
// The selection UI (Exchange → Instrument → Symbol → Expiry → Strike) consumes
// ONLY these models. All of it is fetched live from the broker's instrument
// master via liveApi.ts — nothing is a static/hardcoded catalog.
//
// Broker symbols and tokens are internal — never rendered in the UI; they are
// used for market-data subscriptions and order placement only.

export interface Expiry {
  /** Internal ISO date "YYYY-MM-DD", e.g. "2026-07-07" */
  id: string;
  /** Display label, e.g. "07 Jul 2026" */
  expiry: string;
}

export interface Strike {
  value: number;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO "2026-07-07" → display "07 Jul 2026". Returns "" for empty/invalid input. */
export function formatExpiryDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  const [, y, mo, d] = m;
  return `${d} ${MONTHS_SHORT[Number(mo) - 1]} ${y}`;
}

/** ISO "2026-07-07" → broker expiry fragment "07JUL26" (internal use only). */
export function formatExpiryForBroker(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  const [, y, mo, d] = m;
  return `${d}${MONTHS_SHORT[Number(mo) - 1].toUpperCase()}${y.slice(-2)}`;
}
