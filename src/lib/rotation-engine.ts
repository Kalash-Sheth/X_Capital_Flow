// ============================================================
// rotation-engine.ts — Capital rotation & market regime engine
// ============================================================

import {
  calcRSI,
  calcMACD,
  calcEMA,
  calcADX,
  calcBollingerBands,
  calcRelativeStrength,
  calcYieldCurve,
  calcCapitalRotationScore,
  calcRiskPressureIndex,
  calcMarketHealthScore,
  OHLCV,
} from './indicators';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComputedIndicators {
  // Price arrays (closes)
  nifty50Closes: number[];
  niftyBankCloses: number[];
  niftyITCloses: number[];
  niftyPharmaCloses: number[];
  niftyFMCGCloses: number[];
  smallcapCloses: number[];
  goldCloses: number[];
  silverCloses: number[];
  crudeoilCloses: number[];
  spxCloses: number[];
  dxyCloses: number[];
  usdinrCloses: number[];
  us10y: number;
  us2y: number;

  // Candles (for ADX / ATR)
  nifty50Candles: OHLCV[];

  // Macro
  fiiFlow: number;
  diiFlow: number;
  indiaVix: number;
  cpi: number;
  india10y: number;

  // Breadth (fractions 0-1)
  above50Pct: number;
  above200Pct: number;
  advanceDecline: number;
}

export interface RotationResult {
  from: string;
  to: string;
  confidence: number;  // 0-1
  regime: 'Risk-On' | 'Risk-Off' | 'Transitioning' | 'Neutral';
  signals: string[];
  strength: 'Strong' | 'Moderate' | 'Weak';
  timeframe: 'Short-term' | 'Medium-term';
}

export interface MarketRegime {
  type: 'Risk-On' | 'Risk-Off' | 'Transitioning' | 'Neutral';
  confidence: number;      // 0-1
  description: string;
  drivers: string[];
}

export interface AllocationResult {
  allocations: { asset: string; weight: number; rationale: string }[];
  summary: string;
  riskLevel: 'Aggressive' | 'Moderate' | 'Defensive';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function lastN<T>(arr: T[], n: number): T[] {
  return arr.slice(Math.max(0, arr.length - n));
}

/** Slope of last N values (simple linear regression coefficient) */
function slope(values: number[], n = 5): number {
  const v = lastN(values.filter((x) => !isNaN(x)), n);
  if (v.length < 2) return 0;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let num = 0;
  let den = 0;
  v.forEach((val, i) => {
    num += (i - (v.length - 1) / 2) * (val - mean);
    den += Math.pow(i - (v.length - 1) / 2, 2);
  });
  return den === 0 ? 0 : num / den;
}

function normalizedSlope(values: number[], n = 5): number {
  const v = lastN(values.filter((x) => !isNaN(x)), n);
  if (v.length === 0) return 0;
  const mean = v.reduce((a, b) => a + b, 0) / v.length || 1;
  return slope(v, n) / mean;
}

// ---------------------------------------------------------------------------
// Derived signal extraction
// ---------------------------------------------------------------------------

interface DerivedSignals {
  niftyRsi: number;
  niftyMacdHist: number;
  niftyAdx: number;
  goldNiftyRatioSlope: number;
  dxySlope: number;
  yieldCurve: ReturnType<typeof calcYieldCurve>;
  fiiFlow: number;
  vix: number;
  cpi: number;
  india10y: number;
  realYield: number;
  rotationScore: number;
  riskPressure: number;
  marketHealth: number;
  niftyBBsqueeze: boolean;
  niftyTrend: 'up' | 'down' | 'sideways';
  goldTrend: 'up' | 'down' | 'sideways';
  itVsNiftySlope: number;
  pharmaVsNiftySlope: number;
  smallcapVsNiftySlope: number;
  bankVsNiftySlope: number;
}

function extractSignals(ind: ComputedIndicators): DerivedSignals {
  const niftyRsiArr = calcRSI(ind.nifty50Closes);
  const niftyRsi = last(niftyRsiArr.filter((x) => !isNaN(x))) ?? 50;

  const { histogram } = calcMACD(ind.nifty50Closes);
  const niftyMacdHist = last(histogram.filter((x) => !isNaN(x))) ?? 0;

  const adxArr = calcADX(ind.nifty50Candles);
  const niftyAdx = last(adxArr.filter((x) => !isNaN(x))) ?? 20;

  const goldNiftyRatio = calcRelativeStrength(
    ind.goldCloses,
    ind.nifty50Closes
  );
  const goldNiftyRatioSlope = normalizedSlope(goldNiftyRatio, 10);

  const dxySlope = normalizedSlope(ind.dxyCloses, 10);

  const yieldCurve = calcYieldCurve(ind.us10y, ind.us2y);
  const realYield = ind.us10y - ind.cpi;

  const { squeeze } = calcBollingerBands(ind.nifty50Closes);
  const niftyBBsqueeze = last(squeeze);

  // Simple EMA trend
  const ema20 = calcEMA(ind.nifty50Closes, 20);
  const ema50 = calcEMA(ind.nifty50Closes, 50);
  const lastClose = last(ind.nifty50Closes);
  const lastEma20 = last(ema20.filter((x) => !isNaN(x))) ?? lastClose;
  const lastEma50 = last(ema50.filter((x) => !isNaN(x))) ?? lastClose;
  let niftyTrend: 'up' | 'down' | 'sideways' = 'sideways';
  if (lastClose > lastEma20 && lastEma20 > lastEma50) niftyTrend = 'up';
  else if (lastClose < lastEma20 && lastEma20 < lastEma50) niftyTrend = 'down';

  const goldEma20 = calcEMA(ind.goldCloses, 20);
  const goldEma50 = calcEMA(ind.goldCloses, 50);
  const lastGold = last(ind.goldCloses);
  const lastGoldEma20 = last(goldEma20.filter((x) => !isNaN(x))) ?? lastGold;
  const lastGoldEma50 = last(goldEma50.filter((x) => !isNaN(x))) ?? lastGold;
  let goldTrend: 'up' | 'down' | 'sideways' = 'sideways';
  if (lastGold > lastGoldEma20 && lastGoldEma20 > lastGoldEma50)
    goldTrend = 'up';
  else if (lastGold < lastGoldEma20 && lastGoldEma20 < lastGoldEma50)
    goldTrend = 'down';

  // Sector vs Nifty relative slopes
  const itVsNiftySlope = normalizedSlope(
    calcRelativeStrength(ind.niftyITCloses, ind.nifty50Closes),
    10
  );
  const pharmaVsNiftySlope = normalizedSlope(
    calcRelativeStrength(ind.niftyPharmaCloses, ind.nifty50Closes),
    10
  );
  const smallcapVsNiftySlope = normalizedSlope(
    calcRelativeStrength(ind.smallcapCloses, ind.nifty50Closes),
    10
  );
  const bankVsNiftySlope = normalizedSlope(
    calcRelativeStrength(ind.niftyBankCloses, ind.nifty50Closes),
    10
  );

  // Composite scores
  const rotationScore = calcCapitalRotationScore({
    fiiFlow: ind.fiiFlow,
    diiFlow: ind.diiFlow,
    vix: ind.indiaVix,
    niftyRsi,
    goldNiftyRatio: goldNiftyRatioSlope,
    dxyTrend: dxySlope,
    yieldSpread: yieldCurve.spread,
  });

  const niftyAtrArr = calcADX(ind.nifty50Candles);
  const atrPct = 0.01; // approximate 1% without full ATR calc for brevity

  const riskPressure = calcRiskPressureIndex({
    vix: ind.indiaVix,
    fiiFlow: ind.fiiFlow,
    yieldSpread: yieldCurve.spread,
    usdInrChange: normalizedSlope(ind.usdinrCloses, 5),
    niftyRsi,
    atr: atrPct,
  });

  const marketHealth = calcMarketHealthScore({
    above50Pct: ind.above50Pct,
    above200Pct: ind.above200Pct,
    advanceDecline: ind.advanceDecline,
    macdHistogram: niftyMacdHist,
    adx: niftyAdx,
    obv: normalizedSlope(ind.nifty50Closes, 20),
    niftyRsi,
  });

  return {
    niftyRsi,
    niftyMacdHist,
    niftyAdx,
    goldNiftyRatioSlope,
    dxySlope,
    yieldCurve,
    fiiFlow: ind.fiiFlow,
    vix: ind.indiaVix,
    cpi: ind.cpi,
    india10y: ind.india10y,
    realYield,
    rotationScore,
    riskPressure,
    marketHealth,
    niftyBBsqueeze,
    niftyTrend,
    goldTrend,
    itVsNiftySlope,
    pharmaVsNiftySlope,
    smallcapVsNiftySlope,
    bankVsNiftySlope,
  };
}

// ---------------------------------------------------------------------------
// Confidence helpers
// ---------------------------------------------------------------------------

function confidenceFromCount(confirming: number, total: number): number {
  return Math.round((confirming / total) * 100) / 100;
}

function strengthFromConfidence(c: number): 'Strong' | 'Moderate' | 'Weak' {
  if (c >= 0.7) return 'Strong';
  if (c >= 0.45) return 'Moderate';
  return 'Weak';
}

// ---------------------------------------------------------------------------
// Rotation detection
// ---------------------------------------------------------------------------

export function detectRotation(
  indicators: ComputedIndicators
): RotationResult[] {
  const s = extractSignals(indicators);
  const results: RotationResult[] = [];

  // ---- Equity → Gold (Risk-Off trigger) -----------------------------------
  {
    const confirming: string[] = [];
    const total = 6;

    if (s.vix > 20) confirming.push(`VIX elevated at ${s.vix.toFixed(1)}`);
    if (s.goldNiftyRatioSlope > 0.001) confirming.push('Gold/Nifty ratio rising — defensive demand');
    if (s.fiiFlow < -500) confirming.push(`FII net outflow ₹${s.fiiFlow.toLocaleString()} cr`);
    if (s.yieldCurve.regime === 'inverted') confirming.push('Yield curve inverted — recession signal');
    if (s.niftyRsi < 45) confirming.push(`Nifty RSI weak at ${s.niftyRsi.toFixed(1)}`);
    if (s.goldTrend === 'up') confirming.push('Gold in uptrend (EMA20 > EMA50)');

    const conf = confidenceFromCount(confirming.length, total);
    if (conf >= 0.3) {
      results.push({
        from: 'Equity',
        to: 'Gold',
        confidence: conf,
        regime: s.riskPressure > 60 ? 'Risk-Off' : 'Transitioning',
        signals: confirming,
        strength: strengthFromConfidence(conf),
        timeframe: conf >= 0.6 ? 'Medium-term' : 'Short-term',
      });
    }
  }

  // ---- Gold → Equity (Risk-On recovery) -----------------------------------
  {
    const confirming: string[] = [];
    const total = 6;

    if (s.vix < 16) confirming.push(`VIX low at ${s.vix.toFixed(1)} — calm markets`);
    if (s.fiiFlow > 500) confirming.push(`FII net inflow ₹${s.fiiFlow.toLocaleString()} cr`);
    if (s.niftyRsi > 55) confirming.push(`Nifty RSI strong at ${s.niftyRsi.toFixed(1)}`);
    if (s.niftyTrend === 'up') confirming.push('Nifty in uptrend (EMA20 > EMA50)');
    if (s.dxySlope < -0.0005) confirming.push('DXY weakening — tailwind for EM');
    if (s.niftyMacdHist > 0) confirming.push('MACD histogram positive — bullish momentum');

    const conf = confidenceFromCount(confirming.length, total);
    if (conf >= 0.3) {
      results.push({
        from: 'Gold',
        to: 'Equity',
        confidence: conf,
        regime: 'Risk-On',
        signals: confirming,
        strength: strengthFromConfidence(conf),
        timeframe: conf >= 0.6 ? 'Medium-term' : 'Short-term',
      });
    }
  }

  // ---- Equity → Bonds (Extreme Risk-Off) ----------------------------------
  {
    const confirming: string[] = [];
    const total = 5;

    if (s.vix > 25) confirming.push(`VIX very high at ${s.vix.toFixed(1)} — panic territory`);
    if (s.yieldCurve.regime === 'inverted') confirming.push('Yield curve inverted');
    if (s.fiiFlow < -1500) confirming.push('Heavy FII exodus');
    if (s.niftyRsi < 35) confirming.push('Nifty deeply oversold');
    if (s.niftyTrend === 'down') confirming.push('Nifty in downtrend');

    const conf = confidenceFromCount(confirming.length, total);
    if (conf >= 0.35) {
      results.push({
        from: 'Equity',
        to: 'Bonds',
        confidence: conf,
        regime: 'Risk-Off',
        signals: confirming,
        strength: strengthFromConfidence(conf),
        timeframe: 'Medium-term',
      });
    }
  }

  // ---- Large-Cap → Small-Cap (Risk appetite expanding) --------------------
  {
    const confirming: string[] = [];
    const total = 5;

    if (s.smallcapVsNiftySlope > 0.001) confirming.push('Smallcap outperforming Nifty50');
    if (s.vix < 16) confirming.push('Low volatility environment');
    if (s.fiiFlow > 800) confirming.push('FII buying broad market');
    if (s.niftyAdx > 25 && s.niftyTrend === 'up') confirming.push('Strong Nifty uptrend (ADX > 25)');
    if (s.marketHealth > 60) confirming.push('Healthy market breadth');

    const conf = confidenceFromCount(confirming.length, total);
    if (conf >= 0.35) {
      results.push({
        from: 'Large-Cap',
        to: 'Small-Cap',
        confidence: conf,
        regime: 'Risk-On',
        signals: confirming,
        strength: strengthFromConfidence(conf),
        timeframe: 'Short-term',
      });
    }
  }

  // ---- Domestic → IT/Tech (DXY weakness / global tech rally) -------------
  {
    const confirming: string[] = [];
    const total = 4;

    if (s.itVsNiftySlope > 0.001) confirming.push('Nifty IT outperforming broad market');
    if (s.dxySlope < -0.001) confirming.push('USD weakening — positive for IT earnings');
    if (s.niftyRsi > 50) confirming.push('Nifty momentum positive');
    if (s.niftyMacdHist > 0) confirming.push('MACD bullish');

    const conf = confidenceFromCount(confirming.length, total);
    if (conf >= 0.4) {
      results.push({
        from: 'Domestic-Cyclicals',
        to: 'IT/Tech',
        confidence: conf,
        regime: 'Risk-On',
        signals: confirming,
        strength: strengthFromConfidence(conf),
        timeframe: 'Short-term',
      });
    }
  }

  // ---- Cyclicals → Defensives (Pharma/FMCG rotation) ---------------------
  {
    const confirming: string[] = [];
    const total = 5;

    if (s.pharmaVsNiftySlope > 0.001) confirming.push('Pharma outperforming — defensive rotation');
    if (s.vix > 18) confirming.push('Rising volatility');
    if (s.niftyRsi < 50) confirming.push('Nifty momentum fading');
    if (s.fiiFlow < 0) confirming.push('FII selling');
    if (s.niftyTrend !== 'up') confirming.push('Nifty not in uptrend');

    const conf = confidenceFromCount(confirming.length, total);
    if (conf >= 0.35) {
      results.push({
        from: 'Cyclicals',
        to: 'Defensives (Pharma/FMCG)',
        confidence: conf,
        regime: 'Transitioning',
        signals: confirming,
        strength: strengthFromConfidence(conf),
        timeframe: 'Short-term',
      });
    }
  }

  // Sort by confidence desc
  return results.sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// Market regime detection
// ---------------------------------------------------------------------------

export function detectMarketRegime(
  indicators: ComputedIndicators
): MarketRegime {
  const s = extractSignals(indicators);
  const drivers: string[] = [];

  let riskOnScore = 0;
  let riskOffScore = 0;

  // VIX
  if (s.vix < 15) { riskOnScore += 20; drivers.push('Low VIX signals calm'); }
  else if (s.vix > 22) { riskOffScore += 20; drivers.push(`Elevated VIX (${s.vix.toFixed(1)})`); }

  // FII
  if (s.fiiFlow > 1000) { riskOnScore += 15; drivers.push('Strong FII inflows'); }
  else if (s.fiiFlow < -1000) { riskOffScore += 15; drivers.push('FII selling pressure'); }

  // Nifty trend
  if (s.niftyTrend === 'up') { riskOnScore += 15; drivers.push('Nifty in uptrend'); }
  else if (s.niftyTrend === 'down') { riskOffScore += 15; drivers.push('Nifty in downtrend'); }

  // MACD
  if (s.niftyMacdHist > 0) { riskOnScore += 10; drivers.push('MACD momentum positive'); }
  else { riskOffScore += 10; drivers.push('MACD momentum negative'); }

  // Gold trend
  if (s.goldTrend === 'up') { riskOffScore += 10; drivers.push('Gold trending up — defensive demand'); }
  else if (s.goldTrend === 'down') { riskOnScore += 10; }

  // Yield curve
  if (s.yieldCurve.regime === 'inverted') { riskOffScore += 15; drivers.push('Inverted yield curve — recession risk'); }
  else if (s.yieldCurve.regime === 'normal') { riskOnScore += 10; drivers.push('Normal yield curve'); }

  // DXY
  if (s.dxySlope > 0.001) { riskOffScore += 8; drivers.push('Rising DXY (EM headwind)'); }
  else if (s.dxySlope < -0.001) { riskOnScore += 8; drivers.push('Falling DXY (EM tailwind)'); }

  // Breadth
  if (s.marketHealth > 65) { riskOnScore += 12; drivers.push('Healthy market breadth'); }
  else if (s.marketHealth < 35) { riskOffScore += 12; drivers.push('Poor market breadth'); }

  const total = riskOnScore + riskOffScore;
  const netScore = total === 0 ? 0 : (riskOnScore - riskOffScore) / total;

  let type: MarketRegime['type'];
  let description: string;
  let confidence: number;

  if (netScore > 0.25) {
    type = 'Risk-On';
    confidence = Math.min(0.95, 0.5 + netScore * 0.5);
    description =
      'Markets are in risk-on mode. Equities, cyclicals, and high-beta assets are preferred. Capital is flowing into growth assets.';
  } else if (netScore < -0.25) {
    type = 'Risk-Off';
    confidence = Math.min(0.95, 0.5 + Math.abs(netScore) * 0.5);
    description =
      'Risk-off environment prevailing. Defensive assets (gold, bonds, FMCG, pharma) are outperforming. Reduce equity exposure.';
  } else if (Math.abs(netScore) <= 0.1) {
    type = 'Neutral';
    confidence = 0.5;
    description =
      'Market signals are balanced. No clear directional bias. Maintain diversified positioning.';
  } else {
    type = 'Transitioning';
    confidence = 0.45 + Math.abs(netScore);
    description =
      'Market is transitioning between regimes. Mixed signals — watch for confirmation before repositioning.';
  }

  return {
    type,
    confidence: +confidence.toFixed(2),
    description,
    drivers: drivers.slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// Portfolio allocation
// ---------------------------------------------------------------------------

export function generatePortfolioAllocation(
  regime: MarketRegime,
  rotations: RotationResult[]
): AllocationResult {
  type Allocation = { asset: string; weight: number; rationale: string };
  let allocations: Allocation[] = [];
  let summary = '';
  let riskLevel: AllocationResult['riskLevel'];

  const highConfRotation = rotations.filter((r) => r.confidence >= 0.5);

  switch (regime.type) {
    case 'Risk-On':
      riskLevel = 'Aggressive';
      allocations = [
        { asset: 'NIFTY50 / Large-Cap Equity', weight: 35, rationale: 'Core equity allocation in risk-on' },
        { asset: 'NIFTY_BANK', weight: 15, rationale: 'Financials lead in bull markets' },
        { asset: 'NIFTY_IT', weight: 12, rationale: 'Tech sector benefits from growth narrative' },
        { asset: 'SMALLCAP', weight: 13, rationale: 'Higher beta play in risk-on' },
        { asset: 'GOLD', weight: 10, rationale: 'Diversification hedge' },
        { asset: 'SPX / US Equity', weight: 10, rationale: 'Global diversification' },
        { asset: 'Cash / Liquid', weight: 5, rationale: 'Dry powder for opportunities' },
      ];
      summary =
        'Portfolio is positioned aggressively for the risk-on environment with heavy equity allocation. Overweight financials and small-caps for beta.';
      break;

    case 'Risk-Off':
      riskLevel = 'Defensive';
      allocations = [
        { asset: 'GOLD', weight: 25, rationale: 'Primary safe-haven — rising in risk-off' },
        { asset: 'NIFTY_PHARMA', weight: 18, rationale: 'Defensive sector with stable earnings' },
        { asset: 'NIFTY_FMCG', weight: 15, rationale: 'Defensive consumption basket' },
        { asset: 'India Bonds / G-Sec', weight: 20, rationale: 'Capital preservation in flight-to-safety' },
        { asset: 'Cash / Liquid', weight: 12, rationale: 'Protect capital during volatility' },
        { asset: 'SILVER', weight: 5, rationale: 'Secondary precious metal hedge' },
        { asset: 'NIFTY50 (minimal)', weight: 5, rationale: 'Residual equity exposure only' },
      ];
      summary =
        'Defensive positioning. Heavy allocation to gold, bonds, and defensive sectors. Equity exposure reduced significantly to manage downside risk.';
      break;

    case 'Transitioning':
      riskLevel = 'Moderate';
      allocations = [
        { asset: 'NIFTY50 / Large-Cap Equity', weight: 25, rationale: 'Moderate equity; prefer quality' },
        { asset: 'GOLD', weight: 20, rationale: 'Hedge against regime uncertainty' },
        { asset: 'NIFTY_PHARMA', weight: 12, rationale: 'Defensive buffer' },
        { asset: 'India Bonds / G-Sec', weight: 15, rationale: 'Fixed income for stability' },
        { asset: 'NIFTY_IT', weight: 10, rationale: 'Selective tech exposure' },
        { asset: 'Cash / Liquid', weight: 10, rationale: 'High cash to wait for clarity' },
        { asset: 'SILVER / Commodities', weight: 8, rationale: 'Inflation/commodity hedge' },
      ];
      summary =
        'Balanced allocation during regime transition. High cash and gold to hedge uncertainty; reduced equity with quality tilt.';
      break;

    default: // Neutral
      riskLevel = 'Moderate';
      allocations = [
        { asset: 'NIFTY50 / Large-Cap Equity', weight: 30, rationale: 'Core equity' },
        { asset: 'GOLD', weight: 15, rationale: 'Diversification' },
        { asset: 'India Bonds / G-Sec', weight: 20, rationale: 'Fixed income ballast' },
        { asset: 'NIFTY_BANK', weight: 10, rationale: 'Financials in neutral markets' },
        { asset: 'NIFTY_IT', weight: 10, rationale: 'Tech for growth' },
        { asset: 'Cash / Liquid', weight: 10, rationale: 'Optionality' },
        { asset: 'SILVER / Commodities', weight: 5, rationale: 'Commodity exposure' },
      ];
      summary =
        'Balanced neutral allocation with equal attention to growth and safety.';
  }

  // Adjust weights based on high-confidence rotation signals
  for (const rot of highConfRotation) {
    if (rot.to === 'IT/Tech') {
      const itEntry = allocations.find((a) => a.asset.includes('IT'));
      if (itEntry) {
        itEntry.weight = Math.min(itEntry.weight + 5, 25);
        itEntry.rationale += ' — active rotation signal confirms overweight';
      }
    }
    if (rot.to === 'Small-Cap') {
      const scEntry = allocations.find((a) => a.asset.includes('SMALLCAP'));
      if (scEntry) {
        scEntry.weight = Math.min(scEntry.weight + 5, 20);
      }
    }
  }

  // Normalize to 100
  const totalW = allocations.reduce((s, a) => s + a.weight, 0);
  allocations = allocations.map((a) => ({
    ...a,
    weight: Math.round((a.weight / totalW) * 100),
  }));

  return { allocations, summary, riskLevel };
}
