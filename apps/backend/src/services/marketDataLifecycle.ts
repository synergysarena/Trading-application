/**
 * Centralized market-data processing lifecycle manager.
 * Controls whether live background calculations, OHLC boundary checks,
 * candle aggregations, and pivot recalculations are allowed to execute.
 */

export type MarketDataLifecycleState = "RUNNING" | "SHUTTING_DOWN" | "STOPPED";

let _marketDataProcessingEnabled = true;
let _marketDataGeneration = 1;
let _marketDataState: MarketDataLifecycleState = "RUNNING";

export const isMarketDataProcessingEnabled = (): boolean => _marketDataProcessingEnabled;

export const getMarketDataGeneration = (): number => _marketDataGeneration;

export const getMarketDataLifecycleState = (): MarketDataLifecycleState => _marketDataState;

export const setMarketDataLifecycleState = (state: MarketDataLifecycleState): void => {
  _marketDataState = state;
};

export const enableMarketDataProcessing = (): void => {
  _marketDataProcessingEnabled = true;
  _marketDataState = "RUNNING";
};

export const disableMarketDataProcessing = (): void => {
  _marketDataProcessingEnabled = false;
  _marketDataGeneration++;
  _marketDataState = "STOPPED";
};
