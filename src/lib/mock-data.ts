// ============================================================
// mock-data.ts — Seeded random-walk market data generator
// ============================================================

export interface PriceData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MacroData {
  FII_FLOW: number;
  DII_FLOW: number;
  INDIA_VIX: number;
  CPI: number;
  INDIA_10Y: number;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG — mulberry32
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convert a symbol string to a numeric seed */
function symbolSeed(symbol: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < symbol.length; i++) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Asset baseline configuration
// ---------------------------------------------------------------------------
interface AssetConfig {
  base: number;
  dailyVolatility: number; // fraction, e.g. 0.01 = 1%
  trendBias: number;       // per-day drift fraction
  volumeBase: number;      // units per day
}

const ASSET_CONFIG: Record<string, AssetConfig> = {
  NIFTY50:     { base: 24000, dailyVolatility: 0.0085, trendBias:  0.0003, volumeBase: 180_000_000 },
  SENSEX:      { base: 79000, dailyVolatility: 0.0085, trendBias:  0.0003, volumeBase:  80_000_000 },
  NIFTY_BANK:  { base: 51000, dailyVolatility: 0.0105, trendBias:  0.0002, volumeBase:  60_000_000 },
  NIFTY_IT:    { base: 32000, dailyVolatility: 0.0110, trendBias:  0.0004, volumeBase:  40_000_000 },
  NIFTY_PHARMA:{ base: 21000, dailyVolatility: 0.0090, trendBias:  0.0002, volumeBase:  25_000_000 },
  NIFTY_FMCG:  { base: 58000, dailyVolatility: 0.0070, trendBias:  0.0002, volumeBase:  20_000_000 },
  SMALLCAP:    { base: 15000, dailyVolatility: 0.0120, trendBias:  0.0003, volumeBase:  50_000_000 },
  SPX:         { base:  5500, dailyVolatility: 0.0080, trendBias:  0.0003, volumeBase: 400_000_000 },
  GOLD:        { base:  2600, dailyVolatility: 0.0060, trendBias:  0.0001, volumeBase:  30_000_000 },
  SILVER:      { base:    30, dailyVolatility: 0.0120, trendBias:  0.0001, volumeBase:  50_000_000 },
  COPPER:      { base:   4.2, dailyVolatility: 0.0130, trendBias:  0.0000, volumeBase: 100_000_000 },
  CRUDE_OIL:   { base:    75, dailyVolatility: 0.0150, trendBias: -0.0001, volumeBase: 200_000_000 },
  DXY:         { base:   104, dailyVolatility: 0.0040, trendBias:  0.0000, volumeBase:   5_000_000 },
  USDINR:      { base:    84, dailyVolatility: 0.0020, trendBias:  0.0001, volumeBase:   3_000_000 },
  US10Y:       { base:   4.3, dailyVolatility: 0.0050, trendBias:  0.0000, volumeBase:   1_000_000 },
  US2Y:        { base:   4.6, dailyVolatility: 0.0045, trendBias:  0.0000, volumeBase:   1_000_000 },
};

// ---------------------------------------------------------------------------
// Box-Muller transform for normal random variable
// ---------------------------------------------------------------------------
function boxMuller(rand: () => number): number {
  const u1 = rand();
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------
export function getMockPriceData(symbol: string, days: number = 200): PriceData[] {
  const config = ASSET_CONFIG[symbol];
  if (!config) {
    throw new Error(`Unknown symbol: ${symbol}. Valid symbols: ${Object.keys(ASSET_CONFIG).join(', ')}`);
  }

  const rand = mulberry32(symbolSeed(symbol));
  const result: PriceData[] = [];

  // Walk backward from today
  const today = new Date('2026-03-28');
  let close = config.base;

  // Pre-generate all closes so we can back-fill dates forward
  const closes: number[] = [close];
  for (let i = 1; i < days; i++) {
    const shock = boxMuller(rand) * config.dailyVolatility;
    // Mean-reversion nudge keeps price near the baseline
    const meanRev = (config.base - close) / config.base * 0.02;
    close = close * (1 + config.trendBias + shock + meanRev);
    // Clamp to a reasonable band (±40% of base)
    close = Math.max(config.base * 0.6, Math.min(config.base * 1.4, close));
    closes.push(close);
  }

  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - (days - 1 - i));
    const dateStr = d.toISOString().split('T')[0];

    const c = closes[i];
    const dailyRange = c * config.dailyVolatility * (0.8 + rand() * 0.8);
    const openOffset = (rand() - 0.5) * dailyRange;
    const open = c + openOffset;
    const high = Math.max(open, c) + rand() * dailyRange * 0.5;
    const low  = Math.min(open, c) - rand() * dailyRange * 0.5;
    const vol  = Math.round(config.volumeBase * (0.6 + rand() * 0.8));

    result.push({
      date: dateStr,
      open:   +open.toFixed(4),
      high:   +high.toFixed(4),
      low:    +low.toFixed(4),
      close:  +c.toFixed(4),
      volume: vol,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Macro snapshot
// ---------------------------------------------------------------------------
export function getMockMacroData(): MacroData {
  const rand = mulberry32(0xdeadbeef);

  return {
    FII_FLOW:   Math.round((rand() * 5500) - 2500),   // -2500 to +3000 crores
    DII_FLOW:   Math.round((rand() * 4000) - 500),    // -500 to +3500 crores
    INDIA_VIX:  +(12 + rand() * 18).toFixed(2),        // 12-30
    CPI:        +(3.8 + rand() * 1.4).toFixed(2),      // 3.8-5.2%
    INDIA_10Y:  +(6.5 + rand() * 0.6).toFixed(2),      // 6.5-7.1%
  };
}

// ---------------------------------------------------------------------------
// Helper: get all available symbols
// ---------------------------------------------------------------------------
export const ALL_SYMBOLS = Object.keys(ASSET_CONFIG);

// ---------------------------------------------------------------------------
// Convenience: bulk load multiple symbols
// ---------------------------------------------------------------------------
export function getAllMockData(days = 200): Record<string, PriceData[]> {
  return Object.fromEntries(
    ALL_SYMBOLS.map((sym) => [sym, getMockPriceData(sym, days)])
  );
}
