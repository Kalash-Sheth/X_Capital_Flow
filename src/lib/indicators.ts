// ============================================================
// indicators.ts — Technical indicator library (pure TypeScript)
// ============================================================

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  date: string;
}

// ---------------------------------------------------------------------------
// Simple Moving Average
// ---------------------------------------------------------------------------
export function calcSMA(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    result[i] = sum / period;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exponential Moving Average
// ---------------------------------------------------------------------------
export function calcEMA(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  result[period - 1] = seed / period;
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------
export function calcRSI(closes: number[], period = 14): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss += Math.abs(delta);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  result[period] = 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta >= 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    result[i] = 100 - 100 / (1 + rs);
  }

  return result;
}

// ---------------------------------------------------------------------------
// MACD (12, 26, 9)
// ---------------------------------------------------------------------------
export function calcMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fast = calcEMA(closes, fastPeriod);
  const slow = calcEMA(closes, slowPeriod);

  const macdLine: number[] = closes.map((_, i) =>
    isNaN(fast[i]) || isNaN(slow[i]) ? NaN : fast[i] - slow[i]
  );

  // Signal line: EMA of MACD (only on valid values)
  const validMacd = macdLine.map((v) => (isNaN(v) ? 0 : v));
  const signalRaw = calcEMA(validMacd, signalPeriod);

  const signal: number[] = macdLine.map((v, i) =>
    isNaN(v) ? NaN : signalRaw[i]
  );
  const histogram: number[] = macdLine.map((v, i) =>
    isNaN(v) || isNaN(signal[i]) ? NaN : v - signal[i]
  );

  return { macd: macdLine, signal, histogram };
}

// ---------------------------------------------------------------------------
// Bollinger Bands
// ---------------------------------------------------------------------------
export function calcBollingerBands(
  closes: number[],
  period = 20,
  stdDevMult = 2
): { upper: number[]; middle: number[]; lower: number[]; squeeze: boolean[] } {
  const middle = calcSMA(closes, period);
  const upper: number[] = new Array(closes.length).fill(NaN);
  const lower: number[] = new Array(closes.length).fill(NaN);
  const squeeze: boolean[] = new Array(closes.length).fill(false);

  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    const mean = middle[i];
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += Math.pow(closes[j] - mean, 2);
    }
    const sd = Math.sqrt(sumSq / period);
    upper[i] = mean + stdDevMult * sd;
    lower[i] = mean - stdDevMult * sd;

    // Squeeze: bandwidth less than 4% of middle
    const bandwidth = (upper[i] - lower[i]) / middle[i];
    squeeze[i] = bandwidth < 0.04;
  }

  return { upper, middle, lower, squeeze };
}

// ---------------------------------------------------------------------------
// Heikin-Ashi
// ---------------------------------------------------------------------------
export function calcHeikinAshi(candles: OHLCV[]): OHLCV[] {
  return candles.map((c, i) => {
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen =
      i === 0
        ? (c.open + c.close) / 2
        : (candles[i - 1].open + candles[i - 1].close) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    return {
      date: c.date,
      open: +haOpen.toFixed(4),
      high: +haHigh.toFixed(4),
      low: +haLow.toFixed(4),
      close: +haClose.toFixed(4),
      volume: c.volume,
    };
  });
}

// ---------------------------------------------------------------------------
// Average True Range
// ---------------------------------------------------------------------------
export function calcATR(candles: OHLCV[], period = 14): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  const trueRanges: number[] = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
  });

  // First ATR is SMA of first `period` TRs
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = atr;

  for (let i = period; i < candles.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    result[i] = atr;
  }

  return result;
}

// ---------------------------------------------------------------------------
// ADX (Average Directional Index)
// ---------------------------------------------------------------------------
export function calcADX(candles: OHLCV[], period = 14): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period * 2) return result;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const prevClose = candles[i - 1].close;
    trueRanges.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose)
      )
    );
  }

  // Wilder smoothing
  const smooth = (arr: number[], p: number): number[] => {
    const s: number[] = [];
    let val = arr.slice(0, p).reduce((a, b) => a + b, 0);
    s[p - 1] = val;
    for (let i = p; i < arr.length; i++) {
      val = val - val / p + arr[i];
      s[i] = val;
    }
    return s;
  };

  const sPlusDM = smooth(plusDM, period);
  const sMinusDM = smooth(minusDM, period);
  const sTR = smooth(trueRanges, period);

  const dx: number[] = [];
  for (let i = period - 1; i < plusDM.length; i++) {
    const plusDI = (sPlusDM[i] / sTR[i]) * 100;
    const minusDI = (sMinusDM[i] / sTR[i]) * 100;
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  }

  // ADX is smoothed DX
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const adxStart = period * 2 - 1; // index in candles
  result[adxStart] = adx;

  for (let i = 1; i < dx.length - period + 1; i++) {
    adx = (adx * (period - 1) + dx[period - 1 + i]) / period;
    result[adxStart + i] = adx;
  }

  return result;
}

// ---------------------------------------------------------------------------
// VWAP
// ---------------------------------------------------------------------------
export function calcVWAP(candles: OHLCV[]): number[] {
  let cumulativeTPV = 0;
  let cumulativeVol = 0;
  return candles.map((c) => {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativeTPV += typicalPrice * c.volume;
    cumulativeVol += c.volume;
    return cumulativeVol === 0 ? typicalPrice : cumulativeTPV / cumulativeVol;
  });
}

// ---------------------------------------------------------------------------
// On-Balance Volume
// ---------------------------------------------------------------------------
export function calcOBV(candles: OHLCV[]): number[] {
  const result: number[] = new Array(candles.length).fill(0);
  result[0] = candles[0].volume;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) {
      result[i] = result[i - 1] + candles[i].volume;
    } else if (candles[i].close < candles[i - 1].close) {
      result[i] = result[i - 1] - candles[i].volume;
    } else {
      result[i] = result[i - 1];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fibonacci Retracement Levels
// ---------------------------------------------------------------------------
export function calcFibonacciLevels(
  high: number,
  low: number
): { level: number; price: number }[] {
  const diff = high - low;
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618];
  return ratios.map((r) => ({
    level: r,
    price: +(high - r * diff).toFixed(4),
  }));
}

// ---------------------------------------------------------------------------
// Support & Resistance (pivot-based)
// ---------------------------------------------------------------------------
export function calcSupportResistance(
  closes: number[]
): { support: number; resistance: number } {
  if (closes.length === 0) return { support: 0, resistance: 0 };

  // Use recent 50 bars; find local minima/maxima
  const window = closes.slice(-50);
  const sorted = [...window].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.15)];
  const q3 = sorted[Math.floor(sorted.length * 0.85)];

  return {
    support: +q1.toFixed(4),
    resistance: +q3.toFixed(4),
  };
}

// ---------------------------------------------------------------------------
// Market Breadth
// ---------------------------------------------------------------------------
export function calcMarketBreadth(
  allCloses: number[][],
  period: number
): { above50: number; above200: number; advanceDecline: number } {
  let above50 = 0;
  let above200 = 0;
  let advances = 0;
  let declines = 0;

  for (const closes of allCloses) {
    const last = closes[closes.length - 1];
    const sma50 = calcSMA(closes, 50);
    const sma200 = calcSMA(closes, 200);

    const s50 = sma50[sma50.length - 1];
    const s200 = sma200[sma200.length - 1];

    if (!isNaN(s50) && last > s50) above50++;
    if (!isNaN(s200) && last > s200) above200++;

    if (closes.length >= 2) {
      const prev = closes[closes.length - 2];
      if (last > prev) advances++;
      else if (last < prev) declines++;
    }
  }

  const total = allCloses.length;
  return {
    above50: total > 0 ? above50 / total : 0,
    above200: total > 0 ? above200 / total : 0,
    advanceDecline: declines === 0 ? advances : advances / declines,
  };
}

// ---------------------------------------------------------------------------
// Relative Strength (ratio of two assets)
// ---------------------------------------------------------------------------
export function calcRelativeStrength(
  closes1: number[],
  closes2: number[]
): number[] {
  const len = Math.min(closes1.length, closes2.length);
  return Array.from({ length: len }, (_, i) =>
    closes2[i] === 0 ? NaN : closes1[i] / closes2[i]
  );
}

// ---------------------------------------------------------------------------
// Yield Curve
// ---------------------------------------------------------------------------
export function calcYieldCurve(
  us10y: number,
  us2y: number
): { spread: number; regime: 'normal' | 'flat' | 'inverted' } {
  const spread = +(us10y - us2y).toFixed(4);
  let regime: 'normal' | 'flat' | 'inverted';
  if (spread > 0.25) regime = 'normal';
  else if (spread < 0) regime = 'inverted';
  else regime = 'flat';
  return { spread, regime };
}

// ---------------------------------------------------------------------------
// Real Yield
// ---------------------------------------------------------------------------
export function calcRealYield(us10y: number, cpi: number): number {
  return +(us10y - cpi).toFixed(4);
}

// ---------------------------------------------------------------------------
// Composite score helpers
// ---------------------------------------------------------------------------

/** Capital Rotation Score (0-100): high = strong rotation into risk assets */
export function calcCapitalRotationScore(signals: {
  fiiFlow: number;          // crores (positive = inflow)
  diiFlow: number;
  vix: number;
  niftyRsi: number;
  goldNiftyRatio: number;  // if rising → risk-off
  dxyTrend: number;        // positive = DXY rising (risk-off)
  yieldSpread: number;     // 10y-2y
}): number {
  let score = 50;

  // FII inflow is risk-on
  if (signals.fiiFlow > 1000) score += 15;
  else if (signals.fiiFlow > 0) score += 7;
  else if (signals.fiiFlow < -1000) score -= 15;
  else score -= 7;

  // DII provides stability
  if (signals.diiFlow > 1000) score += 5;
  else if (signals.diiFlow < -500) score -= 5;

  // Low VIX → risk-on
  if (signals.vix < 15) score += 10;
  else if (signals.vix > 22) score -= 12;
  else score += (22 - signals.vix) / 22 * 10 - 5;

  // RSI momentum
  if (signals.niftyRsi > 60) score += 8;
  else if (signals.niftyRsi < 40) score -= 8;

  // Gold/Nifty ratio: if rising → risk-off (subtract)
  if (signals.goldNiftyRatio > 0) score -= 5;
  else score += 5;

  // DXY: rising DXY is risk-off for EM
  if (signals.dxyTrend > 0) score -= 7;
  else score += 7;

  // Yield curve: inverted = risk-off
  if (signals.yieldSpread < 0) score -= 8;
  else if (signals.yieldSpread > 0.5) score += 5;

  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Risk Pressure Index (0-100): high = high systemic stress */
export function calcRiskPressureIndex(signals: {
  vix: number;
  fiiFlow: number;
  yieldSpread: number;
  usdInrChange: number;   // daily % change
  niftyRsi: number;
  atr: number;            // ATR as % of price
}): number {
  let pressure = 0;

  // VIX contribution (0-30 points)
  pressure += Math.min(30, (signals.vix / 30) * 30);

  // FII outflow stress (0-20 points)
  if (signals.fiiFlow < 0) {
    pressure += Math.min(20, (Math.abs(signals.fiiFlow) / 3000) * 20);
  }

  // Inverted yield curve (0-15 points)
  if (signals.yieldSpread < 0) {
    pressure += Math.min(15, (Math.abs(signals.yieldSpread) / 1) * 15);
  }

  // INR depreciation (0-15 points)
  if (signals.usdInrChange > 0) {
    pressure += Math.min(15, signals.usdInrChange * 50);
  }

  // Oversold RSI adds 10 points
  if (signals.niftyRsi < 35) pressure += 10;

  // High ATR (volatility) adds 10 points
  pressure += Math.min(10, signals.atr * 200);

  return Math.round(Math.max(0, Math.min(100, pressure)));
}

/** Market Health Score (0-100): high = healthy bull market */
export function calcMarketHealthScore(signals: {
  above50Pct: number;       // fraction 0-1
  above200Pct: number;      // fraction 0-1
  advanceDecline: number;   // >1 = more advances
  macdHistogram: number;    // positive = bullish
  adx: number;              // >25 = trending
  obv: number;              // slope: positive = accumulation
  niftyRsi: number;
}): number {
  let health = 0;

  // Breadth (0-30 points)
  health += signals.above50Pct * 15;
  health += signals.above200Pct * 15;

  // A/D ratio (0-20 points)
  const adRatio = Math.min(2, signals.advanceDecline) / 2;
  health += adRatio * 20;

  // MACD histogram (0-15 points)
  if (signals.macdHistogram > 0) health += 15;
  else health += Math.max(0, 15 + signals.macdHistogram);

  // Trend strength (0-15 points)
  health += Math.min(15, (signals.adx / 50) * 15);

  // OBV slope (0-10 points)
  if (signals.obv > 0) health += 10;

  // RSI zone (0-10 points)
  if (signals.niftyRsi >= 50 && signals.niftyRsi <= 70) health += 10;
  else if (signals.niftyRsi >= 40 && signals.niftyRsi < 50) health += 5;

  return Math.round(Math.max(0, Math.min(100, health)));
}
