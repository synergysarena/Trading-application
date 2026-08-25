import { searchInstruments as searchAetramInstruments, getAetramExpiryDates, resolveOptionStrikeToken } from "./aetramMarketDataService";
import {
  SUPPORTED_INDICES,
  SupportedIndex,
  INDEX_EXCHANGE_MAP,
  normalizeIndexSymbol,
  isSupportedIndex,
  validateInstrumentSelection,
  InstrumentSelection,
} from "./instrumentValidation";

/**
 * Module 2 Instrument Discovery layer — single source of truth for instrument
 * search, expiry retrieval, and strike-token resolution. Sits on top of the
 * existing Aetram helpers (searchInstruments, getAetramExpiryDates,
 * resolveOptionStrikeToken) rather than duplicating their HTTP calls.
 */

export interface InstrumentSearchResult {
  exchange: string;
  instrumentName: string;
  tradingSymbol: string;
  exchangeInstrumentID: string;
  series: string;
  instrumentType: string;
}

export interface ExpiryResult {
  symbol: string;
  expiries: string[];
}

export interface ResolveTokenParams {
  exchange: string;
  instrument: string;
  expiry: string;
  strike: number;
  optionType: string;
}

export interface ResolveTokenResult {
  valid: boolean;
  reason?: string;
  exchangeInstrumentID?: string;
  tradingSymbol?: string;
  exchangeSegment?: number;
}

/**
 * GET /module2/instruments/search
 * Searches for an instrument by index name. Only NIFTY, BANKNIFTY, FINNIFTY,
 * MIDCPNIFTY, and SENSEX are supported — anything else is rejected before any
 * network call is made.
 */
export const searchInstrument = async (rawSymbol: string): Promise<InstrumentSearchResult[]> => {
  const symbol = normalizeIndexSymbol(rawSymbol);
  console.log(`[InstrumentService] Search request: symbol="${rawSymbol}" normalized="${symbol}"`);

  if (!isSupportedIndex(rawSymbol)) {
    console.warn(`[InstrumentService] Search rejected — unsupported instrument "${rawSymbol}".`);
    return [];
  }

  const results = await searchAetramInstruments(symbol);
  const exchange = INDEX_EXCHANGE_MAP[symbol as SupportedIndex].exchange;

  return results
    .filter((r) => normalizeIndexSymbol(r.name) === symbol)
    .map((r) => ({
      exchange,
      instrumentName: r.name,
      tradingSymbol: r.tradingSymbol,
      exchangeInstrumentID: r.exchangeInstrumentID,
      series: r.series,
      instrumentType: r.instrumentType,
    }));
};

/**
 * GET /module2/instruments/expiry
 * Retrieves and validates all available (weekly + monthly) expiry dates for
 * an index, deduplicated and sorted ascending.
 */
export const getExpiryDates = async (rawSymbol: string): Promise<ExpiryResult> => {
  const symbol = normalizeIndexSymbol(rawSymbol);
  console.log(`[InstrumentService] Expiry request: symbol="${rawSymbol}" normalized="${symbol}"`);

  if (!isSupportedIndex(rawSymbol)) {
    console.warn(`[InstrumentService] Expiry rejected — unsupported instrument "${rawSymbol}".`);
    return { symbol, expiries: [] };
  }

  const segment = INDEX_EXCHANGE_MAP[symbol as SupportedIndex].expirySegment;
  const rawExpiries = await getAetramExpiryDates(symbol, segment);

  const expiries = Array.from(new Set(rawExpiries.filter(Boolean))).sort();
  return { symbol, expiries };
};

/**
 * POST /module2/instruments/resolve
 * Resolves Exchange + Instrument + Expiry + Strike + Option Type to a
 * concrete ExchangeInstrumentID / trading symbol, or a validation failure
 * reason (invalid strike, invalid expiry, invalid symbol, or no match found).
 */
export const resolveStrikeToken = async (params: ResolveTokenParams): Promise<ResolveTokenResult> => {
  console.log(
    `[InstrumentService] Resolve request: exchange=${params.exchange} instrument=${params.instrument} ` +
    `expiry=${params.expiry} strike=${params.strike} optionType=${params.optionType}`
  );

  const validation = validateInstrumentSelection(params as InstrumentSelection);
  if (!validation.valid) {
    console.warn(`[InstrumentService] Resolve validation failed: ${validation.errors.join("; ")}`);
    return { valid: false, reason: validation.errors.join("; ") };
  }

  const symbol = normalizeIndexSymbol(params.instrument);
  const optionType = params.optionType.trim().toUpperCase();
  const strikeSymbol = `${symbol}${params.strike}${optionType}`;

  const resolved = await resolveOptionStrikeToken(symbol, params.expiry, strikeSymbol);
  if (!resolved) {
    console.warn(`[InstrumentService] Resolve failed — no match for ${strikeSymbol} @ ${params.expiry}.`);
    return { valid: false, reason: "No matching instrument found for the given expiry/strike/option type." };
  }

  return {
    valid: true,
    exchangeInstrumentID: resolved.token,
    tradingSymbol: strikeSymbol,
    exchangeSegment: resolved.segment,
  };
};

export const SUPPORTED_INSTRUMENTS = SUPPORTED_INDICES;
