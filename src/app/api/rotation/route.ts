// GET /api/rotation
// Capital rotation analysis computed entirely from real NeonDB price data.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeRSI, computeMACD, type OHLCVBar } from "../_lib/mockData";

export const dynamic = "force-dynamic";

interface RotationSignal {
  from:       string;
  to:         string;
  confidence: number;
  regime:     string;
  signals:    string[];
  strength:   "Strong" | "Moderate" | "Weak";
  timeframe:  string;
}

interface CapitalFlowPrediction {
  from:        string;
  to:          string;
  horizon:     "5D" | "10D" | "20D";
  confidence:  number;   // predicted confidence at that horizon
  direction:   "Strengthening" | "Weakening" | "Reversing" | "Stable";
  targetAlloc: Record<string, number>;  // predicted node allocations
  drivers:     string[];
  riskFactors: string[];
}

// ─── Batch fetch tickers from NeonDB ──────────────────────────────────────────
async function fetchBarsMap(tickers: string[], days = 120): Promise<Record<string, OHLCVBar[]>> {
  const assets = await prisma.asset.findMany({
    where: { ticker: { in: tickers } },
    include: {
      priceData: {
        orderBy: { timestamp: "asc" },
        take: days,
      },
    },
  });
  const result: Record<string, OHLCVBar[]> = {};
  for (const a of assets) {
    result[a.ticker] = a.priceData.map((r) => ({
      date:   r.timestamp.toISOString().slice(0, 10),
      open:   r.open,
      high:   r.high,
      low:    r.low,
      close:  r.close,
      volume: r.volume ?? 0,
    }));
  }
  return result;
}

// ─── Realized volatility (annualized %) ──────────────────────────────────────
function realizedVol(closes: number[], window = 20): number {
  if (closes.length < window + 1) return 15;
  const slice   = closes.slice(-window - 1);
  const returns = slice.slice(1).map((c, i) => Math.log(c / slice[i]));
  const mean    = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return parseFloat((Math.sqrt(variance * 252) * 100).toFixed(2));
}

// ─── Regime detection from real data ─────────────────────────────────────────
function detectRegime(
  niftyRSI: number,
  yieldSpread: number,
  vixProxy: number,
  goldMomentum: number,  // % change of gold over 20d
  niftyMomentum: number, // % change of nifty over 20d
) {
  let riskOffScore = 0;
  if (niftyRSI < 45)       riskOffScore += 2;
  if (yieldSpread < 0)     riskOffScore += 3;
  if (vixProxy > 20)       riskOffScore += 2;
  if (goldMomentum > 3)    riskOffScore += 2;  // gold rising → safe haven demand
  if (niftyMomentum < -3)  riskOffScore += 2;

  const type = riskOffScore >= 6
    ? "Risk-Off"
    : riskOffScore >= 3
    ? "Transitioning"
    : "Risk-On";

  const confidence = Math.min(0.95, 0.4 + (type === "Risk-Off" ? riskOffScore * 0.06 : riskOffScore * 0.04));

  return { type, confidence: parseFloat(confidence.toFixed(2)), riskOffScore };
}

// ─── Compute 20-day return (%) ────────────────────────────────────────────────
function ret20d(closes: number[]): number {
  if (closes.length < 21) return 0;
  const now  = closes.at(-1)!;
  const past = closes.at(-21)!;
  return parseFloat(((now / past - 1) * 100).toFixed(2));
}

export async function GET() {
  try {
    const TICKERS = ["NIFTY50", "NIFTY_IT", "NIFTY_PHARMA", "SMALLCAP",
                     "GOLD", "CRUDE_OIL", "SPX", "US10Y", "US2Y", "COPPER"];

    const barsMap = await fetchBarsMap(TICKERS, 120);

    const closes = (t: string) => (barsMap[t] ?? []).map((b) => b.close);
    const lastClose = (t: string) => closes(t).at(-1) ?? 0;

    // ── Per-asset indicators ───────────────────────────────────────────────
    const niftyCloses  = closes("NIFTY50");
    const goldCloses   = closes("GOLD");
    const itCloses     = closes("NIFTY_IT");
    const pharmaCloses = closes("NIFTY_PHARMA");
    const scCloses     = closes("SMALLCAP");

    const niftyRSIArr  = computeRSI(niftyCloses);
    const goldRSIArr   = computeRSI(goldCloses);
    const itRSIArr     = computeRSI(itCloses);
    const pharmaRSIArr = computeRSI(pharmaCloses);

    const niftyRSI  = niftyRSIArr.at(-1)  ?? 50;
    const goldRSI   = goldRSIArr.at(-1)   ?? 50;
    const itRSI     = itRSIArr.at(-1)     ?? 50;
    const pharmaRSI = pharmaRSIArr.at(-1) ?? 50;

    const niftyMACD  = computeMACD(niftyCloses);
    const niftyMACDHist = niftyMACD.histogram;
    const goldMACDHist  = computeMACD(goldCloses).histogram;

    // ── Yield curve (real DB prices) ───────────────────────────────────────
    const yield10y    = lastClose("US10Y");
    const yield2y     = lastClose("US2Y");
    const yieldSpread = parseFloat((yield10y - yield2y).toFixed(4));

    // ── Relative strength ratios ───────────────────────────────────────────
    const niftyPrice  = lastClose("NIFTY50");
    const goldPrice   = lastClose("GOLD");
    const spxPrice    = lastClose("SPX");
    const scPrice     = lastClose("SMALLCAP");
    const copperPrice = lastClose("COPPER");

    const goldNiftyRatio    = niftyPrice  ? goldPrice   / niftyPrice  : 0;
    const scLcRatio         = niftyPrice  ? scPrice     / niftyPrice  : 0;
    const niftySPXRatio     = spxPrice    ? niftyPrice  / spxPrice    : 0;
    const copperGoldRatio   = goldPrice   ? copperPrice / goldPrice   : 0;

    // ── Momentum (20-day returns) ──────────────────────────────────────────
    const niftyMomentum  = ret20d(niftyCloses);
    const goldMomentum   = ret20d(goldCloses);
    const scMomentum     = ret20d(scCloses);
    const pharmaMomentum = ret20d(pharmaCloses);
    const itMomentum     = ret20d(itCloses);

    // ── VIX proxy (Nifty realized vol) ────────────────────────────────────
    const vixProxy = realizedVol(niftyCloses, 20);

    // ── Regime detection ───────────────────────────────────────────────────
    const regime = detectRegime(niftyRSI, yieldSpread, vixProxy, goldMomentum, niftyMomentum);

    // ── Rotation signals ───────────────────────────────────────────────────
    const rotations: RotationSignal[] = [];

    // 1. Equity → Gold
    const goldNiftyRising    = goldNiftyRatio > 0.15;
    const equityWeak         = niftyRSI < 45;
    const vixElevated        = vixProxy > 18;
    const eqGoldConf = Math.min(0.95,
      (goldNiftyRising     ? 0.25 : 0) +
      (equityWeak          ? 0.20 : 0) +
      (vixElevated         ? 0.20 : 0) +
      (goldMomentum > 2    ? 0.20 : 0) +
      (goldRSI > 55        ? 0.15 : 0)
    );
    if (eqGoldConf > 0.25) {
      const sigs: string[] = [];
      if (vixElevated)        sigs.push(`Volatility elevated (${vixProxy.toFixed(1)}% annualized)`);
      if (goldNiftyRising)    sigs.push(`Gold/Nifty ratio ${goldNiftyRatio.toFixed(3)} (rising)`);
      if (goldMomentum > 2)   sigs.push(`Gold +${goldMomentum.toFixed(1)}% (20d)`);
      if (equityWeak)         sigs.push(`Nifty RSI weak (${niftyRSI.toFixed(1)})`);
      if (goldRSI > 55)       sigs.push(`Gold RSI bullish (${goldRSI.toFixed(1)})`);
      rotations.push({
        from: "Equity", to: "Gold",
        confidence: parseFloat(eqGoldConf.toFixed(2)),
        regime:     regime.type,
        signals:    sigs,
        strength:   eqGoldConf > 0.60 ? "Strong" : eqGoldConf > 0.40 ? "Moderate" : "Weak",
        timeframe:  "Medium-term",
      });
    }

    // 2. Equity → Bonds
    const bondConf = Math.min(0.95,
      (yieldSpread < 0.5 ? 0.25 : 0) +
      (vixElevated       ? 0.20 : 0) +
      (equityWeak        ? 0.20 : 0) +
      (niftyMomentum < -3 ? 0.20 : 0) +
      (yieldSpread < 0   ? 0.15 : 0)
    );
    if (bondConf > 0.20) {
      const sigs: string[] = [];
      if (yieldSpread < 0)    sigs.push(`Inverted yield curve (${yieldSpread.toFixed(2)}%)`);
      if (yieldSpread < 0.5)  sigs.push(`Tight yield spread (10Y-2Y: ${yieldSpread.toFixed(2)}%)`);
      if (vixElevated)        sigs.push("Elevated volatility — flight to safety");
      if (niftyMomentum < -3) sigs.push(`Nifty 20d return: ${niftyMomentum.toFixed(1)}%`);
      rotations.push({
        from: "Equity", to: "Bonds",
        confidence: parseFloat(bondConf.toFixed(2)),
        regime:     regime.type,
        signals:    sigs,
        strength:   bondConf > 0.55 ? "Strong" : bondConf > 0.35 ? "Moderate" : "Weak",
        timeframe:  "Medium-term",
      });
    }

    // 3. Smallcap → Largecap
    const scLcConf = Math.min(0.95,
      (scLcRatio < 0.7   ? 0.35 : 0) +
      (vixElevated       ? 0.25 : 0) +
      (scMomentum < niftyMomentum - 2 ? 0.25 : 0) +
      (equityWeak        ? 0.15 : 0)
    );
    if (scLcConf > 0.25) {
      const sigs: string[] = [];
      if (scLcRatio < 0.7)                        sigs.push(`Smallcap/Largecap ratio ${scLcRatio.toFixed(3)} (weak)`);
      if (scMomentum < niftyMomentum - 2)         sigs.push(`Smallcap lagging Nifty by ${(niftyMomentum - scMomentum).toFixed(1)}%`);
      if (vixElevated)                            sigs.push("Risk aversion favoring large-cap safety");
      rotations.push({
        from: "Smallcap", to: "Largecap",
        confidence: parseFloat(scLcConf.toFixed(2)),
        regime:     regime.type,
        signals:    sigs,
        strength:   scLcConf > 0.55 ? "Strong" : scLcConf > 0.35 ? "Moderate" : "Weak",
        timeframe:  "Short-term",
      });
    }

    // 4. IT / Growth → Pharma / Defensives
    const defConf = Math.min(0.90,
      (pharmaRSI > itRSI + 8    ? 0.35 : 0) +
      (pharmaMomentum > itMomentum + 3 ? 0.30 : 0) +
      (vixElevated              ? 0.20 : 0) +
      0.10
    );
    if (defConf > 0.25) {
      rotations.push({
        from: "IT / Growth", to: "Pharma / Defensives",
        confidence: parseFloat(defConf.toFixed(2)),
        regime:     regime.type,
        signals: [
          `Pharma RSI (${pharmaRSI.toFixed(1)}) vs IT RSI (${itRSI.toFixed(1)})`,
          `Pharma 20d: ${pharmaMomentum.toFixed(1)}% vs IT: ${itMomentum.toFixed(1)}%`,
          "Sector rotation to defensives underway",
        ],
        strength:  defConf > 0.55 ? "Strong" : defConf > 0.35 ? "Moderate" : "Weak",
        timeframe: "Short-term",
      });
    }

    const sorted = rotations.sort((a, b) => b.confidence - a.confidence);

    // Always generate predictions for all 4 standard pairs (regardless of threshold)
    // so the Predicted tab always has data even in calm markets.
    const str = (c: number, hi: number, mid: number): RotationSignal["strength"] =>
      c > hi ? "Strong" : c > mid ? "Moderate" : "Weak";
    const allPredictionPairs: RotationSignal[] = [
      { from: "Equity", to: "Gold",
        confidence: parseFloat(eqGoldConf.toFixed(2)),
        regime: regime.type, signals: [], strength: str(eqGoldConf, 0.60, 0.40), timeframe: "Medium-term" },
      { from: "Equity", to: "Bonds",
        confidence: parseFloat(bondConf.toFixed(2)),
        regime: regime.type, signals: [], strength: str(bondConf, 0.55, 0.35), timeframe: "Medium-term" },
      { from: "Smallcap", to: "Largecap",
        confidence: parseFloat(scLcConf.toFixed(2)),
        regime: regime.type, signals: [], strength: str(scLcConf, 0.55, 0.35), timeframe: "Short-term" },
      { from: "IT / Growth", to: "Pharma / Defensives",
        confidence: parseFloat(defConf.toFixed(2)),
        regime: regime.type, signals: [], strength: str(defConf, 0.55, 0.35), timeframe: "Short-term" },
    ].sort((a, b) => b.confidence - a.confidence);

    // ── FII/DII data from Indicator table ─────────────────────────────────
    // Used to adjust prediction confidence: institutional flow confirmation
    const niftyAsset = await prisma.asset.findUnique({
      where: { ticker: "NIFTY50" },
      include: {
        indicators: {
          where: { name: { in: ["FII_NET_CRORE", "DII_NET_CRORE"] } },
          orderBy: { timestamp: "desc" },
          take: 30,
        },
      },
    });

    // Compute cumulative 5-day FII net (positive = net buying)
    const fiiRows = (niftyAsset?.indicators ?? []).filter(i => i.name === "FII_NET_CRORE").slice(0, 5);
    const diiRows = (niftyAsset?.indicators ?? []).filter(i => i.name === "DII_NET_CRORE").slice(0, 5);
    const fiiNet5D = fiiRows.reduce((s, r) => s + r.value, 0);
    const diiNet5D = diiRows.reduce((s, r) => s + r.value, 0);
    const hasInstitutionalData = fiiRows.length > 0;

    // ── RSI slope (5-bar) — is momentum accelerating or fading? ───────────
    const niftyRSISlope = niftyRSIArr.length >= 6
      ? (niftyRSIArr.at(-1)! - niftyRSIArr.at(-6)!) / 5
      : 0;
    const goldRSISlope = goldRSIArr.length >= 6
      ? (goldRSIArr.at(-1)! - goldRSIArr.at(-6)!) / 5
      : 0;

    // ── Forward predictions (5D / 10D / 20D) ──────────────────────────────
    // Logic per horizon:
    //  5D  — momentum extrapolation + MACD direction + FII confirmation
    //  10D — RSI reversion pressure + yield curve trajectory
    //  20D — cycle phase continuation + regime persistence probability
    const predictions: CapitalFlowPrediction[] = allPredictionPairs.map((sig) => {
      const base = sig.confidence;

      // Momentum continuation factor: MACD histogram direction
      // For Equity→Gold/Bonds: negative niftyMACDHist = equity weakening → signal strengthens
      // For IT→Pharma: goldMACDHist not relevant; use niftyRSISlope
      const macdFactor = (sig.from.includes("Equity") || sig.from.includes("IT"))
        ? (niftyMACDHist < 0 ? 0.06 : -0.04)
        : (goldMACDHist  > 0 ? 0.04 : -0.02);

      // RSI slope factor: falling RSI → rotation signals strengthen
      const rsiFactor = niftyRSISlope < -1 ? 0.05 : niftyRSISlope > 1 ? -0.04 : 0;

      // FII confirmation: FII selling → risk-off rotations strengthen
      const fiiConf5D = hasInstitutionalData
        ? (fiiNet5D < -2000 ? 0.07 : fiiNet5D > 2000 ? -0.06 : 0)
        : 0;
      const diiOffset = hasInstitutionalData
        ? (diiNet5D > 1500 ? -0.03 : 0)  // DII buying can cushion risk-off
        : 0;

      // RSI reversion pressure for 10D (overbought/oversold mean-reversion)
      const reversionFactor10D = goldRSI > 72 ? -0.08 : goldRSI < 32 ? 0.06 : 0;

      // 20D regime persistence: strong risk-off regimes tend to persist
      const regimePersist20D = regime.riskOffScore >= 6 ? 0.05
        : regime.riskOffScore >= 3 ? 0.02 : -0.03;

      const conf5D  = Math.max(0.10, Math.min(0.95,
        base + macdFactor + rsiFactor + fiiConf5D + diiOffset
      ));
      const conf10D = Math.max(0.10, Math.min(0.95,
        conf5D + reversionFactor10D + rsiFactor * 0.5
      ));
      const conf20D = Math.max(0.10, Math.min(0.95,
        conf10D * 0.85 + regimePersist20D  // more uncertainty → regress toward mean
      ));

      // Direction label
      const delta5D = conf5D - base;
      const direction: CapitalFlowPrediction["direction"] =
        delta5D >  0.08 ? "Strengthening" :
        delta5D < -0.08 ? "Weakening"     :
        conf5D  <  0.20 ? "Reversing"     : "Stable";

      // Predicted node allocations at 5D horizon
      const predRiskOff = conf5D > 0.60;
      const predTransitioning = conf5D > 0.35 && conf5D <= 0.60;
      const targetAlloc: Record<string, number> = {
        EQUITY:        predRiskOff ? 26 : predTransitioning ? 34 : 44,
        GOLD:          predRiskOff ? 24 : predTransitioning ? 17 : 10,
        BONDS:         predRiskOff ? 26 : predTransitioning ? 21 : 15,
        CASH:          predRiskOff ? 14 : predTransitioning ? 12 : 8,
        COMMODITIES:   predRiskOff ?  6 : predTransitioning ?  8 : 12,
        INTERNATIONAL: predRiskOff ?  4 : predTransitioning ?  8 : 11,
      };

      // Build driver strings
      const drivers: string[] = [];
      if (Math.abs(niftyMACDHist) > 10) drivers.push(`MACD histogram ${niftyMACDHist > 0 ? "+" : ""}${niftyMACDHist.toFixed(0)} (${niftyMACDHist < 0 ? "bearish" : "bullish"})`);
      if (Math.abs(niftyRSISlope) > 0.5) drivers.push(`RSI slope ${niftyRSISlope > 0 ? "rising" : "falling"} (${niftyRSISlope.toFixed(1)}/day)`);
      if (hasInstitutionalData && Math.abs(fiiNet5D) > 500) drivers.push(`FII 5D net ₹${(fiiNet5D / 100).toFixed(0)}B (${fiiNet5D < 0 ? "selling" : "buying"})`);
      if (hasInstitutionalData && diiNet5D > 1000) drivers.push(`DII 5D net ₹${(diiNet5D / 100).toFixed(0)}B (buying)`);
      if (goldRSISlope > 1) drivers.push(`Gold RSI rising → safe-haven demand`);
      if (yieldSpread < 0) drivers.push(`Inverted yield curve persists`);

      const riskFactors: string[] = [];
      if (goldRSI > 70) riskFactors.push("Gold overbought — mean reversion risk");
      if (niftyRSI < 30) riskFactors.push("Nifty oversold — counter-rally risk");
      if (!hasInstitutionalData) riskFactors.push("No FII/DII data — run --fii to improve accuracy");
      if (conf20D < 0.30) riskFactors.push("Low 20D confidence — signal may fade");

      return {
        from: sig.from, to: sig.to,
        horizon: "5D" as const,
        confidence: parseFloat(conf5D.toFixed(2)),
        direction,
        targetAlloc,
        drivers: drivers.slice(0, 4),
        riskFactors: riskFactors.slice(0, 3),
        // Attach 10D/20D as nested (easier for UI)
        conf10D: parseFloat(conf10D.toFixed(2)),
        conf20D: parseFloat(conf20D.toFixed(2)),
      } as CapitalFlowPrediction & { conf10D: number; conf20D: number };
    });

    // ── Node allocation (regime-adjusted) ─────────────────────────────────
    const isRiskOff = regime.type === "Risk-Off";
    const isTransitioning = regime.type === "Transitioning";
    const nodes = [
      { id: "EQUITY",        label: "Equity",        color: "#6366f1",
        value: isRiskOff ? 28 : isTransitioning ? 36 : 45 },
      { id: "GOLD",          label: "Gold",          color: "#f59e0b",
        value: isRiskOff ? 22 : isTransitioning ? 16 : 10 },
      { id: "BONDS",         label: "Bonds",         color: "#3b82f6",
        value: isRiskOff ? 25 : isTransitioning ? 20 : 15 },
      { id: "CASH",          label: "Cash",          color: "#10b981",
        value: isRiskOff ? 15 : isTransitioning ? 12 : 8 },
      { id: "COMMODITIES",   label: "Commodities",   color: "#ef4444",
        value: isRiskOff ? 6  : isTransitioning ? 8  : 11 },
      { id: "INTERNATIONAL", label: "International", color: "#8b5cf6",
        value: isRiskOff ? 4  : isTransitioning ? 8  : 11 },
    ];

    // ── Capital flows ──────────────────────────────────────────────────────
    const flows = [
      { from: "EQUITY",      to: "GOLD",          magnitude: parseFloat(eqGoldConf.toFixed(2)), type: "outflow" as const },
      { from: "EQUITY",      to: "BONDS",         magnitude: parseFloat(bondConf.toFixed(2)),   type: "outflow" as const },
      { from: "EQUITY",      to: "CASH",          magnitude: parseFloat((isRiskOff ? 0.45 : 0.15).toFixed(2)), type: isRiskOff ? "outflow" as const : "neutral" as const },
      { from: "COMMODITIES", to: "GOLD",          magnitude: parseFloat((goldMomentum > 0 ? Math.min(0.8, goldMomentum / 10) : 0.1).toFixed(2)), type: goldMomentum > 2 ? "inflow" as const : "neutral" as const },
      { from: "INTERNATIONAL", to: "BONDS",       magnitude: parseFloat((isRiskOff ? 0.3 : 0.15).toFixed(2)), type: "neutral" as const },
    ];

    // ── Timeline from real 90-day history ─────────────────────────────────
    // Use last 90 price rows for NIFTY50, GOLD, US10Y, CRUDE_OIL, SPX
    // Compute rolling momentum scores → normalize to allocation weights

    const niftyBars90  = (barsMap["NIFTY50"]  ?? []).slice(-90);
    const goldBars90   = (barsMap["GOLD"]      ?? []).slice(-90);
    const bondBars90   = (barsMap["US10Y"]     ?? []).slice(-90); // yield → invert for price
    const crudeBars90  = (barsMap["CRUDE_OIL"] ?? []).slice(-90);
    const spxBars90    = (barsMap["SPX"]        ?? []).slice(-90);

    // Reference prices (first available)
    const niftyRef  = niftyBars90[0]?.close ?? 1;
    const goldRef   = goldBars90[0]?.close  ?? 1;
    const bondRef   = bondBars90[0]?.close  ?? 1;
    const crudeRef  = crudeBars90[0]?.close ?? 1;
    const spxRef    = spxBars90[0]?.close   ?? 1;

    const len90 = Math.max(
      niftyBars90.length, goldBars90.length, bondBars90.length,
      crudeBars90.length, spxBars90.length
    );

    const timeline = Array.from({ length: len90 }, (_, i) => {
      const niftyC = niftyBars90[i]?.close ?? niftyRef;
      const goldC  = goldBars90[i]?.close  ?? goldRef;
      const bondY  = bondBars90[i]?.close  ?? bondRef;  // yield — lower = better price
      const crudeC = crudeBars90[i]?.close ?? crudeRef;
      const spxC   = spxBars90[i]?.close   ?? spxRef;
      const date   = niftyBars90[i]?.date  ?? goldBars90[i]?.date ?? "";

      // Score = momentum from reference (capped to reasonable range)
      const equityScore      = Math.max(0.5, 1 + (niftyC / niftyRef - 1) * 3);
      const goldScore        = Math.max(0.5, 1 + (goldC  / goldRef  - 1) * 3);
      const bondsScore       = Math.max(0.5, 1 + (bondRef / bondY   - 1) * 3); // inverted: lower yield = higher score
      const commoditiesScore = Math.max(0.5, 1 + (crudeC  / crudeRef - 1) * 2);
      const intlScore        = Math.max(0.5, 1 + (spxC    / spxRef   - 1) * 2);
      const cashScore        = 0.8; // stable

      const total = equityScore + goldScore + bondsScore + commoditiesScore + intlScore + cashScore;

      return {
        date,
        equity:        Math.round((equityScore      / total) * 100),
        gold:          Math.round((goldScore         / total) * 100),
        bonds:         Math.round((bondsScore        / total) * 100),
        commodities:   Math.round((commoditiesScore  / total) * 100),
        international: Math.round((intlScore         / total) * 100),
        cash:          Math.round((cashScore         / total) * 100),
      };
    });

    return NextResponse.json({
      primary:     sorted[0] ?? null,
      all:         sorted,
      predictions,
      flows,
      nodes,
      timeline,
      fii: {
        net5D:    parseFloat(fiiNet5D.toFixed(2)),
        diiNet5D: parseFloat(diiNet5D.toFixed(2)),
        hasData:  hasInstitutionalData,
      },
      regime: {
        type:       regime.type,
        confidence: regime.confidence,
        score:      regime.riskOffScore,
      },
      meta: {
        yieldSpread,
        yield10y,
        yield2y,
        vixProxy,
        niftyRSI,
        goldRSI,
        niftyMomentum,
        goldMomentum,
        scLcRatio:    parseFloat(scLcRatio.toFixed(4)),
        niftySPXRatio: parseFloat(niftySPXRatio.toFixed(4)),
        copperGoldRatio: parseFloat(copperGoldRatio.toFixed(4)),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[GET /api/rotation]", error);
    return NextResponse.json({ error: "Failed to compute rotation analysis" }, { status: 500 });
  }
}
