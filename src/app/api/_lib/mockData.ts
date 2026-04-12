// ============================================================
// X-Capital Flow — Shared Mock Data & Computation Utilities
// ============================================================

export interface AssetPrice {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  category: "equity" | "commodity" | "currency" | "bond" | "index";
}

export interface MacroData {
  fiiFlow: number;
  diiFlow: number;
  vix: number;
  cpi: number;
  india10y: number;
}

export interface OHLCVBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ──────────────────────────────────────────────
// Base prices (as of March 2026 approximate)
// ──────────────────────────────────────────────
export const BASE_PRICES: Record<string, { price: number; name: string; category: AssetPrice["category"] }> = {
  NIFTY50:      { price: 23450.75, name: "Nifty 50",           category: "equity" },
  SENSEX:       { price: 77210.40, name: "BSE Sensex",         category: "equity" },
  NIFTY_BANK:   { price: 49820.30, name: "Nifty Bank",         category: "equity" },
  NIFTY_IT:     { price: 37650.20, name: "Nifty IT",           category: "equity" },
  NIFTY_PHARMA: { price: 21340.80, name: "Nifty Pharma",       category: "equity" },
  NIFTY_FMCG:   { price: 56780.60, name: "Nifty FMCG",        category: "equity" },
  SMALLCAP:     { price: 15620.45, name: "Nifty Smallcap 100", category: "equity" },
  SPX:          { price: 5480.20,  name: "S&P 500",            category: "equity" },
  GOLD:         { price: 91250.00, name: "Gold (MCX)",         category: "commodity" },
  SILVER:       { price: 98450.00, name: "Silver (MCX)",       category: "commodity" },
  COPPER:       { price: 830.50,   name: "Copper (MCX)",       category: "commodity" },
  CRUDE_OIL:    { price: 6180.00,  name: "Crude Oil (MCX)",    category: "commodity" },
  DXY:          { price: 104.32,   name: "US Dollar Index",    category: "currency" },
  USDINR:       { price: 84.65,    name: "USD/INR",            category: "currency" },
  US10Y:        { price: 4.52,     name: "US 10Y Yield",       category: "bond" },
  US2Y:         { price: 4.78,     name: "US 2Y Yield",        category: "bond" },
};

// Deterministic pseudo-random based on a seed
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

// ──────────────────────────────────────────────
// Generate realistic OHLCV series
// ──────────────────────────────────────────────
export function generateOHLCV(symbol: string, days: number = 200): OHLCVBar[] {
  const base = BASE_PRICES[symbol];
  if (!base) return [];

  const bars: OHLCVBar[] = [];
  const today = new Date("2026-03-28");
  let prevClose = base.price;

  // Volatility profiles per category
  const volatility: Record<AssetPrice["category"], number> = {
    equity:    0.012,
    commodity: 0.015,
    currency:  0.004,
    bond:      0.008,
    index:     0.010,
  };
  const vol = volatility[base.category] ?? 0.012;

  // Base volume per symbol (approximate daily traded qty/value)
  const baseVolumes: Record<string, number> = {
    NIFTY50: 185_000_000,
    SENSEX: 195_000_000,
    NIFTY_BANK: 95_000_000,
    NIFTY_IT: 42_000_000,
    NIFTY_PHARMA: 28_000_000,
    NIFTY_FMCG: 22_000_000,
    SMALLCAP: 55_000_000,
    SPX: 3_800_000_000,
    GOLD: 12_000_000,
    SILVER: 8_500_000,
    COPPER: 6_200_000,
    CRUDE_OIL: 45_000_000,
    DXY: 0,
    USDINR: 18_000_000_000,
    US10Y: 0,
    US2Y: 0,
  };

  // Walk backwards from today to generate history
  const closes: number[] = [];
  let c = prevClose;
  // Generate raw closes first (reverse order, then flip)
  for (let i = days; i >= 0; i--) {
    const seed = (symbol.charCodeAt(0) * 31 + i * 17) % 9999;
    const rand = seededRandom(seed) * 2 - 1; // -1 to +1
    // Add slight upward drift for equity, slight mean reversion for bonds/currency
    const drift = base.category === "equity" ? 0.0003 : 0.0001;
    c = c * (1 + rand * vol + drift);
    closes.unshift(c);
  }

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - i));
    const dateStr = date.toISOString().split("T")[0];

    const close = closes[i + 1];
    const open = closes[i] * (1 + (seededRandom(i * 7 + 3) - 0.5) * vol * 0.5);
    const high = Math.max(open, close) * (1 + seededRandom(i * 11 + 5) * vol * 0.5);
    const low  = Math.min(open, close) * (1 - seededRandom(i * 13 + 7) * vol * 0.5);
    const baseVol = baseVolumes[symbol] ?? 10_000_000;
    const volume = Math.round(baseVol * (0.7 + seededRandom(i * 19 + 11) * 0.6));

    bars.push({
      date: dateStr,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low:  parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
    });
  }

  return bars;
}

// ──────────────────────────────────────────────
// Technical indicator computations
// ──────────────────────────────────────────────

export function computeRSI(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return [50];
  const rsiValues: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < closes.length; i++) {
    if (i === period) {
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsiValues.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));
      continue;
    }
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));
  }

  return rsiValues;
}

export function computeSMA(closes: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    result.push(parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(2)));
  }
  return result;
}

export function computeEMA(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    if (i >= period - 1) {
      result.push(parseFloat(ema.toFixed(2)));
    }
  }
  return result;
}

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function computeMACD(closes: number[]): MACDResult {
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);
  const macdLine: number[] = [];

  const offset = ema12.length - ema26.length;
  for (let i = 0; i < ema26.length; i++) {
    macdLine.push(parseFloat((ema12[i + offset] - ema26[i]).toFixed(2)));
  }

  const signalLine = computeEMA(macdLine, 9);
  const lastMACD = macdLine[macdLine.length - 1] ?? 0;
  const lastSignal = signalLine[signalLine.length - 1] ?? 0;

  return {
    macd: lastMACD,
    signal: lastSignal,
    histogram: parseFloat((lastMACD - lastSignal).toFixed(2)),
  };
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  squeeze: boolean;
}

export function computeBollinger(closes: number[], period: number = 20, stdDevMult: number = 2): BollingerResult {
  const sma = computeSMA(closes, period);
  const middle = sma[sma.length - 1] ?? closes[closes.length - 1];
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const bandWidth = (2 * stdDevMult * stdDev) / middle;
  return {
    upper: parseFloat((middle + stdDevMult * stdDev).toFixed(2)),
    middle: parseFloat(middle.toFixed(2)),
    lower: parseFloat((middle - stdDevMult * stdDev).toFixed(2)),
    squeeze: bandWidth < 0.04,
  };
}

export function computeATR(bars: OHLCVBar[], period: number = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].high - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low - bars[i - 1].close);
    trs.push(Math.max(hl, hc, lc));
  }
  const slice = trs.slice(-period);
  return parseFloat((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2));
}

export function computeADX(bars: OHLCVBar[], period: number = 14): number {
  if (bars.length < period * 2) return 20;
  const dxValues: number[] = [];
  let smoothedPDM = 0;
  let smoothedNDM = 0;
  let smoothedATR = 0;

  for (let i = 1; i < bars.length; i++) {
    const upMove  = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    const pdm = upMove > downMove && upMove > 0 ? upMove : 0;
    const ndm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    smoothedPDM = i < period
      ? smoothedPDM + pdm
      : smoothedPDM - smoothedPDM / period + pdm;
    smoothedNDM = i < period
      ? smoothedNDM + ndm
      : smoothedNDM - smoothedNDM / period + ndm;
    smoothedATR = i < period
      ? smoothedATR + tr
      : smoothedATR - smoothedATR / period + tr;

    if (i >= period && smoothedATR > 0) {
      const pdi = 100 * smoothedPDM / smoothedATR;
      const ndi = 100 * smoothedNDM / smoothedATR;
      const dx  = Math.abs(pdi - ndi) / (pdi + ndi || 1) * 100;
      dxValues.push(dx);
    }
  }

  if (dxValues.length === 0) return 20;
  const adxSlice = dxValues.slice(-period);
  return parseFloat((adxSlice.reduce((a, b) => a + b, 0) / adxSlice.length).toFixed(2));
}

export function computeOBV(bars: OHLCVBar[]): number {
  let obv = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].close > bars[i - 1].close) obv += bars[i].volume;
    else if (bars[i].close < bars[i - 1].close) obv -= bars[i].volume;
  }
  // Normalize to -100 to +100 range
  const maxVol = bars.reduce((a, b) => a + b.volume, 0);
  return parseFloat(((obv / maxVol) * 100).toFixed(2));
}

// OBV Trend: slope of cumulative OBV over recent bars.
// Returns +1 (rising), -1 (falling), 0 (flat) — more useful than absolute value.
export function computeOBVTrend(bars: OHLCVBar[], slopePeriod = 10): number {
  if (bars.length < slopePeriod + 2) return 0;
  // Build raw OBV series for last slopePeriod+1 bars
  const slice = bars.slice(-(slopePeriod + 1));
  const obvSeries: number[] = [0];
  for (let i = 1; i < slice.length; i++) {
    const prev = obvSeries[i - 1];
    if (slice[i].close > slice[i - 1].close)      obvSeries.push(prev + slice[i].volume);
    else if (slice[i].close < slice[i - 1].close) obvSeries.push(prev - slice[i].volume);
    else                                           obvSeries.push(prev);
  }
  // Linear regression slope
  const n    = obvSeries.length;
  const sumX = (n * (n - 1)) / 2;
  const sumX2= (n * (n - 1) * (2 * n - 1)) / 6;
  const sumY = obvSeries.reduce((a, b) => a + b, 0);
  const sumXY= obvSeries.reduce((s, y, x) => s + x * y, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  // Normalize by avg volume so the slope is meaningful across different index sizes
  const avgVol = slice.reduce((s, b) => s + b.volume, 0) / slice.length || 1;
  const normSlope = slope / avgVol;
  if (normSlope > 0.05) return 1;
  if (normSlope < -0.05) return -1;
  return 0;
}

// RSI Divergence: compares recent price lows/highs vs RSI lows/highs.
// Returns 'bullish' (price lower low, RSI higher low) or 'bearish' (price higher high, RSI lower high).
export function detectRSIDivergence(closes: number[], rsiArr: number[], lookback = 14): "bullish" | "bearish" | "none" {
  if (closes.length < lookback + 5 || rsiArr.length < lookback + 5) return "none";
  const pSlice  = closes.slice(-lookback);
  const rSlice  = rsiArr.slice(-lookback);

  // Bullish divergence: price makes lower low, RSI makes higher low
  const pLow1  = Math.min(...pSlice.slice(0, lookback / 2));
  const pLow2  = Math.min(...pSlice.slice(lookback / 2));
  const rLow1  = Math.min(...rSlice.slice(0, lookback / 2));
  const rLow2  = Math.min(...rSlice.slice(lookback / 2));
  if (pLow2 < pLow1 * 0.995 && rLow2 > rLow1 * 1.005) return "bullish";

  // Bearish divergence: price makes higher high, RSI makes lower high
  const pHigh1 = Math.max(...pSlice.slice(0, lookback / 2));
  const pHigh2 = Math.max(...pSlice.slice(lookback / 2));
  const rHigh1 = Math.max(...rSlice.slice(0, lookback / 2));
  const rHigh2 = Math.max(...rSlice.slice(lookback / 2));
  if (pHigh2 > pHigh1 * 1.005 && rHigh2 < rHigh1 * 0.995) return "bearish";

  return "none";
}

// ATR Regime: compares current ATR to its N-bar average.
// Returns 'expanding' (volatility rising), 'contracting' (squeeze loading), 'normal'.
export function computeATRRegime(bars: OHLCVBar[], period = 14, avgPeriod = 50): "expanding" | "contracting" | "normal" {
  if (bars.length < avgPeriod + period) return "normal";
  // Compute ATR for each bar in the avgPeriod window
  const atrValues: number[] = [];
  for (let i = bars.length - avgPeriod; i < bars.length; i++) {
    const slice = bars.slice(Math.max(0, i - period), i + 1);
    let atrSum = 0;
    for (let j = 1; j < slice.length; j++) {
      const tr = Math.max(
        slice[j].high - slice[j].low,
        Math.abs(slice[j].high - slice[j - 1].close),
        Math.abs(slice[j].low  - slice[j - 1].close),
      );
      atrSum += tr;
    }
    atrValues.push(atrSum / (slice.length - 1));
  }
  const avgATR    = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
  const currentATR= atrValues.at(-1)!;
  if (currentATR > avgATR * 1.4)  return "expanding";
  if (currentATR < avgATR * 0.65) return "contracting";
  return "normal";
}

// ADX Slope: is the trend strengthening or weakening?
// Returns positive (rising ADX), negative (falling ADX), 0 (flat).
export function computeADXSlope(bars: OHLCVBar[], period = 14, slopeBars = 5): number {
  if (bars.length < period + slopeBars + 5) return 0;
  // Compute ADX at two points: now and slopeBars ago
  // Use a simplified single-value ADX rather than full series (already have computeADX)
  // We'll just check if recent bars show rising +DI/-DI spread
  const recentSlice = bars.slice(-slopeBars - 1);
  const trValues = recentSlice.slice(1).map((b, i) => Math.max(
    b.high - b.low,
    Math.abs(b.high - recentSlice[i].close),
    Math.abs(b.low  - recentSlice[i].close),
  ));
  const firstHalf  = trValues.slice(0, Math.floor(trValues.length / 2));
  const secondHalf = trValues.slice(Math.floor(trValues.length / 2));
  const avgFirst   = firstHalf.reduce((a, b) => a + b, 0)  / (firstHalf.length  || 1);
  const avgSecond  = secondHalf.reduce((a, b) => a + b, 0) / (secondHalf.length || 1);
  return avgSecond - avgFirst; // positive = TR expanding = ADX rising
}

// Volume spike: returns % above 20-bar average (positive = spike, negative = below avg)
export function computeVolumeSpike(bars: OHLCVBar[], lookback = 20): number {
  if (bars.length < lookback + 1) return 0;
  const recent = bars.slice(-lookback - 1);
  const avgVol = recent.slice(0, lookback).reduce((s, b) => s + b.volume, 0) / lookback;
  if (avgVol === 0) return 0;
  const lastVol = recent[recent.length - 1].volume;
  return parseFloat(((lastVol / avgVol - 1) * 100).toFixed(1));
}

export function computeVWAP(bars: OHLCVBar[]): number {
  const recent = bars.slice(-20);
  let cumTPV = 0;
  let cumVol = 0;
  for (const b of recent) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * b.volume;
    cumVol += b.volume;
  }
  // Indices (NSE) have zero volume from Yahoo Finance; fall back to arithmetic mean of typical price
  if (cumVol === 0) {
    const tpSum = recent.reduce((s, b) => s + (b.high + b.low + b.close) / 3, 0);
    return recent.length === 0 ? 0 : parseFloat((tpSum / recent.length).toFixed(2));
  }
  return parseFloat((cumTPV / cumVol).toFixed(2));
}

export function computeHeikinAshi(bars: OHLCVBar[]): "bullish" | "bearish" | "neutral" {
  if (bars.length < 3) return "neutral";

  // Build proper Heikin Ashi candles
  // HA_Close = (O + H + L + C) / 4
  // HA_Open  = (prev_HA_Open + prev_HA_Close) / 2  (seed: first bar midpoint)
  // HA_High  = max(High, HA_Open, HA_Close)
  // HA_Low   = min(Low,  HA_Open, HA_Close)
  const ha: { open: number; close: number; high: number; low: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b       = bars[i];
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen  = i === 0
      ? (b.open + b.close) / 2
      : (ha[i - 1].open + ha[i - 1].close) / 2;
    ha.push({
      open:  haOpen,
      close: haClose,
      high:  Math.max(b.high, haOpen, haClose),
      low:   Math.min(b.low,  haOpen, haClose),
    });
  }

  // Analyse last 5 HA candles
  const recent    = ha.slice(-5);
  const last      = recent[recent.length - 1];
  const bullCount = recent.filter(c => c.close > c.open).length;
  const bearCount = recent.filter(c => c.close < c.open).length;

  // Strong signal: 4+ candles in same direction
  // Extra confirmation: last candle has no opposing wick
  const bodySize    = Math.abs(last.close - last.open) || 0.0001;
  const noLowerWick = (Math.min(last.open, last.close) - last.low)  / bodySize < 0.2;
  const noUpperWick = (last.high - Math.max(last.open, last.close)) / bodySize < 0.2;

  if (bullCount >= 4 || (bullCount >= 3 && last.close > last.open && noLowerWick)) return "bullish";
  if (bearCount >= 4 || (bearCount >= 3 && last.close < last.open && noUpperWick)) return "bearish";
  return "neutral";
}

// ─── MACD Histogram from price bars ──────────────────────────────────────────
export function computeMACDHist(closes: number[]): number {
  if (closes.length < 35) return 0;
  const ema = (data: number[], n: number): number[] => {
    const k = 2 / (n + 1);
    const out: number[] = [data[0]];
    for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
    return out;
  };
  const ema12  = ema(closes, 12);
  const ema26  = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal   = ema(macdLine, 9);
  const hist     = macdLine[macdLine.length - 1] - signal[signal.length - 1];
  return parseFloat(hist.toFixed(2));
}

export function computeFibLevels(bars: OHLCVBar[]): Record<string, number> {
  const highs = bars.map(b => b.high);
  const lows  = bars.map(b => b.low);
  const high  = Math.max(...highs);
  const low   = Math.min(...lows);
  const diff  = high - low;
  return {
    level0:   parseFloat(low.toFixed(2)),
    level236: parseFloat((low + diff * 0.236).toFixed(2)),
    level382: parseFloat((low + diff * 0.382).toFixed(2)),
    level500: parseFloat((low + diff * 0.500).toFixed(2)),
    level618: parseFloat((low + diff * 0.618).toFixed(2)),
    level786: parseFloat((low + diff * 0.786).toFixed(2)),
    level100: parseFloat(high.toFixed(2)),
  };
}

export function computeSupportResistance(bars: OHLCVBar[]): { support: number; resistance: number } {
  const recent = bars.slice(-50);
  const highs  = recent.map(b => b.high);
  const lows   = recent.map(b => b.low);
  return {
    support:    parseFloat(Math.min(...lows).toFixed(2)),
    resistance: parseFloat(Math.max(...highs).toFixed(2)),
  };
}

// ─── Volume Profile ───────────────────────────────────────────────────────────
// POC = price level with most volume over the lookback window.
// VAH/VAL = upper/lower boundary of the 70% value area around POC.
// For zero-volume instruments (NSE indices) each bar is counted equally.

export function computeVolumeProfile(bars: OHLCVBar[], lookback = 20, numBuckets = 24): {
  poc: number; vah: number; val: number;
} {
  const slice  = bars.slice(-lookback);
  const high   = Math.max(...slice.map(b => b.high));
  const low    = Math.min(...slice.map(b => b.low));
  const range  = high - low;
  if (range === 0 || slice.length === 0) {
    const p = slice.at(-1)?.close ?? 0;
    return { poc: p, vah: p, val: p };
  }

  const bucketSize = range / numBuckets;
  const buckets    = new Array<number>(numBuckets).fill(0);
  const totalVol   = slice.reduce((s, b) => s + b.volume, 0);
  const useEven    = totalVol === 0; // indices have no real volume

  for (const bar of slice) {
    const vol = useEven ? 1 : bar.volume;
    for (let i = 0; i < numBuckets; i++) {
      const bLow  = low + i * bucketSize;
      const bHigh = bLow + bucketSize;
      const overlap = Math.min(bar.high, bHigh) - Math.max(bar.low, bLow);
      if (overlap > 0) {
        const barRange = (bar.high - bar.low) || bucketSize;
        buckets[i] += vol * (overlap / barRange);
      }
    }
  }

  const pocIdx = buckets.indexOf(Math.max(...buckets));
  const poc    = low + (pocIdx + 0.5) * bucketSize;

  // Expand outward from POC until 70% of total volume is covered
  const target = buckets.reduce((a, b) => a + b, 0) * 0.70;
  let lo = pocIdx, hi = pocIdx;
  let accumulated = buckets[pocIdx];
  while (accumulated < target && (lo > 0 || hi < numBuckets - 1)) {
    const extD = lo > 0             ? buckets[lo - 1] : -1;
    const extU = hi < numBuckets-1  ? buckets[hi + 1] : -1;
    if (extU >= extD) { hi++; accumulated += buckets[hi]; }
    else              { lo--; accumulated += buckets[lo]; }
  }

  return {
    poc: parseFloat(poc.toFixed(2)),
    vah: parseFloat((low + (hi + 1) * bucketSize).toFixed(2)),
    val: parseFloat((low + lo * bucketSize).toFixed(2)),
  };
}

// ─── Market Structure (BOS / CHOCH) ──────────────────────────────────────────
// Detects swing highs/lows (5-bar pivot), then:
//   BOS  (Break of Structure) = continuation — breaks in direction of trend
//   CHOCH (Change of Character) = reversal signal — breaks against the trend

export interface MarketStructureResult {
  structure: "bullish" | "bearish" | "ranging";
  lastEvent: "BOS_UP" | "BOS_DOWN" | "CHOCH_UP" | "CHOCH_DOWN" | "none";
  swingHigh: number;
  swingLow:  number;
}

export function computeMarketStructure(bars: OHLCVBar[]): MarketStructureResult {
  const slice = bars.slice(-60);
  if (slice.length < 12) {
    return { structure: "ranging", lastEvent: "none", swingHigh: 0, swingLow: 0 };
  }

  const swingHighs: number[] = [];
  const swingLows:  number[] = [];

  // 5-bar pivot: bar[i] must be highest/lowest of the 5-bar window
  for (let i = 2; i < slice.length - 2; i++) {
    const h = slice[i].high;
    const l = slice[i].low;
    if (h > slice[i-1].high && h > slice[i-2].high && h > slice[i+1].high && h > slice[i+2].high)
      swingHighs.push(h);
    if (l < slice[i-1].low  && l < slice[i-2].low  && l < slice[i+1].low  && l < slice[i+2].low)
      swingLows.push(l);
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { structure: "ranging", lastEvent: "none", swingHigh: 0, swingLow: 0 };
  }

  const lastHigh = swingHighs.at(-1)!;
  const prevHigh = swingHighs.at(-2)!;
  const lastLow  = swingLows.at(-1)!;
  const prevLow  = swingLows.at(-2)!;
  const close    = slice.at(-1)!.close;

  let structure: MarketStructureResult["structure"] = "ranging";
  let lastEvent:  MarketStructureResult["lastEvent"]  = "none";

  const hhhl = lastHigh > prevHigh && lastLow > prevLow;  // higher highs, higher lows
  const lhll = lastHigh < prevHigh && lastLow < prevLow;  // lower highs, lower lows

  if (hhhl) {
    structure = "bullish";
    if (close > lastHigh) lastEvent = "BOS_UP";
    if (close < lastLow)  lastEvent = "CHOCH_DOWN";
  } else if (lhll) {
    structure = "bearish";
    if (close < lastLow)  lastEvent = "BOS_DOWN";
    if (close > lastHigh) lastEvent = "CHOCH_UP";
  }

  return { structure, lastEvent, swingHigh: lastHigh, swingLow: lastLow };
}

// ─── Liquidity Sweep (Stop Hunt) ─────────────────────────────────────────────
// A sweep happens when price wicks beyond a recent swing high/low (triggering stops)
// then closes back inside — signalling smart money absorption.
//   Bullish sweep: wick below swing low + closes above it (stops cleared → potential long)
//   Bearish sweep: wick above swing high + closes below it (stops cleared → potential short)

export interface LiquiditySweepResult {
  swept: "bullish" | "bearish" | "none";
  level:   number;
  barsAgo: number;
}

export function detectLiquiditySweep(bars: OHLCVBar[], lookback = 30): LiquiditySweepResult {
  if (bars.length < 15) return { swept: "none", level: 0, barsAgo: 0 };

  const ref    = bars.slice(-lookback, -5);  // reference range for swing levels
  const recent = bars.slice(-5);             // last 5 bars to check for sweeps

  const swingHigh = Math.max(...ref.map(b => b.high));
  const swingLow  = Math.min(...ref.map(b => b.low));

  for (let i = 0; i < recent.length; i++) {
    const bar = recent[i];
    const barsAgo = recent.length - 1 - i;
    // Bullish sweep: wick pierces swing low but closes above it
    if (bar.low < swingLow && bar.close > swingLow) {
      return { swept: "bullish", level: parseFloat(swingLow.toFixed(2)), barsAgo };
    }
    // Bearish sweep: wick pierces swing high but closes below it
    if (bar.high > swingHigh && bar.close < swingHigh) {
      return { swept: "bearish", level: parseFloat(swingHigh.toFixed(2)), barsAgo };
    }
  }

  return { swept: "none", level: 0, barsAgo: 0 };
}

// ─── Order Blocks ─────────────────────────────────────────────────────────────
// Demand OB = last bearish candle before a strong bullish impulse (institutional buying)
// Supply OB = last bullish candle before a strong bearish impulse (institutional selling)
// If current price revisits the zone → high-probability reversal area.

export interface OrderBlockResult {
  inDemandZone: boolean;
  inSupplyZone: boolean;
  demandLow:  number;
  demandHigh: number;
  supplyLow:  number;
  supplyHigh: number;
}

export function detectOrderBlocks(bars: OHLCVBar[]): OrderBlockResult {
  const slice = bars.slice(-50);
  const close = slice.at(-1)?.close ?? 0;
  const IMPULSE_THRESHOLD = 0.006;  // 0.6% body to qualify as an impulse candle

  let demandLow = 0, demandHigh = 0;
  let supplyLow = 0, supplyHigh = 0;

  // Scan from most-recent backward so we get the freshest zones
  for (let i = slice.length - 2; i >= 2; i--) {
    const bar      = slice[i];
    const bodyPct  = Math.abs(bar.close - bar.open) / (bar.open || 1);
    if (bodyPct < IMPULSE_THRESHOLD) continue;

    const prev = slice[i - 1];

    // Strong bullish impulse → look for last bearish candle before it (demand OB)
    if (bar.close > bar.open && demandLow === 0) {
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        const ob = slice[j];
        if (ob.close < ob.open) {
          demandLow  = parseFloat(Math.min(ob.open, ob.close).toFixed(2));
          demandHigh = parseFloat(Math.max(ob.open, ob.close).toFixed(2));
          break;
        }
      }
    }

    // Strong bearish impulse → look for last bullish candle before it (supply OB)
    if (bar.close < bar.open && supplyLow === 0) {
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        const ob = slice[j];
        if (ob.close > ob.open) {
          supplyLow  = parseFloat(Math.min(ob.open, ob.close).toFixed(2));
          supplyHigh = parseFloat(Math.max(ob.open, ob.close).toFixed(2));
          break;
        }
      }
    }

    if (demandLow > 0 && supplyLow > 0) break;
    void prev;
  }

  return {
    inDemandZone: demandLow > 0 && close >= demandLow * 0.995 && close <= demandHigh * 1.005,
    inSupplyZone: supplyLow > 0 && close >= supplyLow * 0.995 && close <= supplyHigh * 1.005,
    demandLow, demandHigh, supplyLow, supplyHigh,
  };
}

// ──────────────────────────────────────────────
// Macro data (mock, updates deterministically)
// ──────────────────────────────────────────────
export function getMacroData(): MacroData {
  return {
    fiiFlow:  -2340,
    diiFlow:   1850,
    vix:       17.4,
    cpi:        4.5,
    india10y:   6.82,
  };
}

// ──────────────────────────────────────────────
// Market snapshot
// ──────────────────────────────────────────────
export function getMarketSnapshot(): AssetPrice[] {
  const changes: Record<string, number> = {
    NIFTY50:      -0.45,
    SENSEX:       -0.42,
    NIFTY_BANK:   -0.68,
    NIFTY_IT:      0.82,
    NIFTY_PHARMA:  1.12,
    NIFTY_FMCG:    0.35,
    SMALLCAP:     -0.91,
    SPX:          -0.28,
    GOLD:          0.95,
    SILVER:        1.32,
    COPPER:       -0.55,
    CRUDE_OIL:    -1.20,
    DXY:           0.15,
    USDINR:        0.08,
    US10Y:        -0.02,
    US2Y:         -0.03,
  };

  return Object.entries(BASE_PRICES).map(([symbol, meta]) => {
    const changePercent = changes[symbol] ?? 0;
    const change = parseFloat((meta.price * changePercent / 100).toFixed(2));
    return {
      symbol,
      name:          meta.name,
      price:         meta.price,
      change,
      changePercent,
      category:      meta.category,
    };
  });
}

// ──────────────────────────────────────────────
// Relative Strength Ratios
// ──────────────────────────────────────────────
export function computeRelativeStrength() {
  const prices = BASE_PRICES;
  return {
    goldNifty:         parseFloat((prices.GOLD.price / prices.NIFTY50.price).toFixed(4)),
    niftyUS10Y:        parseFloat((prices.NIFTY50.price / (prices.US10Y.price * 1000)).toFixed(4)),
    smallcapLargecap:  parseFloat((prices.SMALLCAP.price / prices.NIFTY50.price).toFixed(4)),
    niftySPX:          parseFloat((prices.NIFTY50.price / prices.SPX.price).toFixed(4)),
    copperGold:        parseFloat((prices.COPPER.price / prices.GOLD.price * 100).toFixed(4)),
  };
}

// ──────────────────────────────────────────────
// Regime detection
// ──────────────────────────────────────────────
export type RegimeType = "Risk-Off" | "Risk-On" | "Neutral" | "Stagflation" | "Reflation";

export function detectRegime(): { type: RegimeType; confidence: number; description: string; drivers: string[] } {
  const macro = getMacroData();
  // Simple rule-based regime detection
  const riskOffSignals = [
    macro.vix > 16,
    macro.fiiFlow < 0,
    BASE_PRICES.GOLD.price > 85000,
    BASE_PRICES.CRUDE_OIL.price < 6500,
  ];
  const riskOnSignals = [
    macro.diiFlow > 2000,
    BASE_PRICES.NIFTY_IT.price > 35000,
    macro.vix < 14,
  ];
  const riskOffCount = riskOffSignals.filter(Boolean).length;
  const riskOnCount  = riskOnSignals.filter(Boolean).length;

  if (riskOffCount >= 3) {
    return {
      type: "Risk-Off",
      confidence: 0.68,
      description: "Markets are in defensive mode with elevated volatility, FII outflows, and rotation toward safe-haven assets like gold.",
      drivers: ["Elevated VIX (17.4)", "FII net selling ₹2,340 Cr", "Gold outperforming equity", "Crude oil weakness signaling demand concerns"],
    };
  }
  if (riskOnCount >= 2) {
    return {
      type: "Risk-On",
      confidence: 0.60,
      description: "Markets showing risk appetite with DII support and IT sector outperformance.",
      drivers: ["DII buying support", "IT sector strength", "Low volatility environment"],
    };
  }
  return {
    type: "Neutral",
    confidence: 0.50,
    description: "Mixed signals across asset classes — market in consolidation phase.",
    drivers: ["Mixed FII/DII flows", "Sector rotation underway"],
  };
}

// ──────────────────────────────────────────────
// Composite scores
// ──────────────────────────────────────────────
export function computeCompositeScores(bars200: OHLCVBar[]) {
  const closes = bars200.map(b => b.close);
  const rsiArr  = computeRSI(closes);
  const rsi     = rsiArr[rsiArr.length - 1] ?? 50;
  const macd    = computeMACD(closes);
  const adx     = computeADX(bars200);
  const macro   = getMacroData();
  const rs      = computeRelativeStrength();

  // Capital Rotation Score (0-100): how actively capital is rotating
  // Higher = more rotation activity
  const rotationScore = Math.min(100, Math.round(
    (Math.abs(macro.fiiFlow) / 5000) * 40 +
    (Math.abs(macro.diiFlow) / 5000) * 20 +
    (rs.goldNifty > 3.5 ? 20 : 10) +
    (macro.vix > 16 ? 20 : 10)
  ));

  // Risk Pressure Index (0-100): higher = more risk pressure
  const riskPressure = Math.min(100, Math.round(
    (macro.vix / 30) * 35 +
    (macro.fiiFlow < 0 ? 20 : 0) +
    (rsi < 40 ? 20 : rsi > 70 ? 10 : 5) +
    (Math.abs(macd.histogram) > 50 ? 15 : 5) +
    (adx > 25 ? 10 : 5)
  ));

  // Market Health Score (0-100): higher = healthier market
  const healthScore = Math.min(100, Math.round(
    (rsi > 40 && rsi < 65 ? 25 : 10) +
    (macro.diiFlow > 0 ? 20 : 0) +
    (adx < 30 ? 15 : 5) +
    (macro.vix < 18 ? 20 : 5) +
    (rs.smallcapLargecap > 0.6 ? 20 : 10)
  ));

  return { rotationScore, riskPressure, healthScore };
}
