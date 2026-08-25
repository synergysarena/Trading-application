import { api } from "../utils/api";
import type { Expiry, Strike } from "./models";

// ── Live selection data (Exchange → Instrument → Symbol → Expiry → Strike) ───
//
// Every level is backed by the real broker instrument master(s) Zebu downloads
// (instrumentTokenService.ts on the backend) — nothing here is a static/hardcoded
// catalog. Each fetch is filtered by the levels selected above it.

/** Every exchange the broker's live instrument masters actually have data for,
 *  sorted — a pass-through of the broker's own Exchange field, never a
 *  hardcoded/inferred list. First selector in the chain. */
export const fetchExchanges = async (): Promise<string[]> => {
  const data = await api.get(`/api/module1/exchanges`);
  return Array.isArray(data?.exchanges) ? data.exchanges : [];
};

/** Every instrument type (OPTIDX, FUTCOM, EQ, INDEX, ...) the broker has under
 *  the given exchange. */
export const fetchInstrumentTypes = async (exchange: string): Promise<string[]> => {
  if (!exchange) return [];
  const data = await api.get(`/api/module1/instruments?exchange=${encodeURIComponent(exchange)}`);
  return Array.isArray(data?.instruments) ? data.instruments : [];
};

/** Every symbol the broker has under the given exchange + instrument type. */
export const fetchSymbols = async (exchange: string, instrument: string): Promise<string[]> => {
  if (!exchange || !instrument) return [];
  const params = new URLSearchParams({ exchange, instrument });
  const data = await api.get(`/api/module1/symbols?${params.toString()}`);
  return Array.isArray(data?.symbols) ? data.symbols : [];
};

/** Every real, currently-active expiry for the given exchange + instrument +
 *  symbol, ascending. Empty for cash instruments (e.g. NSE EQ/INDEX) — no
 *  separate "needs expiry" flag required, the data itself answers that. */
export const fetchSymbolExpiries = async (exchange: string, instrument: string, symbol: string): Promise<Expiry[]> => {
  if (!exchange || !instrument || !symbol) return [];
  const params = new URLSearchParams({ exchange, instrument, symbol });
  const data = await api.get(`/api/module1/expiries?${params.toString()}`);
  return Array.isArray(data?.expiries) ? data.expiries : [];
};

/** Every real strike price for the given exchange + instrument + symbol +
 *  expiry, ascending. */
export const fetchStrikes = async (
  exchange: string, instrument: string, symbol: string, expiryId: string,
): Promise<Strike[]> => {
  if (!exchange || !instrument || !symbol || !expiryId) return [];
  const params = new URLSearchParams({ exchange, instrument, symbol, expiryId });
  const data = await api.get(`/api/module1/strikes?${params.toString()}`);
  return Array.isArray(data?.strikes) ? data.strikes : [];
};
