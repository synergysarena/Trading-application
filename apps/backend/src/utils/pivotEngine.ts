import { PivotLevels, CallIndicatorState, PutIndicatorState } from "@stock/shared";

/**
 * Computes Classic Pivot Levels from High, Low, and Close
 */
export const calculateClassicPivot = (H: number, L: number, C: number) => {
  const P = (H + L + C) / 3;
  return {
    P,
    R1: 2 * P - L,
    R2: P + (H - L),
    R3: H + 2 * (P - L),
    S1: 2 * P - H,
    S2: P - (H - L),
    S3: L - 2 * (H - P),
  };
};

/**
 * Computes Camarilla Pivot Levels from High, Low, and Close
 */
export const calculateCamarillaPivot = (H: number, L: number, C: number) => {
  const range = H - L;
  return {
    R4: C + (range * 1.1) / 2,
    R3: C + (range * 1.1) / 4,
    R2: C + (range * 1.1) / 6,
    R1: C + (range * 1.1) / 12,
    S1: C - (range * 1.1) / 12,
    S2: C - (range * 1.1) / 6,
    S3: C - (range * 1.1) / 4,
    S4: C - (range * 1.1) / 2,
  };
};

/**
 * Computes Fibonacci Pivot Levels from High, Low, and Close
 */
export const calculateFibonacciPivot = (H: number, L: number, C: number) => {
  const P = (H + L + C) / 3;
  const range = H - L;
  return {
    P,
    R1: P + 0.382 * range,
    R2: P + 0.618 * range,
    R3: P + 1.000 * range,
    S1: P - 0.382 * range,
    S2: P - 0.618 * range,
    S3: P - 1.000 * range,
  };
};

/**
 * Evaluates Call Action Indicator (7 States)
 */
export const getCallIndicator = (
  ltp: number,
  pivot: { P: number; R1: number; S1: number },
  spotLtp: number
): CallIndicatorState => {
  const div = Math.abs(spotLtp - ltp) / spotLtp * 100;
  if (div > 0.5) return "DIVERGENCE_WARNING";
  if (ltp > pivot.R1) return "CALL_BULLISH";
  if (ltp > pivot.R1 * 0.998) return "CALL_NEAR_RESISTANCE";
  if (ltp > pivot.P) return "CALL_POSITIVE_BIAS";
  if (Math.abs(ltp - pivot.P) / pivot.P < 0.001) return "CALL_NEUTRAL";
  if (ltp > pivot.S1) return "CALL_BEARISH_BIAS";
  return "CALL_BEARISH";
};

/**
 * Evaluates Put Action Indicator (7 States)
 */
export const getPutIndicator = (
  ltp: number,
  pivot: { P: number; R1: number; S1: number },
  spotLtp: number
): PutIndicatorState => {
  const div = Math.abs(spotLtp - ltp) / spotLtp * 100;
  if (div > 0.5) return "SENTIMENT_ALERT";
  if (ltp < pivot.S1) return "PUT_BULLISH";
  if (ltp < pivot.S1 * 1.002) return "PUT_NEAR_SUPPORT";
  if (ltp < pivot.P) return "PUT_POSITIVE_BIAS";
  if (Math.abs(ltp - pivot.P) / pivot.P < 0.001) return "PUT_NEUTRAL";
  if (ltp < pivot.R1) return "PUT_BEARISH_BIAS";
  return "PUT_BEARISH";
};

/**
 * Computes Spot vs Futures Divergence Percentage
 */
export const getDivergence = (spotLtp: number, futuresLtp: number): number => {
  if (spotLtp === 0) return 0;
  return (Math.abs(spotLtp - futuresLtp) / spotLtp) * 100;
};
