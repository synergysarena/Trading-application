import { Tick } from "@stock/shared";
import { readLive } from "./redisWriteBuffer";

type OiSignal = "STRONG_BULL" | "MILD_BULL" | "NEUTRAL" | "MILD_BEAR" | "STRONG_BEAR" | "DIVERGENCE";

export interface Module1OiMetrics {
  timestamp: string;
  dataSource: "LIVE_MARKET_API" | "SIMULATOR";
  tin: number;
  c_tl: number;
  c_mn: number;
  c_hig: number;
  c_low: number;
  c_buy: number;
  c_sell: number;
  f_buy: number;
  f_sell: number;
  p_tl: number;
  p_mn: number;
  p_hig: number;
  p_low: number;
  p_buy: number;
  p_sell: number;
  callSignal: OiSignal;
  putSignal: OiSignal;
}

const PUT_INVERSE: Record<OiSignal, OiSignal> = {
  STRONG_BULL: "STRONG_BEAR",
  MILD_BULL: "MILD_BEAR",
  NEUTRAL: "NEUTRAL",
  MILD_BEAR: "MILD_BULL",
  STRONG_BEAR: "STRONG_BULL",
  DIVERGENCE: "DIVERGENCE",
};

const ceOiBySymbol = new Map<string, number>();
const peOiBySymbol = new Map<string, number>();
const rows: Module1OiMetrics[] = [];
const futuresOiRows: number[] = [];

let latestFuturesOi = 0;
let latestSecondBucket = "";
let latestRow: Module1OiMetrics | null = null;
let activeDataSource: Module1OiMetrics["dataSource"] = "SIMULATOR";

export const setModule1OiDataSource = (dataSource: Module1OiMetrics["dataSource"]) => {
  activeDataSource = dataSource;
  if (latestRow) latestRow.dataSource = dataSource;
};

const toIstTimestamp = (date: Date): string => {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.toISOString().slice(0, 19)}+05:30`;
};

const sumValues = (map: Map<string, number>) =>
  Array.from(map.values()).reduce((sum, value) => sum + value, 0);

const avg = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const getCallSignal = (row: Pick<Module1OiMetrics, "c_buy" | "c_sell" | "p_buy" | "p_sell" | "f_buy" | "f_sell">): OiSignal => {
  const threshold = 500;

  if (row.c_buy > threshold && row.f_buy > 0 && row.p_sell < 0) return "STRONG_BULL";
  if (row.c_buy > 0 && row.p_sell < 0) return "MILD_BULL";
  if (row.c_sell < -threshold && row.f_sell < 0 && row.p_buy > 0) return "STRONG_BEAR";
  if (row.c_sell < 0 && row.p_buy > 0) return "MILD_BEAR";
  if ((row.c_buy > 0 && row.f_sell < 0) || (row.c_sell < 0 && row.f_buy > 0)) return "DIVERGENCE";
  return "NEUTRAL";
};

const createOrUpdateLatestRow = (timestamp: Date) => {
  const secondBucket = timestamp.toISOString().slice(0, 19);
  const isNewRow = latestSecondBucket !== secondBucket;
  const previous = isNewRow ? rows[rows.length - 1] || null : rows[rows.length - 2] || null;
  const previousFuturesOi = isNewRow
    ? futuresOiRows[futuresOiRows.length - 1] || 0
    : futuresOiRows[futuresOiRows.length - 2] || 0;

  if (isNewRow) {
    latestSecondBucket = secondBucket;
    latestRow = null;
  }

  const cTl = Math.round(sumValues(ceOiBySymbol));
  const pTl = Math.round(sumValues(peOiBySymbol));
  const fOi = Math.round(latestFuturesOi);

  const cDelta = previous ? cTl - previous.c_tl : cTl;
  const pDelta = previous ? pTl - previous.p_tl : pTl;
  const fDelta = previousFuturesOi ? fOi - previousFuturesOi : fOi;

  const rowsForSeries = isNewRow ? rows : rows.slice(0, -1);
  const cSeries = [...rowsForSeries.map((row) => row.c_tl), cTl];
  const pSeries = [...rowsForSeries.map((row) => row.p_tl), pTl];

  const baseRow: Module1OiMetrics = {
    timestamp: toIstTimestamp(timestamp),
    dataSource: activeDataSource,
    tin: latestRow?.tin ?? (previous ? previous.tin + 1 : 18),
    c_tl: cTl,
    c_mn: Math.round(avg(cSeries)),
    c_hig: Math.max(...cSeries),
    c_low: Math.min(...cSeries),
    c_buy: Math.max(cDelta, 0),
    c_sell: Math.min(cDelta, 0),
    f_buy: Math.max(fDelta, 0),
    f_sell: Math.min(fDelta, 0),
    p_tl: pTl,
    p_mn: Math.round(avg(pSeries)),
    p_hig: Math.max(...pSeries),
    p_low: Math.min(...pSeries),
    p_buy: Math.max(pDelta, 0),
    p_sell: Math.min(pDelta, 0),
    callSignal: "NEUTRAL",
    putSignal: "NEUTRAL",
  };

  baseRow.callSignal = getCallSignal(baseRow);
  baseRow.putSignal = PUT_INVERSE[baseRow.callSignal];

  if (isNewRow || rows.length === 0) {
    rows.push(baseRow);
    futuresOiRows.push(fOi);
    if (rows.length > 240) {
      rows.shift();
      futuresOiRows.shift();
    }
  } else {
    rows[rows.length - 1] = baseRow;
    futuresOiRows[futuresOiRows.length - 1] = fOi;
  }

  latestRow = baseRow;
};

let _diagTickCount = 0;
let _diagLastLogTime = 0;
let _diagFirstTickLogged = false;

// MARKET DATA API is the intended real source for option-chain OI and futures OI.
// For now this consumes existing backend live/simulator ticks only; no Interactive Data API,
// frontend secrets, order placement, order modification, or cancellation is involved.
export const ingestModule1OiTick = (tick: Tick) => {
  if (tick.oi === undefined || Number.isNaN(tick.oi)) return;

  let bucket: "CE" | "PE" | "FUT" | "SKIP" = "SKIP";

  if (tick.symbol.endsWith("CE") || /C\d+$/.test(tick.symbol)) {
    ceOiBySymbol.set(tick.symbol, tick.oi);
    bucket = "CE";
  } else if (tick.symbol.endsWith("PE") || /P\d+$/.test(tick.symbol)) {
    peOiBySymbol.set(tick.symbol, tick.oi);
    bucket = "PE";
  } else if (tick.symbol.endsWith("-FUT") || tick.symbol.includes("FUT")) {
    latestFuturesOi = tick.oi;
    bucket = "FUT";
  } else {
    return;
  }

  if (!_diagFirstTickLogged) {
    _diagFirstTickLogged = true;
    console.log(`[OI] First classified tick — symbol: ${tick.symbol} | bucket: ${bucket} | oi: ${tick.oi} | ltp: ${tick.ltp}`);
  }

  _diagTickCount++;
  createOrUpdateLatestRow(tick.timestamp || new Date());

  // Log calculation result every 60 ticks
  const now = Date.now();
  if (_diagTickCount % 60 === 0 || now - _diagLastLogTime > 60000) {
    _diagLastLogTime = now;
    const c_tl = Math.round(sumValues(ceOiBySymbol));
    const p_tl = Math.round(sumValues(peOiBySymbol));
    console.log(
      `[Calc] OI Tick #${_diagTickCount} | CE symbols: ${ceOiBySymbol.size} | PE symbols: ${peOiBySymbol.size}` +
      ` | C_TL: ${c_tl} | P_TL: ${p_tl} | FUT OI: ${latestFuturesOi} | Rows: ${rows.length}`
    );
    // Log individual symbol OI to identify token classification issues
    if (ceOiBySymbol.size > 0) {
      const ceEntries = Array.from(ceOiBySymbol.entries()).map(([s, v]) => `${s}=${v}`).join(", ");
      console.log(`[Calc] CE bucket: ${ceEntries}`);
    } else {
      console.warn("[Calc] WARNING: No CE OI data. Option tokens may be expired or not yet received.");
    }
    if (peOiBySymbol.size > 0) {
      const peEntries = Array.from(peOiBySymbol.entries()).map(([s, v]) => `${s}=${v}`).join(", ");
      console.log(`[Calc] PE bucket: ${peEntries}`);
    } else {
      console.warn("[Calc] WARNING: No PE OI data. Option tokens may be expired or not yet received.");
    }
    if (latestRow) {
      console.log(`[Calc] Latest Row: time=${latestRow.timestamp} c_tl=${latestRow.c_tl} c_buy=${latestRow.c_buy} c_sell=${latestRow.c_sell} p_tl=${latestRow.p_tl} signal=${latestRow.callSignal}`);
    }
  }
};

export const getLatestModule1OiMetrics = (): Module1OiMetrics => {
  if (latestRow) return latestRow;

  createOrUpdateLatestRow(new Date());
  return latestRow!;
};

/**
 * Warm up the futures OI from Redis on server start.
 *
 * Option OI is intentionally NOT loaded here. Each option's OI is bound to a specific
 * weekly contract (e.g., NIFTY03JUL26C26200). Loading option OI from Redis risks
 * populating ceOiBySymbol/peOiBySymbol with values from expired contracts — keys written
 * before the TTL fix (setex) have no expiry and persist indefinitely. Expired option OI
 * would freeze c_tl at a stale value (the root cause of OHLC = 26195/26195/26195/26195).
 * Option OI will populate from live ticks within seconds of broker connection.
 */
export const initModule1OiService = async () => {
  try {
    const futOiStr = await readLive("oi:NIFTY-FUT");
    if (futOiStr) {
      const futOi = parseInt(futOiStr);
      if (!isNaN(futOi) && futOi > 0) {
        latestFuturesOi = futOi;
        console.log(`[Module1OiService] Warmed up futures OI from Redis: ${futOi}`);
      }
    }
    createOrUpdateLatestRow(new Date());
    console.log("[Module1OiService] Initialized — option OI will populate from live ticks after broker connection.");
  } catch (err) {
    console.warn("[Module1OiService] Redis warmup warning:", err);
  }
};

/**
 * Clear all in-memory OI maps and reset the latest row.
 * Called by dataFeed whenever fresh instrument tokens are applied so that any stale
 * in-memory OI values (e.g., loaded from Redis warmup for now-expired contracts)
 * are removed before the new option subscriptions begin streaming.
 */
export const resetModule1OiMaps = () => {
  ceOiBySymbol.clear();
  peOiBySymbol.clear();
  latestFuturesOi = 0;
  latestRow = null;
  console.log("[Module1OiService] In-memory OI maps reset — stale values cleared, awaiting live ticks.");
  createOrUpdateLatestRow(new Date());
};
