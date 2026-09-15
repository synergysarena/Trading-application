/**
 * Minimal production log-level gate.
 *
 * Default (LOG_LEVEL unset or "info"): high-frequency per-tick / per-candle /
 * per-message diagnostics are suppressed. Errors, warnings, and normal
 * lifecycle/auth/health logs (plain console.error/console.warn/console.log
 * calls elsewhere in the codebase) are never affected by this gate.
 *
 * Debug (LOG_LEVEL=debug): the same diagnostics print again, unchanged.
 *
 * This never touches the data path — call sites just swap console.log for
 * debugLog around lines that fire once per tick/candle/message.
 */
const isDebugEnabled = (): boolean => (process.env.LOG_LEVEL || "info").toLowerCase() === "debug";

export const debugLog = (...args: unknown[]): void => {
  if (isDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
};

export { isDebugEnabled };
