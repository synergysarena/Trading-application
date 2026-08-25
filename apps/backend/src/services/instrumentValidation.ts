/**
 * Pure validation/normalization helpers for the Module 2 Instrument Discovery
 * layer. No I/O here — network calls live in aetramMarketDataService /
 * instrumentService so these stay unit-testable in isolation.
 */

export const SUPPORTED_INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"] as const;
export type SupportedIndex = typeof SUPPORTED_INDICES[number];

export const OPTION_TYPES = ["CE", "PE"] as const;
export type OptionType = typeof OPTION_TYPES[number];

export type SupportedExchange = "NSE" | "BSE";

/**
 * Exchange + Aetram exchangeSegment (used by /instruments/expiry) per supported
 * index. SENSEX is the only BSE index Module 2 supports; everything else is NSE.
 * Segment IDs follow the XTS convention: NSEFO=2, BSEFO=12.
 */
export const INDEX_EXCHANGE_MAP: Record<SupportedIndex, { exchange: SupportedExchange; expirySegment: number }> = {
  NIFTY: { exchange: "NSE", expirySegment: 2 },
  BANKNIFTY: { exchange: "NSE", expirySegment: 2 },
  FINNIFTY: { exchange: "NSE", expirySegment: 2 },
  MIDCPNIFTY: { exchange: "NSE", expirySegment: 2 },
  SENSEX: { exchange: "BSE", expirySegment: 12 },
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "NIFTY50" / "NIFTY FIFTY" → "NIFTY"; mirrors getAetramExpiryDates' own normalization. */
export const normalizeIndexSymbol = (raw: string): string =>
  (raw || "").trim().toUpperCase().replace(/50$/i, "").replace(/FIFTY$/i, "");

export const isSupportedIndex = (raw: string): raw is SupportedIndex =>
  (SUPPORTED_INDICES as readonly string[]).includes(normalizeIndexSymbol(raw));

export const isSupportedExchange = (raw: string): raw is SupportedExchange =>
  raw?.trim().toUpperCase() === "NSE" || raw?.trim().toUpperCase() === "BSE";

export const isValidExpiryFormat = (raw: string): boolean => ISO_DATE_RE.test((raw || "").trim());

export const isValidStrike = (strike: number): boolean =>
  Number.isFinite(strike) && strike > 0 && Number.isInteger(strike);

export const isValidOptionType = (raw: string): raw is OptionType =>
  (OPTION_TYPES as readonly string[]).includes((raw || "").trim().toUpperCase());

export interface InstrumentSelection {
  exchange: string;
  instrument: string;
  expiry: string;
  strike: number;
  optionType: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a full token-resolution request: exchange, instrument, expiry,
 * strike, and option type, including cross-checking that the exchange matches
 * the instrument's actual listing venue (e.g. rejects NIFTY quoted on BSE).
 */
export const validateInstrumentSelection = (selection: InstrumentSelection): ValidationResult => {
  const errors: string[] = [];
  const symbol = normalizeIndexSymbol(selection.instrument);

  if (!isSupportedIndex(selection.instrument)) {
    errors.push(`Invalid instrument "${selection.instrument}". Supported: ${SUPPORTED_INDICES.join(", ")}.`);
  }

  if (!isSupportedExchange(selection.exchange)) {
    errors.push(`Invalid exchange "${selection.exchange}". Supported: NSE, BSE.`);
  } else if (isSupportedIndex(selection.instrument)) {
    const expected = INDEX_EXCHANGE_MAP[symbol as SupportedIndex].exchange;
    if (selection.exchange.trim().toUpperCase() !== expected) {
      errors.push(`Instrument "${symbol}" is listed on ${expected}, not "${selection.exchange}".`);
    }
  }

  if (!isValidExpiryFormat(selection.expiry)) {
    errors.push(`Invalid expiry "${selection.expiry}". Expected format YYYY-MM-DD.`);
  }

  if (!isValidStrike(selection.strike)) {
    errors.push(`Invalid strike "${selection.strike}". Must be a positive whole number.`);
  }

  if (!isValidOptionType(selection.optionType)) {
    errors.push(`Invalid option type "${selection.optionType}". Supported: CE, PE.`);
  }

  return { valid: errors.length === 0, errors };
};
