import axios from "axios";
import AdmZip from "adm-zip";
import { readLive } from "./redisWriteBuffer";

// BROKER_MASTER_SOURCE_AUDIT.md: the previous plain-.txt URL is a stale, apparently abandoned
// mirror (Last-Modified was ~9 months old, content stopped updating in 2023). Zebu's actively
// refreshed instrument master — confirmed via HTTP headers (same-day Last-Modified) and via the
// OpenAlgo broker integration, which uses this exact URL pattern in production — is the .zip
// variant at the same domain. Module 1 is an NFO index-options dashboard, so only the NFO
// segment is downloaded here; nothing about which instruments/symbols exist within NFO is
// hardcoded downstream of this map — this is purely "where do we fetch the NFO master from".
const MASTER_URLS: Record<string, string> = {
  NFO: "https://go.mynt.in/NFO_symbols.txt.zip",
};
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — covers weekly expiry cycles

interface MasterRow {
  exchange: string;
  token: string;
  symbol: string;
  tradingSymbol: string;
  expiry: Date | null;
  strike: number;
  optionType: string;
  instrumentType: string;
}

export interface ActiveInstrumentTokens {
  futToken: string | null;
  ceTokens: string[];
  peTokens: string[];
  fetchedAt: Date;
  nearestOptionExpiry: string | null;
  futExpiry: string | null;
  // False when the strike band above was selected around a stale hardcoded ATM guess
  // (Redis had no live spot/futures price yet at connect time) rather than a real price.
  atmIsReliable: boolean;
}

let cachedTokens: ActiveInstrumentTokens | null = null;
let lastFetchTime = 0;

// Raw NFO rows + nearest option expiry from the last successful refresh, kept around so
// on-demand lookups (exact strike resolution, ATM-band recompute, and every dropdown query
// below) don't need to re-download the instrument master.
let cachedRows: MasterRow[] = [];
let cachedNearestExpiry: Date | null = null;

const MONTH_ABBR_TO_NUM: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

const parseExpiry = (raw: string): Date | null => {
  const s = (raw || "").trim();
  if (!s || s === "0") return null;

  // ISO: 2026-07-31
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00.000Z");

  // DD-Mon-YYYY: 31-Jul-2026 (this is the format the live *_symbols.txt files actually use,
  // e.g. "27-JUL-2023", "31-DEC-2026"). `new Date("2026-DEC-31T...")` is NOT valid ISO 8601
  // (month must be numeric) and silently produces an Invalid Date — whose comparisons like
  // `expiry >= today` are always false, not an exception, so every row with this expiry
  // format was silently treated as "not active" without any error. Map the month name to a
  // zero-padded number so the resulting string is real ISO 8601.
  const dm = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (dm) {
    const monthNum = MONTH_ABBR_TO_NUM[dm[2].toUpperCase()];
    if (monthNum) return new Date(`${dm[3]}-${monthNum}-${dm[1].padStart(2, "0")}T00:00:00.000Z`);
  }

  // DD/MM/YYYY: 31/07/2026
  const ds = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (ds) return new Date(`${ds[3]}-${ds[2]}-${ds[1]}T00:00:00.000Z`);

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

const formatExpiryForSymbol = (expiry: Date): string => {
  // Zebu format: DDMONYY (e.g., 03JUL26)
  const day = String(expiry.getUTCDate()).padStart(2, "0");
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const mon = months[expiry.getUTCMonth()];
  const yr = String(expiry.getUTCFullYear()).slice(-2);
  return `${day}${mon}${yr}`;
};

// NFO's master CSV layout (verified against the live file):
//   Exchange,Token,LotSize,Symbol,TradingSymbol,Expiry,Instrument,OptionType,StrikePrice,TickSize
// Parsing by column NAME off the file's own header row (rather than fixed positions) means
// nothing about the column layout is hardcoded here.
const buildColumnIndex = (headerLine: string, delim: string): Record<string, number> => {
  const cols = headerLine.split(delim).map(c => c.trim());
  const index: Record<string, number> = {};
  cols.forEach((name, i) => { if (name) index[name] = i; });
  return index;
};

const parseMasterLine = (line: string, delim: string, colIndex: Record<string, number>): MasterRow | null => {
  const parts = line.split(delim).map(p => p.trim());
  const get = (name: string): string => {
    const idx = colIndex[name];
    return idx !== undefined ? (parts[idx] ?? "") : "";
  };

  const exchange = get("Exchange");
  const token = get("Token");
  const symbol = get("Symbol");
  const tradingSymbol = get("TradingSymbol");
  if (!exchange || !token || !symbol || !tradingSymbol) return null;

  // BFO's strike column is literally named "Strike", every other segment names it "StrikePrice".
  const strikeStr = get("StrikePrice") || get("Strike");

  return {
    exchange: exchange.toUpperCase(),
    token,
    symbol: symbol.toUpperCase(),
    tradingSymbol,
    expiry: parseExpiry(get("Expiry")),
    strike: parseFloat(strikeStr || "0") || 0,
    optionType: get("OptionType").toUpperCase().trim(),
    instrumentType: get("Instrument").toUpperCase().trim(),
  };
};

/** Downloads and parses one exchange's instrument master. Never throws — a single
 *  exchange's master being unreachable/malformed shouldn't take down the others;
 *  it just contributes zero rows and is logged. */
const downloadAndParseMaster = async (exchangeCode: string, url: string): Promise<MasterRow[]> => {
  try {
    const resp = await axios.get<ArrayBuffer>(url, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      responseType: "arraybuffer",
    });
    const zipBuffer = Buffer.from(resp.data);

    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    const entry = entries.find(e => e.entryName.toLowerCase().endsWith(".txt")) ?? entries[0];
    if (!entry) {
      console.error(`[InstrumentTokens] ${exchangeCode}: downloaded zip has no entries — skipping.`);
      return [];
    }
    const fileText = zip.readAsText(entry);
    const lines = fileText.split("\n").filter(l => l.trim().length > 0);
    if (lines.length === 0) return [];

    const headerLine = lines[0];
    const delim = headerLine.includes(",") ? "," : "|";
    const colIndex = buildColumnIndex(headerLine, delim);

    const rows: MasterRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const row = parseMasterLine(lines[i], delim, colIndex);
      if (row) rows.push(row);
    }

    console.log(
      `[InstrumentTokens] ${exchangeCode}: downloaded ${lines.length} lines, parsed ${rows.length} rows ` +
      `(zipBytes=${zipBuffer.length}, entry="${entry.entryName}").`
    );
    return rows;
  } catch (err: any) {
    console.error(`[InstrumentTokens] ${exchangeCode}: download/parse failed —`, err?.message || err);
    return [];
  }
};

const findNearestOptionExpiry = (rows: MasterRow[]): Date | null => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const optRows = rows.filter(r => r.symbol === "NIFTY" && r.instrumentType === "OPTIDX" && r.expiry && r.expiry >= today);
  if (optRows.length === 0) return null;
  const nearestExpiryMs = Math.min(...optRows.map(r => r.expiry!.getTime()));
  const nearestExpiry = new Date(nearestExpiryMs);
  nearestExpiry.setUTCHours(0, 0, 0, 0);
  return nearestExpiry;
};

/**
 * Selects CE/PE tokens for the given expiry within `strikeRadius` of `atmStrike`.
 * Shared by the startup token build (buildActiveTokens) and the on-demand ATM-band
 * recompute (recomputeOptionBandFromLivePrice) so both use identical selection logic.
 *
 * NIFTY-specific by design — this powers the live spot/futures/option WEBSOCKET
 * SUBSCRIPTION band, not the discovery dropdowns below, and is out of scope for the
 * multi-exchange dropdown refactor (subscriptions must not change).
 */
const selectOptionTokens = (
  rows: MasterRow[],
  nearestExpiry: Date,
  atmStrike: number,
  strikeRadius: number
): { ceTokens: string[]; peTokens: string[]; expiryStr: string } => {
  const atmRounded = Math.round(atmStrike / 50) * 50;
  const expiryStr = formatExpiryForSymbol(nearestExpiry);

  const strikeRows = rows.filter(r => {
    if (r.symbol !== "NIFTY" || r.instrumentType !== "OPTIDX" || !r.expiry) return false;
    const d = new Date(r.expiry);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime() === nearestExpiry.getTime() && Math.abs(r.strike - atmRounded) <= strikeRadius;
  });

  const ceTokens = strikeRows
    .filter(r => r.optionType === "CE")
    .sort((a, b) => a.strike - b.strike)
    .map(r => `${r.exchange}|${r.token}:NIFTY${expiryStr}C${r.strike}`);

  const peTokens = strikeRows
    .filter(r => r.optionType === "PE")
    .sort((a, b) => a.strike - b.strike)
    .map(r => `${r.exchange}|${r.token}:NIFTY${expiryStr}P${r.strike}`);

  return { ceTokens, peTokens, expiryStr };
};

/** NIFTY-specific live-subscription token build — unchanged by the multi-exchange
 *  discovery refactor; still filters `rows` down to NIFTY FUTIDX/OPTIDX itself,
 *  so broadening what's in `rows` doesn't change its output. */
const buildActiveTokens = (rows: MasterRow[], atmStrike: number, atmIsReliable: boolean): ActiveInstrumentTokens => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Nearest NIFTY futures contract with expiry >= today
  const futRows = rows
    .filter(r => r.symbol === "NIFTY" && r.instrumentType === "FUTIDX" && r.expiry && r.expiry >= today)
    .sort((a, b) => a.expiry!.getTime() - b.expiry!.getTime());

  let futToken: string | null = null;
  let futExpiry: string | null = null;
  if (futRows.length > 0) {
    const fut = futRows[0];
    futToken = `${fut.exchange}|${fut.token}:NIFTY-FUT`;
    futExpiry = fut.expiry!.toISOString().slice(0, 10);
    console.log(`[InstrumentTokens] Active futures: ${fut.tradingSymbol} expiry=${futExpiry} → ${futToken}`);
  } else {
    console.warn("[InstrumentTokens] No active NIFTY futures found in NFO symbols.");
  }

  const nearestExpiry = findNearestOptionExpiry(rows);
  if (!nearestExpiry) {
    console.warn("[InstrumentTokens] No active NIFTY option contracts found.");
    return { futToken, ceTokens: [], peTokens: [], fetchedAt: new Date(), nearestOptionExpiry: null, futExpiry, atmIsReliable };
  }
  cachedNearestExpiry = nearestExpiry;
  const nearestOptionExpiry = nearestExpiry.toISOString().slice(0, 10);
  console.log(`[InstrumentTokens] Nearest option expiry: ${nearestOptionExpiry}`);

  const strikeRadius = atmIsReliable ? 1000 : 5000;
  const { ceTokens, peTokens } = selectOptionTokens(rows, nearestExpiry, atmStrike, strikeRadius);

  console.log(`[InstrumentTokens] ATM=${Math.round(atmStrike / 50) * 50} (reliable=${atmIsReliable}, radius=${strikeRadius}): ${ceTokens.length} CE + ${peTokens.length} PE tokens selected.`);

  return { futToken, ceTokens, peTokens, fetchedAt: new Date(), nearestOptionExpiry, futExpiry, atmIsReliable };
};

/**
 * Downloads the NFO instrument master (see MASTER_URLS), caches it, and refreshes
 * the NIFTY live-subscription token list from it.
 * Uses cached tokens if still valid (< CACHE_TTL_MS) unless `force: true` is passed.
 */
export const refreshInstrumentTokens = async (options?: { force?: boolean }): Promise<ActiveInstrumentTokens | null> => {
  const force = options?.force ?? false;
  if (!force && cachedTokens && cachedRows.length > 0 && Date.now() - lastFetchTime < CACHE_TTL_MS) {
    console.log(`[MODULE1][RECONNECT] Reusing cached instrument tokens (age: ${Math.round((Date.now() - lastFetchTime) / 1000)}s, rows: ${cachedRows.length}).`);
    return cachedTokens;
  }

  try {
    console.log(`[InstrumentTokens] Downloading NFO instrument master (force=${force}) ...`);
    const perExchangeRows = await Promise.all(
      Object.entries(MASTER_URLS).map(([code, url]) => downloadAndParseMaster(code, url))
    );
    const rows = perExchangeRows.flat();

    if (rows.length === 0) {
      if (cachedTokens) {
        console.warn("[InstrumentTokens] Download failed or empty — falling back to previously cached tokens.");
        return cachedTokens;
      }
      console.warn("[InstrumentTokens] No rows parsed from the NFO master — cannot proceed.");
      return null;
    }

    // Cache raw rows for on-demand lookups — dropdown discovery
    // (getAvailableExchanges/Instruments/Symbols/Expiries/Strikes below) and the
    // on-demand option resolve (resolveOptionInstrument) — so those don't need to re-download.
    cachedRows = rows;

    // Diagnostics: total row count plus the NIFTY-specific active-contract counts
    // (the live-subscription band this feeds).
    {
      console.log(`[InstrumentTokens] Total NFO rows cached: ${rows.length}.`);

      const todayForDiag = new Date();
      todayForDiag.setUTCHours(0, 0, 0, 0);
      const activeFutRows = rows.filter(r => r.symbol === "NIFTY" && r.instrumentType === "FUTIDX" && r.expiry && r.expiry >= todayForDiag);
      const activeOptRows = rows.filter(r => r.symbol === "NIFTY" && r.instrumentType === "OPTIDX" && r.expiry && r.expiry >= todayForDiag);
      const uniqueExpiries = [...new Set(activeOptRows.filter(r => r.expiry).map(r => r.expiry!.toISOString().slice(0, 10)))].sort();
      console.log(`[InstrumentTokens] Active NIFTY FUTIDX rows (expiry >= today): ${activeFutRows.length}`);
      console.log(`[InstrumentTokens] Active NIFTY OPTIDX rows (expiry >= today): ${activeOptRows.length}`);
      console.log(`[InstrumentTokens] Unique NIFTY expiries loaded (${uniqueExpiries.length}): ${uniqueExpiries.join(", ")}`);
    }

    // Get current spot price to calculate ATM strike.
    // Priority: ltp:NIFTY-SPOT (live cash index) → ltp:NIFTY-FUT (close proxy, persists from
    // last session even after contract expiry) → hardcoded fallback.
    // The futures price diverges from spot by at most a few points intraday, making it a
    // reliable ATM seed when the spot tick hasn't arrived yet on cold-start.
    let atmStrike = 25500; // Fallback updated to reflect realistic NIFTY range; overridden below
    let atmSource = "fallback-default";
    try {
      const spotStr = await readLive("ltp:NIFTY-SPOT");
      const futStr  = await readLive("ltp:NIFTY-FUT");
      const spot = spotStr ? parseFloat(spotStr) : 0;
      const fut  = futStr  ? parseFloat(futStr)  : 0;
      if (spot > 0) {
        atmStrike = spot;
        atmSource = "redis-spot";
      } else if (fut > 0) {
        // Futures price lags spot by at most the fair-value basis (typically <50 pts).
        // Accurate enough for strike selection at ±1000 radius.
        atmStrike = fut;
        atmSource = "redis-futures";
      }
    } catch { /* Redis offline — use default */ }
    const atmIsReliable = atmSource !== "fallback-default";
    const atmWarning = atmIsReliable
      ? ""
      : ` (WARNING: Redis empty — using default ATM ${atmStrike}; widening strike radius to compensate for a possibly stale seed)`;
    console.log(`[InstrumentTokens] ATM source: ${atmSource} → ${atmStrike}${atmWarning}`);

    const tokens = buildActiveTokens(rows, atmStrike, atmIsReliable);
    cachedTokens = tokens;
    lastFetchTime = Date.now();
    return tokens;
  } catch (err: any) {
    console.error("[InstrumentTokens] Refresh failed:", err?.message || err);
    if (cachedTokens) {
      console.warn("[InstrumentTokens] Using stale cached tokens due to refresh error.");
      return cachedTokens;
    }
    return null;
  }
};

/**
 * Returns cached tokens if fresh, otherwise triggers a refresh.
 */
export const getActiveInstrumentTokens = async (options?: { force?: boolean }): Promise<ActiveInstrumentTokens | null> => {
  const force = options?.force ?? false;
  if (!force && cachedTokens && cachedRows.length > 0 && Date.now() - lastFetchTime < CACHE_TTL_MS) return cachedTokens;
  return refreshInstrumentTokens(options);
};

export const getCachedInstrumentTokens = (): ActiveInstrumentTokens | null => cachedTokens;

// ── Dropdown discovery (Exchange → Instrument → Symbol → Expiry → Strike) ──────────────────────
// Every function below is a straight pass-through filter over `cachedRows` — the broker's own
// Exchange/Instrument/Symbol/Expiry/Strike fields, nothing inferred, curated, or hardcoded. Each
// level takes the levels above it as a filter, so the dropdowns are naturally dependent: asking
// for Instruments under an Exchange that has none returns [], asking for Symbols under an
// Instrument that doesn't exist under that Exchange returns [], etc.

/** Every distinct exchange present in the currently-loaded instrument master, sorted.
 *  Only NFO is downloaded (see MASTER_URLS), so this naturally returns ["NFO"] — nothing
 *  hardcoded, it's just the only exchange with rows in cachedRows. */
export const getAvailableExchanges = async (): Promise<string[]> => {
  if (!cachedRows.length) await getActiveInstrumentTokens();

  const exchanges = cachedRows.map(r => r.exchange).filter(Boolean);
  return Array.from(new Set(exchanges)).sort();
};

/** Every distinct instrumentType (e.g. OPTIDX, FUTCOM, EQ, INDEX, ...) the broker has under
 *  the given exchange, sorted. Empty if the exchange has no rows loaded. */
export const getAvailableInstrumentTypes = async (exchange: string): Promise<string[]> => {
  if (!cachedRows.length) await getActiveInstrumentTokens();

  const ex = exchange.toUpperCase();
  const types = cachedRows.filter(r => r.exchange === ex).map(r => r.instrumentType).filter(Boolean);
  return Array.from(new Set(types)).sort();
};

/** Every distinct symbol the broker has under the given exchange + instrumentType, sorted. */
export const getAvailableSymbols = async (exchange: string, instrumentType: string): Promise<string[]> => {
  if (!cachedRows.length) await getActiveInstrumentTokens();

  const ex = exchange.toUpperCase();
  const it = instrumentType.toUpperCase();
  const symbols = cachedRows
    .filter(r => r.exchange === ex && r.instrumentType === it)
    .map(r => r.symbol)
    .filter(Boolean);
  return Array.from(new Set(symbols)).sort();
};

/** All real, currently-active expiry dates for one exchange + instrumentType + symbol, ISO
 *  `YYYY-MM-DD`, ascending. Naturally empty for cash instruments (EQ/INDEX/...) since those
 *  rows carry no Expiry value — no separate "does this need an expiry" flag required. */
export const getAvailableExpiries = async (exchange: string, instrumentType: string, symbol: string): Promise<string[]> => {
  if (!cachedRows.length) await getActiveInstrumentTokens();

  const ex = exchange.toUpperCase();
  const it = instrumentType.toUpperCase();
  const sym = symbol.toUpperCase();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const isoDates = cachedRows
    .filter(r => r.exchange === ex && r.instrumentType === it && r.symbol === sym && r.expiry && r.expiry >= today)
    .map(r => r.expiry!.toISOString().slice(0, 10));

  return Array.from(new Set(isoDates)).sort();
};

/** All real strike prices for one exchange + instrumentType + symbol + expiry. CE and PE rows
 *  share the same strike set, so this dedupes across both. Ascending. */
export const getAvailableStrikes = async (
  exchange: string, instrumentType: string, symbol: string, expiryIso: string
): Promise<number[]> => {
  if (!cachedRows.length) await getActiveInstrumentTokens();

  const ex = exchange.toUpperCase();
  const it = instrumentType.toUpperCase();
  const sym = symbol.toUpperCase();

  const strikes = cachedRows
    .filter(r =>
      r.exchange === ex &&
      r.instrumentType === it &&
      r.symbol === sym &&
      r.expiry && r.expiry.toISOString().slice(0, 10) === expiryIso &&
      r.strike > 0
    )
    .map(r => r.strike);

  return Array.from(new Set(strikes)).sort((a, b) => a - b);
};

/**
 * Resolves the exact token for one OPTIDX option contract by instrument + expiry + strike +
 * type, independent of the ATM band selected at connect time. Used by the on-demand
 * `subscribe:options` socket handler so the user's chosen strike is always resolvable even
 * if it fell outside the ATM band picked at startup. Unchanged by the multi-exchange discovery
 * refactor — this is live-subscription resolution, not a dropdown query.
 * Returns null if the instrument master hasn't been loaded yet or the contract isn't found
 * (wrong strike/expiry, or expired).
 */
export const resolveOptionInstrument = async (
  instrument: string,
  expiryFmt: string,
  strike: number,
  optionType: "CE" | "PE"
): Promise<{ exchange: string; token: string; symbol: string } | null> => {
  if (!cachedRows.length) await getActiveInstrumentTokens();
  const inst = instrument.toUpperCase();

  const row = cachedRows.find(r =>
    r.symbol === inst &&
    r.instrumentType === "OPTIDX" &&
    r.optionType === optionType &&
    r.strike === strike &&
    r.expiry && formatExpiryForSymbol(r.expiry) === expiryFmt
  );
  if (!row) return null;

  const letter = optionType === "CE" ? "C" : "P";
  return { exchange: row.exchange, token: row.token, symbol: `${inst}${expiryFmt}${letter}${strike}` };
};

/**
 * Recomputes the ±1000 ATM strike band from a real spot/futures price (called once, when
 * the first genuine tick arrives after a cold start where the initial band was built off
 * the unreliable hardcoded fallback). Returns the CE/PE token strings to runtime-subscribe.
 * Unchanged by the multi-exchange discovery refactor.
 */
export const recomputeOptionBandFromLivePrice = (
  livePrice: number
): { ceTokens: string[]; peTokens: string[] } | null => {
  if (!cachedRows.length || !cachedNearestExpiry) return null;
  const { ceTokens, peTokens } = selectOptionTokens(cachedRows, cachedNearestExpiry, livePrice, 1000);
  console.log(`[InstrumentTokens] Recomputed ATM band from live price ${livePrice} → ${ceTokens.length} CE + ${peTokens.length} PE tokens (±1000, expiry=${cachedNearestExpiry.toISOString().slice(0, 10)}).`);
  return { ceTokens, peTokens };
};
