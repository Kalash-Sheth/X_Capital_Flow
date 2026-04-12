// ============================================================
// prediction-engine.ts — Signal persistence & short-term forecasting
// ============================================================

import {
  calcRSI,
  calcMACD,
  calcEMA,
  calcBollingerBands,
  calcATR,
  calcADX,
  OHLCV,
} from './indicators';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForecastResult {
  asset: string;
  direction: 'up' | 'down' | 'sideways';
  confidence: number;      // 0-1
  horizon: string;         // e.g. "5-7 days"
  targetPct: number;       // expected % move
  reasoning: string[];
  signals: SignalSnapshot;
}

export interface SignalSnapshot {
  rsi: number;
  macdHistogram: number;
  trend: 'up' | 'down' | 'sideways';
  bbPosition: 'upper' | 'middle' | 'lower' | 'squeeze';
  adx: number;
  atrPct: number;
  persistenceDays: number;
}

export interface PersistenceResult {
  signal: 'bullish' | 'bearish' | 'neutral';
  days: number;
  strength: number; // 0-1
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function lastValid(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!isNaN(arr[i])) return arr[i];
  }
  return NaN;
}

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

/**
 * Count how many consecutive bars the given predicate has been true
 * (scanning backward from the last element).
 */
function consecutiveDays(
  values: number[],
  predicate: (v: number) => boolean
): number {
  let count = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (isNaN(values[i])) break;
    if (predicate(values[i])) count++;
    else break;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Signal persistence
// ---------------------------------------------------------------------------

/**
 * Detect how long a directional signal has been consistently present.
 * Returns the signal type and number of consecutive confirming days.
 */
export function detectSignalPersistence(
  closes: number[],
  candles: OHLCV[]
): PersistenceResult {
  const rsi = calcRSI(closes);
  const { histogram } = calcMACD(closes);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  // Daily signal labels
  const dailySignals: ('bullish' | 'bearish' | 'neutral')[] = closes.map(
    (_, i) => {
      const r = rsi[i];
      const h = histogram[i];
      const e20 = ema20[i];
      const e50 = ema50[i];
      const c = closes[i];

      if (isNaN(r) || isNaN(h) || isNaN(e20) || isNaN(e50)) return 'neutral';

      let bull = 0;
      let bear = 0;

      if (r > 55) bull++;
      else if (r < 45) bear++;

      if (h > 0) bull++;
      else if (h < 0) bear++;

      if (c > e20 && e20 > e50) bull++;
      else if (c < e20 && e20 < e50) bear++;

      if (bull >= 2) return 'bullish';
      if (bear >= 2) return 'bearish';
      return 'neutral';
    }
  );

  // Count consecutive days of same signal (from end)
  const finalSignal = last(dailySignals);
  let days = 0;
  for (let i = dailySignals.length - 1; i >= 0; i--) {
    if (dailySignals[i] === finalSignal) days++;
    else break;
  }

  // Strength: longer persistence → stronger (cap at 20 days)
  const strength = Math.min(1, days / 20);

  return { signal: finalSignal, days, strength };
}

// ---------------------------------------------------------------------------
// Single-asset forecast
// ---------------------------------------------------------------------------

export function forecastAsset(
  asset: string,
  closes: number[],
  candles: OHLCV[]
): ForecastResult {
  if (closes.length < 50) {
    return {
      asset,
      direction: 'sideways',
      confidence: 0,
      horizon: '5-7 days',
      targetPct: 0,
      reasoning: ['Insufficient data'],
      signals: {
        rsi: 50,
        macdHistogram: 0,
        trend: 'sideways',
        bbPosition: 'middle',
        adx: 20,
        atrPct: 0.01,
        persistenceDays: 0,
      },
    };
  }

  // --- Compute indicators --------------------------------------------------
  const rsiArr = calcRSI(closes);
  const rsi = lastValid(rsiArr);

  const { histogram } = calcMACD(closes);
  const macdHist = lastValid(histogram);

  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const lastClose = last(closes);
  const lastEma20 = lastValid(ema20);
  const lastEma50 = lastValid(ema50);

  let trend: 'up' | 'down' | 'sideways' = 'sideways';
  if (lastClose > lastEma20 && lastEma20 > lastEma50) trend = 'up';
  else if (lastClose < lastEma20 && lastEma20 < lastEma50) trend = 'down';

  const { upper, lower, squeeze } = calcBollingerBands(closes);
  const lastUpper = lastValid(upper);
  const lastLower = lastValid(lower);
  const lastSqueeze = last(squeeze);
  let bbPosition: SignalSnapshot['bbPosition'] = 'middle';
  if (lastSqueeze) bbPosition = 'squeeze';
  else if (lastClose >= lastUpper * 0.99) bbPosition = 'upper';
  else if (lastClose <= lastLower * 1.01) bbPosition = 'lower';

  const adxArr = calcADX(candles);
  const adx = lastValid(adxArr);

  const atrArr = calcATR(candles);
  const atr = lastValid(atrArr);
  const atrPct = lastClose > 0 ? atr / lastClose : 0.01;

  const persistence = detectSignalPersistence(closes, candles);

  // --- Scoring system ------------------------------------------------------
  let bullScore = 0;
  let bearScore = 0;
  const reasoning: string[] = [];

  // RSI
  if (rsi > 60) { bullScore += 2; reasoning.push(`RSI ${rsi.toFixed(1)} — bullish momentum`); }
  else if (rsi > 50) { bullScore += 1; reasoning.push(`RSI ${rsi.toFixed(1)} — mildly positive`); }
  else if (rsi < 40) { bearScore += 2; reasoning.push(`RSI ${rsi.toFixed(1)} — bearish momentum`); }
  else if (rsi < 50) { bearScore += 1; reasoning.push(`RSI ${rsi.toFixed(1)} — mildly negative`); }

  // MACD
  if (macdHist > 0) { bullScore += 2; reasoning.push('MACD histogram positive — upward pressure'); }
  else { bearScore += 2; reasoning.push('MACD histogram negative — downward pressure'); }

  // Trend
  if (trend === 'up') { bullScore += 3; reasoning.push('EMA structure bullish (20 > 50)'); }
  else if (trend === 'down') { bearScore += 3; reasoning.push('EMA structure bearish (20 < 50)'); }

  // BB position
  if (bbPosition === 'lower') { bullScore += 1; reasoning.push('Price at lower Bollinger Band — mean-reversion potential'); }
  if (bbPosition === 'upper') { bearScore += 1; reasoning.push('Price at upper Bollinger Band — overbought near-term'); }
  if (bbPosition === 'squeeze') { reasoning.push('Bollinger squeeze — breakout imminent, direction uncertain'); }

  // ADX confirms trend
  if (adx > 25 && trend === 'up') { bullScore += 2; reasoning.push(`ADX ${adx.toFixed(1)} confirms strong uptrend`); }
  if (adx > 25 && trend === 'down') { bearScore += 2; reasoning.push(`ADX ${adx.toFixed(1)} confirms strong downtrend`); }
  if (adx < 20) reasoning.push('ADX < 20 — weak trend, range-bound conditions likely');

  // Persistence bonus
  if (persistence.signal === 'bullish' && persistence.days >= 3) {
    bullScore += Math.min(2, Math.floor(persistence.days / 3));
    reasoning.push(`Bullish signals persistent for ${persistence.days} consecutive days`);
  } else if (persistence.signal === 'bearish' && persistence.days >= 3) {
    bearScore += Math.min(2, Math.floor(persistence.days / 3));
    reasoning.push(`Bearish signals persistent for ${persistence.days} consecutive days`);
  }

  // --- Determine direction and confidence ----------------------------------
  const total = bullScore + bearScore;
  let direction: 'up' | 'down' | 'sideways';
  let confidence: number;
  let targetPct: number;

  if (total === 0 || Math.abs(bullScore - bearScore) <= 1) {
    direction = 'sideways';
    confidence = 0.3 + (adx < 20 ? 0.2 : 0);
    targetPct = atrPct * 0.5 * 100;
  } else if (bullScore > bearScore) {
    direction = 'up';
    confidence = Math.min(0.9, 0.4 + (bullScore / total) * 0.5 + persistence.strength * 0.1);
    targetPct = +(atrPct * 1.5 * 100).toFixed(2);
  } else {
    direction = 'down';
    confidence = Math.min(0.9, 0.4 + (bearScore / total) * 0.5 + persistence.strength * 0.1);
    targetPct = -(atrPct * 1.5 * 100).toFixed(2);
  }

  return {
    asset,
    direction,
    confidence: +confidence.toFixed(2),
    horizon: persistence.days >= 5 ? '7-10 days' : '5-7 days',
    targetPct: +targetPct.toFixed(2),
    reasoning: reasoning.slice(0, 5),
    signals: {
      rsi: +rsi.toFixed(2),
      macdHistogram: +macdHist.toFixed(4),
      trend,
      bbPosition,
      adx: +adx.toFixed(2),
      atrPct: +atrPct.toFixed(4),
      persistenceDays: persistence.days,
    },
  };
}

// ---------------------------------------------------------------------------
// Multi-asset forecast
// ---------------------------------------------------------------------------

export interface MultiAssetForecast {
  forecasts: ForecastResult[];
  topBullish: ForecastResult[];
  topBearish: ForecastResult[];
  generatedAt: string;
}

export function forecastMultipleAssets(
  assets: { name: string; closes: number[]; candles: OHLCV[] }[]
): MultiAssetForecast {
  const forecasts = assets.map((a) =>
    forecastAsset(a.name, a.closes, a.candles)
  );

  const topBullish = forecasts
    .filter((f) => f.direction === 'up')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  const topBearish = forecasts
    .filter((f) => f.direction === 'down')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  return {
    forecasts,
    topBullish,
    topBearish,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Macro-adjusted confidence modifier
// ---------------------------------------------------------------------------

/**
 * Adjusts forecast confidence based on macro environment.
 * High VIX → reduce bull confidence; low VIX → boost.
 */
export function applyMacroAdjustment(
  forecast: ForecastResult,
  vix: number,
  fiiFlow: number
): ForecastResult {
  let delta = 0;

  if (forecast.direction === 'up') {
    if (vix > 22) delta -= 0.1;
    else if (vix < 15) delta += 0.05;
    if (fiiFlow > 1000) delta += 0.05;
    else if (fiiFlow < -1000) delta -= 0.08;
  } else if (forecast.direction === 'down') {
    if (vix > 22) delta += 0.1;
    if (fiiFlow < -1000) delta += 0.05;
  }

  const newConf = Math.max(0.05, Math.min(0.95, forecast.confidence + delta));
  return { ...forecast, confidence: +newConf.toFixed(2) };
}
