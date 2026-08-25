export type Module2DataSource = "LIVE_MARKET_DATA_API" | "UNAVAILABLE";

const isPlaceholder = (value?: string) =>
  !value || value.includes("your-") || value.includes("placeholder");

export const getModule2MissingMarketDataConfig = () => {
  const missing: string[] = [];

  const key = process.env.AETRAM_APP_KEY || process.env.MOD2_API_KEY;
  const secret = process.env.AETRAM_SECRET_KEY || process.env.MOD2_API_SECRET;

  if (isPlaceholder(key)) missing.push("AETRAM_APP_KEY");
  if (isPlaceholder(secret)) missing.push("AETRAM_SECRET_KEY");
  if (isPlaceholder(process.env.AETRAM_MARKETDATA_API_BASE_URL)) missing.push("AETRAM_MARKETDATA_API_BASE_URL");
  if (isPlaceholder(process.env.AETRAM_MARKETDATA_AUTH_URL)) missing.push("AETRAM_MARKETDATA_AUTH_URL");

  return missing;
};

export const getModule2MissingInteractiveConfig = getModule2MissingMarketDataConfig;

export const getModule2DataSource = (): Module2DataSource =>
  getModule2MissingMarketDataConfig().length === 0 ? "LIVE_MARKET_DATA_API" : "UNAVAILABLE";

export const logModule2InteractiveStatus = () => {
  const missing = getModule2MissingMarketDataConfig();
  if (missing.length === 0) {
    console.log("[Module2] Market Data API configured (Pure Live Display System).");
    return;
  }
  console.log(`[Module2] Market Data API not fully configured — missing: ${missing.join(", ")}`);
};

