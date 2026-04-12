// GET /api/signals/v2
// Capital flow signals organized by asset class → asset → indicators → weighted scores.
// Uses stored Indicator rows from DB (RSI_14, MACD_HIST, MOM_*, FLOW_SCORE, REL_STR_60D)
// and computes the rest (SMA, VWAP, ATR, Bollinger, ADX, S/R, Fib, HA) from live PriceData.
// No mock data — returns hasData:false for assets with insufficient price history.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  computeSMA, computeBollinger, computeADX, computeATR, computeVWAP,
  computeHeikinAshi, computeFibLevels, computeSupportResistance,
  computeVolumeProfile, computeMarketStructure, detectLiquiditySweep, detectOrderBlocks,
  computeRSI, computeMACDHist, computeOBV, computeOBVTrend, computeVolumeSpike,
  detectRSIDivergence, computeATRRegime, computeADXSlope,
  type OHLCVBar,
} from "../../_lib/mockData";

export const dynamic = "force-dynamic";

// ─── Exported types (consumed by the page) ────────────────────────────────────

export type Verdict = "Bullish" | "Bearish" | "Neutral" | "Overbought" | "Oversold";
export type IndicatorCategory = "Trend" | "Momentum" | "Flow" | "Volatility" | "Structure";

export interface Indicator {
  id:          string;
  name:        string;
  category:    IndicatorCategory;
  verdict:     Verdict;
  strength:    "Strong" | "Moderate" | "Weak";
  value:       number;
  description: string;
  source:      "db" | "computed";  // "db" = from Indicator table, "computed" = from price bars
  weight?:     number;             // Indicator importance: 3=VERY HIGH, 2=HIGH, 1.5=MEDIUM, 1=LOW
}

export interface CategoryWeights {
  Trend:      number;
  Momentum:   number;
  Flow:       number;
  Volatility: number;
  Structure:  number;
}

export interface AssetScore {
  trend:      number;
  momentum:   number;
  flow:       number;
  volatility: number;
  structure:  number;
  composite:  number;
  signal:     "Strong Bullish" | "Bullish" | "Neutral" | "Bearish" | "Strong Bearish";
  confidence: number;
  riskLevel:  "Low" | "Medium" | "High";
  weights:    CategoryWeights;   // Per-type category weights used in composite
  tickerType: string;            // CORE / DERIVATIVE / MACRO / DEFENSIVE / HIGH_BETA / DEFAULT
}

export interface AssetData {
  ticker:     string;
  name:       string;
  close:      number;
  volume:     number;
  change1d:   number;
  change5d:   number;
  change20d:  number;
  indicators: Indicator[];
  score:      AssetScore;
  hasData:    boolean;
  dbSignal:   { direction: string; strength: string; confidence: number } | null;
}

export interface AssetClassData {
  id:       string;
  name:     string;
  icon:     string;
  assets:   AssetData[];
  aggregate: {
    composite:     number;
    signal:        string;
    flowDirection: "Inflow" | "Outflow" | "Neutral";
    bullCount:     number;
    bearCount:     number;
    neutralCount:  number;
    topAsset:      string;
    bottomAsset:   string;
  };
}

export interface SignalsV2Response {
  assetClasses: AssetClassData[];
  timestamp:    string;
}

// ─── DB fetch: priceData (most recent) + stored indicators + active signal ───

interface AssetRow {
  ticker:     string;
  bars:       OHLCVBar[];
  indMap:     Record<string, number>;   // name → latest value
  dbSignal:   { direction: string; strength: string; confidence: number } | null;
}

async function fetchAllAssets(tickers: string[]): Promise<Record<string, AssetRow>> {
  const IND_NAMES = [
    "RSI_14", "MACD_HIST",
    "MOM_1D", "MOM_5D", "MOM_1M", "MOM_3M",
    "REL_STR_60D", "FLOW_SCORE",
    // Options OI — stored by Dhan pipeline (NIFTY50 + NIFTY_BANK only)
    "OPT_PCR", "OPT_CE_OI_LAKH", "OPT_PE_OI_LAKH",
    "OPT_MAX_PAIN", "OPT_RESISTANCE", "OPT_SUPPORT", "OPT_ATM_IV",
  ];

  const assets = await prisma.asset.findMany({
    where: { ticker: { in: tickers } },
    include: {
      // 260 bars — enough for full YTD Anchored VWAP (worst case ~250 trading days in Dec)
      priceData: {
        orderBy: { timestamp: "desc" },
        take: 260,
      },
      // Latest stored indicator value per name
      indicators: {
        where:   { name: { in: IND_NAMES } },
        orderBy: { timestamp: "desc" },
      },
      // Active signal from Python ingest
      signals: {
        where:   { isActive: true },
        orderBy: { triggeredAt: "desc" },
        take: 1,
      },
    },
  });

  const result: Record<string, AssetRow> = {};

  for (const a of assets) {
    // Reverse so bars are ascending chronological order
    const bars: OHLCVBar[] = [...a.priceData].reverse().map((r) => ({
      date:   r.timestamp.toISOString().slice(0, 10),
      open:   r.open,
      high:   r.high,
      low:    r.low,
      close:  r.close,
      volume: r.volume ?? 0,
    }));

    // Build indMap: latest value per indicator name
    const indMap: Record<string, number> = {};
    for (const ind of a.indicators) {
      // First occurrence (newest, since ordered desc) wins
      if (!(ind.name in indMap)) {
        indMap[ind.name] = ind.value;
      }
    }

    const sig = a.signals[0] ?? null;
    result[a.ticker] = {
      ticker:   a.ticker,
      bars,
      indMap,
      dbSignal: sig
        ? { direction: sig.direction, strength: sig.strength, confidence: sig.confidence }
        : null,
    };
  }

  return result;
}

// ─── Anchored VWAP (YTD) — computed from bars ────────────────────────────────
// Returns 0 when volume=0 (no Dhan data ingested yet); callers check useVol gate.

function anchoredVWAP(bars: OHLCVBar[]): number {
  const yearStr = `${new Date().getFullYear()}-01-01`;
  const idx     = bars.findIndex((b) => b.date >= yearStr);
  const slice   = idx >= 0 ? bars.slice(idx) : bars;
  let cumTPV = 0, cumVol = 0;
  for (const b of slice) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * b.volume;
    cumVol += b.volume;
  }
  if (cumVol === 0) return 0;  // no real volume — caller skips via useVol gate
  return cumTPV / cumVol;
}

// ─── Anchored VWAP (Weekly) — anchored to Monday of current ISO week ─────────
// Returns null when volume=0; indicator is omitted until Dhan data is present.

function anchoredVWAPWeekly(bars: OHLCVBar[]): number | null {
  const today      = new Date();
  const dow        = today.getDay() === 0 ? 7 : today.getDay(); // Mon=1 … Sun=7
  const monday     = new Date(today);
  monday.setDate(today.getDate() - (dow - 1));
  const mondayStr  = monday.toISOString().slice(0, 10);
  const idx        = bars.findIndex((b) => b.date >= mondayStr);
  const slice      = idx >= 0 ? bars.slice(idx) : [];
  if (slice.length === 0) return null;
  let cumTPV = 0, cumVol = 0;
  for (const b of slice) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * b.volume;
    cumVol += b.volume;
  }
  if (cumVol === 0) return null;
  return cumTPV / cumVol;
}

// ─── Realized vol ─────────────────────────────────────────────────────────────

function realizedVol(closes: number[], window = 20): number {
  if (closes.length < window + 1) return 15;
  const slice   = closes.slice(-window - 1);
  const rets    = slice.slice(1).map((c, i) => Math.log(c / slice[i]));
  const mean    = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance * 252) * 100;
}

// ─── Institutional Scoring Engine ────────────────────────────────────────────

// Verdict × Strength → signed score contribution.
// Strength multiplies the signal; weight (applied in catScore) scales importance.
function verdictScore(v: Verdict, s: "Strong" | "Moderate" | "Weak"): number {
  const dir = (v === "Bullish" || v === "Oversold")   ?  1
            : (v === "Bearish" || v === "Overbought") ? -1 : 0;
  return dir * (s === "Strong" ? 2 : s === "Moderate" ? 1.5 : 1);
}

// Weighted category score — indicators with higher weight dominate.
// Score is normalised 0–100 where 50 = perfectly neutral.
function catScore(indicators: Indicator[], cat: IndicatorCategory): number {
  const inds = indicators.filter((i) => i.category === cat);
  if (inds.length === 0) return 50;
  const totalW = inds.reduce((s, i) => s + (i.weight ?? 1), 0);
  const raw    = inds.reduce((s, i) => s + verdictScore(i.verdict, i.strength) * (i.weight ?? 1), 0);
  const max    = totalW * 2;   // max possible raw (all Strong Bullish at full weight)
  return Math.max(0, Math.min(100, Math.round(((raw + max) / (2 * max)) * 100)));
}

// Per-index-type category weights — replaces the flat 30/25/25/10/10 for everything.
// Based on the dynamic indicator matrix: derivative-heavy skews to Flow,
// high-beta skews to Structure/Volatility, macro-sensitive skews to Flow,
// defensive skews to Trend.
type CatWeights = { Trend: number; Momentum: number; Flow: number; Volatility: number; Structure: number };
const CATEGORY_WEIGHTS: Record<string, CatWeights> = {
  CORE:           { Trend: 0.25, Momentum: 0.20, Flow: 0.30, Volatility: 0.10, Structure: 0.15 },
  DERIVATIVE:     { Trend: 0.15, Momentum: 0.10, Flow: 0.40, Volatility: 0.10, Structure: 0.25 },
  MACRO:          { Trend: 0.20, Momentum: 0.20, Flow: 0.30, Volatility: 0.10, Structure: 0.20 },
  DEFENSIVE:      { Trend: 0.35, Momentum: 0.20, Flow: 0.15, Volatility: 0.10, Structure: 0.20 },
  HIGH_BETA:      { Trend: 0.10, Momentum: 0.15, Flow: 0.20, Volatility: 0.20, Structure: 0.35 },
  // Commodity types
  PRECIOUS_METAL: { Trend: 0.20, Momentum: 0.10, Flow: 0.40, Volatility: 0.15, Structure: 0.15 },
  ENERGY:         { Trend: 0.20, Momentum: 0.15, Flow: 0.15, Volatility: 0.30, Structure: 0.20 },
  BASE_METAL:     { Trend: 0.25, Momentum: 0.20, Flow: 0.20, Volatility: 0.15, Structure: 0.20 },
  DEFAULT:        { Trend: 0.30, Momentum: 0.25, Flow: 0.25, Volatility: 0.10, Structure: 0.10 },
};
const TICKER_TYPE: Record<string, string> = {
  NIFTY50: "CORE", NIFTY_100: "CORE", SENSEX: "CORE", FINNIFTY: "CORE",
  NIFTY_BANK:     "DERIVATIVE",
  NIFTY_SMALLCAP: "HIGH_BETA",
  // Commodities
  GOLD:        "PRECIOUS_METAL", SILVER:   "PRECIOUS_METAL",
  CRUDE_OIL:   "ENERGY",         NATURAL_GAS: "ENERGY",
  COPPER:      "BASE_METAL",     ALUMINUM: "BASE_METAL", ZINC: "BASE_METAL",
};

// Indicator importance weights per the dynamic matrix (VERY HIGH=3, HIGH=2, MEDIUM=1.5, LOW=1)
const IND_WEIGHT: Record<string, number> = {
  // VERY HIGH — primary decision drivers
  "opt-pcr":            3, "opt-oi-buildup":  3,
  "liquidity-sweep":    3, "order-blocks":    3,
  "dxy-macro":          3, "market-structure":2.5,
  // HIGH
  "vwap-20d":           2, "anchored-vwap-ytd":2, "anchored-vwap-weekly":2,
  "obv":                2, "volume-profile":  2,
  "opt-max-pain":       2, "opt-zones":       2,
  "volume-spike":       2, "yield-macro":     2,
  // MEDIUM
  "heikin-ashi":        1.5, "adx":           1.5, "rsi":           1.5,
  "momentum-1m":        1.5, "bollinger":     1.5, "opt-atm-iv":    1.5,
  "atr":                1.5, "vs-sma50":      1.5, "ma-cross":      1.5,
  // LOW
  "vs-sma200":          1, "fibonacci":       1, "support-resistance":1,
  "flow-score":         1, "rel-strength":    1, "macd":           1,
  "adx-generic":        1,
  // Commodity-specific indicators
  "real-yield-signal":  3,   // VERY HIGH — real yield is the #1 gold driver
  "gold-silver-ratio":  2.5, // HIGH — institutional positioning signal for silver
  "dxy-commodity":      2.5, // HIGH — USD is primary price driver for all commodities
  "seasonal-bias":      2,   // HIGH — NatGas seasonality is highly predictive
};

const strFn = (v: number, hi: number, mid: number): "Strong" | "Moderate" | "Weak" =>
  v > hi ? "Strong" : v > mid ? "Moderate" : "Weak";

// ─── Per-ticker indicator config ─────────────────────────────────────────────
// Only these indicator IDs are rendered for each NSE equity index.
// Tickers NOT listed fall through to the generic full-indicator path.
// Volume-dependent IDs (vwap-20d, anchored-*, volume-profile) are skipped
// automatically when hasRealVolume=false (Yahoo Finance returns 0 vol for NSE).
// DB-dependent IDs (opt-*) are skipped when Dhan data is not yet in DB.
// ─── Dynamic Indicator Matrix ─────────────────────────────────────────────────
// Per-category indicator sets based on index type/behaviour.
// IDs listed here are the only ones rendered for each NSE index (strict mode).
// Generic assets (commodities, FX) render all indicators.
// Volume-gated IDs are skipped automatically when Dhan real volume is absent.
// DB-gated IDs (opt-*) are skipped when options pipeline hasn't run yet.

const ASSET_INDICATORS: Record<string, string[]> = {
  // ── Core Indices ────────────────────────────────────────────────────────────
  NIFTY50: [
    // Trend
    "heikin-ashi", "vwap-20d", "anchored-vwap-ytd",
    // Momentum
    "adx", "rsi", "momentum-1m",
    // Flow
    "opt-pcr", "opt-oi-buildup", "obv",
    // Volatility
    "atr", "bollinger", "opt-atm-iv",
    // Structure
    "volume-profile", "market-structure", "liquidity-sweep",
    "opt-max-pain", "opt-zones",
  ],
  NIFTY_100: [
    // Trend
    "heikin-ashi", "vs-sma50", "vwap-20d", "anchored-vwap-ytd",
    // Momentum
    "adx", "rsi", "momentum-1m",
    // Flow
    "obv",
    // Volatility
    "atr", "bollinger",
    // Structure
    "market-structure",
  ],
  SENSEX: [
    // Trend
    "heikin-ashi", "vwap-20d", "anchored-vwap-ytd",
    // Momentum
    "adx", "rsi", "momentum-1m",
    // Flow
    "obv",
    // Volatility
    "atr", "bollinger",
    // Structure
    "market-structure", "liquidity-sweep",
  ],
  FINNIFTY: [
    // Trend
    "heikin-ashi", "vwap-20d", "anchored-vwap-ytd",
    // Momentum
    "adx", "rsi", "momentum-1m",
    // Flow
    "opt-pcr", "opt-oi-buildup", "obv",
    // Volatility
    "atr", "bollinger", "opt-atm-iv",
    // Structure
    "market-structure", "liquidity-sweep",
    "opt-max-pain", "opt-zones",
  ],
  // ── Derivative Heavy ────────────────────────────────────────────────────────
  NIFTY_BANK: [
    // Trend
    "heikin-ashi", "vwap-20d", "anchored-vwap-ytd", "anchored-vwap-weekly",
    // Momentum
    "adx", "momentum-1m",
    // Flow
    "opt-pcr", "opt-oi-buildup", "obv",
    // Volatility
    "atr", "opt-atm-iv",
    // Structure
    "market-structure", "liquidity-sweep", "order-blocks",
    "opt-max-pain", "opt-zones",
  ],
  // ── High Beta / Liquidity ───────────────────────────────────────────────────
  NIFTY_SMALLCAP: [
    // Structure (primary drivers)
    "market-structure", "liquidity-sweep", "order-blocks",
    // Volatility
    "atr", "bollinger",
    // Flow
    "volume-spike", "obv",
    // Trend
    "vwap-20d",
    // Momentum
    "rsi", "momentum-1m",
  ],
  // ── Commodities ─────────────────────────────────────────────────────────────
  // Precious Metals — macro + monetary drivers dominate
  GOLD: [
    "real-yield-signal",  // #1 driver: real yield inverse
    "dxy-commodity",      // USD inverse
    "vs-sma200",          // long-term structure (gold trends for years)
    "heikin-ashi",        // trend confirmation
    "bollinger",          // squeeze breakouts
    "rsi",                // divergence detection
    "market-structure",   // BOS/CHOCH
  ],
  SILVER: [
    "gold-silver-ratio",  // GSR positioning signal
    "dxy-commodity",      // USD inverse
    "heikin-ashi",        // trend
    "rsi",                // silver has violent RSI swings — divergence critical
    "bollinger",          // BB extremes frequent in silver
    "market-structure",   // structure
    "atr",                // silver = high-vol precious metal
  ],
  // Energy — volatility + structure dominate
  CRUDE_OIL: [
    "heikin-ashi",        // trend filter
    "market-structure",   // BOS/CHOCH strong in oil
    "bollinger",          // breakout zones
    "rsi",                // divergence at cycle turns
    "atr",                // vol regime (oil has violent moves)
    "momentum-1m",        // 1M return
    "dxy-commodity",      // USD inverse
  ],
  NATURAL_GAS: [
    "seasonal-bias",      // #1 driver: winter/summer demand cycle
    "bollinger",          // natgas is extremely mean-reverting at BB extremes
    "rsi",                // oscillates violently — oversold/overbought critical
    "atr",                // extreme vol asset — regime matters most
    "heikin-ashi",        // trend filter
    "market-structure",   // BOS/CHOCH
    "momentum-1m",        // short-term momentum
  ],
  // Base Metals — industrial demand + USD + trend
  COPPER: [
    "heikin-ashi",        // trend (copper trends strongly with economic cycles)
    "market-structure",   // leading economic indicator via structure breaks
    "rsi",                // divergence at cycle tops/bottoms
    "bollinger",          // breakout confirmation
    "momentum-1m",        // 1M return
    "atr",                // vol regime
    "dxy-commodity",      // USD inverse
  ],
  ALUMINUM: [
    "heikin-ashi",
    "market-structure",
    "rsi",
    "bollinger",
    "atr",
    "momentum-1m",
    "dxy-commodity",
  ],
  ZINC: [
    "heikin-ashi",
    "market-structure",
    "rsi",
    "bollinger",
    "atr",
    "momentum-1m",
    "dxy-commodity",
  ],
};

const DXY_CORRELATION: Record<string, number> = {};

// ─── Build per-asset data ─────────────────────────────────────────────────────

interface CrossAsset {
  dxyCloses:   number[];   // DXY price closes (for macro corr) — may be empty
  yieldCloses: number[];   // US10Y closes — may be empty
  goldCloses:  number[];   // Gold closes — used for Silver gold-silver-ratio signal
}

// All commodity tickers have inverse DXY correlation (priced in USD)
const COMMODITY_TICKERS = new Set(["GOLD","SILVER","CRUDE_OIL","NATURAL_GAS","COPPER","ALUMINUM","ZINC"]);

function buildAssetData(name: string, row: AssetRow, crossAsset?: CrossAsset): AssetData {
  const { ticker, bars, indMap, dbSignal } = row;

  const DEFAULT_WEIGHTS = CATEGORY_WEIGHTS[TICKER_TYPE[ticker] ?? "DEFAULT"];
  const EMPTY_SCORE: AssetScore = {
    trend: 50, momentum: 50, flow: 50, volatility: 50, structure: 50,
    composite: 50, signal: "Neutral", confidence: 0, riskLevel: "Medium",
    weights: DEFAULT_WEIGHTS, tickerType: TICKER_TYPE[ticker] ?? "DEFAULT",
  };

  if (bars.length < 22) {
    return { ticker, name, close: 0, volume: 0, change1d: 0, change5d: 0, change20d: 0,
             indicators: [], score: EMPTY_SCORE, hasData: false, dbSignal };
  }

  const closes = bars.map((b) => b.close);
  const close  = closes.at(-1)!;
  const volume = bars.at(-1)?.volume ?? 0;
  const prev1  = closes.at(-2)  ?? close;
  const prev5  = closes.at(-6)  ?? close;
  const prev20 = closes.at(-21) ?? close;

  const change1d  = ((close - prev1)  / prev1)  * 100;
  const change5d  = ((close - prev5)  / prev5)  * 100;
  const change20d = ((close - prev20) / prev20) * 100;

  // ── Per-asset config ──────────────────────────────────────────────────────
  // indConfig present  → NSE index: only render listed IDs, volume-dep blocked when 0
  // indConfig absent   → generic asset (Commodities, FX, etc.): render all indicators
  const indConfig     = ASSET_INDICATORS[ticker] ?? null;
  const strict        = indConfig !== null;
  const should        = (id: string) => !strict || indConfig!.includes(id);
  // Real volume: at least one of the last 5 bars must be non-zero (Yahoo=0 for NSE).
  // Once Dhan history is ingested, this becomes true and volume-based indicators appear.
  const hasRealVolume = bars.slice(-5).some((b) => b.volume > 0);
  const useVol        = !strict || hasRealVolume;   // generic always uses vol (incl. fallback)

  // ── Compute bar-derived values (all O(n), cheap on 260 bars) ─────────────
  const sma50    = computeSMA(closes, 50).at(-1)                          ?? close;
  const sma200   = computeSMA(closes, Math.min(200, closes.length)).at(-1) ?? close;
  const sma50Arr = computeSMA(closes, 50);
  const sma50Slope = sma50Arr.length >= 6 ? (sma50Arr.at(-1)! - sma50Arr.at(-6)!) / 5 : 0;
  const boll     = computeBollinger(closes);
  const adx      = computeADX(bars);
  const atr      = computeATR(bars);
  const vwap     = computeVWAP(bars);
  const ha       = computeHeikinAshi(bars);
  const fib      = computeFibLevels(bars);
  const sr       = computeSupportResistance(bars);
  const aVWAP    = anchoredVWAP(bars);      // 0 when no Dhan volume; gated by useVol
  const aVWAPW   = anchoredVWAPWeekly(bars);// null when no Dhan volume (NIFTY_BANK)
  const rvol     = realizedVol(closes);
  const vp       = computeVolumeProfile(bars);
  const ms       = computeMarketStructure(bars);
  const lsweep   = detectLiquiditySweep(bars);
  const ob       = detectOrderBlocks(bars);

  // ── DB indicator values ───────────────────────────────────────────────────
  const dbRSI    = indMap["RSI_14"]         ?? null;
  const dbMACD   = indMap["MACD_HIST"]      ?? null;
  const dbMom1M  = indMap["MOM_1M"]         ?? null;
  const dbFlow   = indMap["FLOW_SCORE"]     ?? null;
  const dbRelStr = indMap["REL_STR_60D"]    ?? null;
  const dbPCR    = indMap["OPT_PCR"]        ?? null;
  const dbCeOI   = indMap["OPT_CE_OI_LAKH"] ?? null;
  const dbPeOI   = indMap["OPT_PE_OI_LAKH"] ?? null;
  const dbMaxPain= indMap["OPT_MAX_PAIN"]   ?? null;
  const dbOptRes = indMap["OPT_RESISTANCE"] ?? null;
  const dbOptSup = indMap["OPT_SUPPORT"]    ?? null;
  const dbAtmIV  = indMap["OPT_ATM_IV"]    ?? null;

  // RSI and MACD computed from real price bars (Dhan data); DB value used as fallback
  const rsiArr   = computeRSI(closes);
  const rsi      = rsiArr.at(-1) ?? dbRSI ?? 50;
  const macdHist = computeMACDHist(closes) || dbMACD || 0;
  const mom1m    = dbMom1M !== null ? dbMom1M : change20d;

  // OBV: trend direction (slope) is the primary signal; absolute value is secondary context
  const obvTrend = hasRealVolume ? computeOBVTrend(bars)    :  0;  // +1 rising, -1 falling, 0 flat
  const obvVal   = hasRealVolume ? computeOBV(bars)         :  0;  // normalised -100→+100 (context)
  const volSpike = hasRealVolume ? computeVolumeSpike(bars) :  0;

  // ATR regime — is volatility expanding (risk-off) or contracting (breakout loading)?
  const atrRegime = computeATRRegime(bars);   // "expanding" | "contracting" | "normal"

  // ADX slope — is the trend strengthening or exhausting?
  const adxRawSlope = computeADXSlope(bars);  // positive = rising ADX, negative = falling

  // RSI divergence — most powerful RSI signal; overrides simple level reading
  const rsiDivergence = detectRSIDivergence(closes, rsiArr);

  // Cross-asset macro context (DXY + US10Y yield)
  const dxyCloses   = crossAsset?.dxyCloses   ?? [];
  const yieldCloses = crossAsset?.yieldCloses ?? [];
  // 20-bar change for macro direction reading
  const dxyChange20d   = dxyCloses.length >= 21
    ? ((dxyCloses.at(-1)! - dxyCloses.at(-21)!) / (dxyCloses.at(-21)! || 1)) * 100
    : 0;
  const yieldChange20d = yieldCloses.length >= 21
    ? yieldCloses.at(-1)! - yieldCloses.at(-21)!   // absolute bps-like change
    : 0;
  // Sector-specific DXY impact direction (+1 = DXY up is bullish, -1 = bearish)
  const dxyCorr = DXY_CORRELATION[ticker] ?? -1;

  const indicators: Indicator[] = [];

  // ══ TREND ════════════════════════════════════════════════════════════════

  if (should("ma-cross")) {
    const maDiff  = Math.abs(sma50 - sma200) / (sma200 || 1);
    const crossV: Verdict = sma50 > sma200 ? "Bullish" : "Bearish";
    indicators.push({
      id: "ma-cross", name: "MA Cross 50/200", category: "Trend", source: "computed",
      verdict: crossV,
      strength: maDiff > 0.04 ? "Strong" : maDiff > 0.02 ? "Moderate" : "Weak",
      value: parseFloat(((sma50 / (sma200 || 1) - 1) * 100).toFixed(2)),
      description: `SMA50 ${sma50.toFixed(0)} vs SMA200 ${sma200.toFixed(0)} (${maDiff > 0 ? "+" : ""}${(maDiff * 100).toFixed(1)}%) — ${sma50 > sma200 ? "Golden Cross: long-term bull structure" : "Death Cross: long-term bear structure"}`,
      weight: IND_WEIGHT["ma-cross"],
    });
  }

  if (should("vs-sma50")) {
    const sma50Pct = ((close / (sma50 || 1) - 1) * 100);
    // Slope context: is 50DMA itself rising or falling?
    const smaDir = sma50Slope > 0.2 ? "rising" : sma50Slope < -0.2 ? "falling" : "flat";
    indicators.push({
      id: "vs-sma50", name: "Moving Average (50 DMA)", category: "Trend", source: "computed",
      verdict: close > sma50 ? "Bullish" : "Bearish",
      strength: strFn(Math.abs(sma50Pct), 3, 1),
      value: parseFloat(sma50Pct.toFixed(2)),
      description: `${sma50Pct > 0 ? "+" : ""}${sma50Pct.toFixed(1)}% vs 50 DMA (${sma50.toFixed(0)}, ${smaDir}) — ${close > sma50 ? "price above dynamic support" : "price below dynamic resistance"}`,
      weight: IND_WEIGHT["vs-sma50"],
    });
  }

  if (should("vs-sma200")) {
    const sma200Pct = ((close / (sma200 || 1) - 1) * 100);
    indicators.push({
      id: "vs-sma200", name: "Price vs 200 DMA", category: "Trend", source: "computed",
      verdict: close > sma200 ? "Bullish" : "Bearish",
      strength: strFn(Math.abs(sma200Pct), 5, 2),
      value: parseFloat(sma200Pct.toFixed(2)),
      description: `${sma200Pct > 0 ? "+" : ""}${sma200Pct.toFixed(1)}% vs 200 DMA (${sma200.toFixed(0)}) — ${close > sma200 ? "structural bull: long-term buyers in profit" : "structural bear: long-term buyers under water"}`,
      weight: IND_WEIGHT["vs-sma200"],
    });
  }

  if (should("heikin-ashi")) {
    // Confirm HA signal with ADX: trending market gives more weight
    const haStrength: "Strong" | "Moderate" | "Weak" =
      ha !== "neutral" && adx > 30 ? "Strong"
      : ha !== "neutral"           ? "Moderate"
      : "Weak";
    const haDesc = ha === "bullish"
      ? `HA bullish ${adx > 25 ? "+ ADX " + adx.toFixed(0) + " confirms trend" : "— ADX weak, monitor"}`
      : ha === "bearish"
      ? `HA bearish ${adx > 25 ? "+ ADX " + adx.toFixed(0) + " confirms downtrend" : "— ADX weak, could reverse"}`
      : "HA indecision — no clear directional bias";
    indicators.push({
      id: "heikin-ashi", name: "Heikin Ashi Trend", category: "Trend", source: "computed",
      verdict: ha === "bullish" ? "Bullish" : ha === "bearish" ? "Bearish" : "Neutral",
      strength: haStrength,
      value: ha === "bullish" ? 1 : ha === "bearish" ? -1 : 0,
      description: haDesc,
      weight: IND_WEIGHT["heikin-ashi"],
    });
  }

  if (should("adx")) {
    // Direction from price vs SMA50; strength from ADX value; context from slope
    const adxDir: Verdict = adx > 25 ? (sma50Slope > 0 ? "Bullish" : "Bearish") : "Neutral";
    const slopeLabel = adxRawSlope > 0 ? "rising ↑ (trend strengthening)"
                     : adxRawSlope < 0 ? "falling ↓ (trend exhausting)"
                     : "flat";
    indicators.push({
      id: "adx", name: "ADX (14)", category: "Trend", source: "computed",
      verdict: adxDir,
      strength: adx > 35 ? "Strong" : adx > 25 ? "Moderate" : "Weak",
      value: parseFloat(adx.toFixed(1)),
      description: `ADX ${adx.toFixed(1)} ${slopeLabel} — ${adx > 40 ? "powerful trend" : adx > 25 ? `confirmed ${sma50Slope > 0 ? "uptrend" : "downtrend"}` : "ranging market, no trend"}`,
      weight: IND_WEIGHT["adx"],
    });
  }

  // ══ MOMENTUM (generic path only — NSE indices use bar/structure indicators) ═

  if (should("rsi")) {
    // Divergence overrides the simple level verdict — much stronger signal
    let rsiV: Verdict = rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold"
      : rsi > 55 ? "Bullish" : rsi < 45 ? "Bearish" : "Neutral";
    let rsiStrength: "Strong" | "Moderate" | "Weak" =
      (rsi > 70 || rsi < 30) ? "Strong" : Math.abs(rsi - 50) > 10 ? "Moderate" : "Weak";
    let rsiDesc = `RSI ${rsi.toFixed(1)} — ${rsiV}`;

    if (rsiDivergence === "bullish") {
      rsiV       = "Bullish";
      rsiStrength= "Strong";
      rsiDesc    = `RSI ${rsi.toFixed(1)} — bullish divergence (price lower low, RSI higher low) → reversal signal`;
    } else if (rsiDivergence === "bearish") {
      rsiV       = "Bearish";
      rsiStrength= "Strong";
      rsiDesc    = `RSI ${rsi.toFixed(1)} — bearish divergence (price higher high, RSI lower high) → exhaustion signal`;
    } else if (rsi > 30 && rsi < 50 && close > prev5) {
      rsiDesc    = `RSI ${rsi.toFixed(1)} — recovering from oversold, ${rsiV}`;
    } else if (rsi > 50 && rsi < 70) {
      rsiDesc    = `RSI ${rsi.toFixed(1)} — momentum zone (50–70), trend intact`;
    }

    indicators.push({
      id: "rsi", name: "RSI (14)", category: "Momentum",
      source: dbRSI !== null ? "db" : "computed",
      verdict: rsiV, strength: rsiStrength,
      value: parseFloat(rsi.toFixed(1)),
      description: rsiDesc,
      weight: IND_WEIGHT["rsi"],
    });
  }

  if (should("macd")) {
    const macdV: Verdict = macdHist > 0 ? "Bullish" : macdHist < 0 ? "Bearish" : "Neutral";
    const macdCtx = macdHist > 0
      ? `positive histogram — bullish momentum${Math.abs(macdHist) > close * 0.005 ? " (strong)" : ""}`
      : macdHist < 0
      ? `negative histogram — bearish momentum${Math.abs(macdHist) > close * 0.005 ? " (strong)" : ""}`
      : "histogram at zero — no momentum bias";
    indicators.push({
      id: "macd", name: "MACD Histogram", category: "Momentum",
      source: dbMACD !== null ? "db" : "computed",
      verdict: macdV,
      strength: Math.abs(macdHist) > (close * 0.005) ? "Strong" : Math.abs(macdHist) > (close * 0.002) ? "Moderate" : "Weak",
      value: parseFloat(macdHist.toFixed(2)),
      description: `Hist ${macdHist > 0 ? "+" : ""}${macdHist.toFixed(2)} — ${macdCtx}`,
      weight: IND_WEIGHT["macd"],
    });
  }

  if (should("momentum-1m")) {
    const momV: Verdict = mom1m > 3 ? "Bullish" : mom1m < -3 ? "Bearish" : "Neutral";
    const mom5d   = change5d;
    const momAlign = (mom1m > 0 && mom5d > 0) ? " (5D confirms)" : (mom1m < 0 && mom5d < 0) ? " (5D confirms)" : " (5D diverging)";
    indicators.push({
      id: "momentum-1m", name: "1M Return", category: "Momentum",
      source: dbMom1M !== null ? "db" : "computed",
      verdict: momV,
      strength: strFn(Math.abs(mom1m), 8, 3),
      value: parseFloat(mom1m.toFixed(2)),
      description: `${mom1m > 0 ? "+" : ""}${mom1m.toFixed(1)}% 1M · ${mom5d > 0 ? "+" : ""}${mom5d.toFixed(1)}% 5D${momAlign}`,
      weight: IND_WEIGHT["momentum-1m"],
    });
  }

  // ══ FLOW ═════════════════════════════════════════════════════════════════

  // VWAP 20D — skipped in strict mode when Dhan data not yet ingested (volume=0)
  if (should("vwap-20d") && useVol) {
    const vwapV: Verdict  = close > vwap ? "Bullish" : "Bearish";
    const vwapPct = ((close - vwap) / (vwap || 1)) * 100;
    indicators.push({
      id: "vwap-20d", name: "VWAP (20D)", category: "Flow", source: "computed",
      verdict: vwapV,
      strength: strFn(Math.abs(close - vwap) / (vwap || 1), 0.015, 0.006),
      value: parseFloat(vwap.toFixed(2)),
      description: `${vwapPct > 0 ? "+" : ""}${vwapPct.toFixed(1)}% vs 20D VWAP (${vwap.toFixed(0)}) — ${close > vwap ? "avg participant profitable (institutional support)" : "avg participant underwater (resistance zone)"}`,
      weight: IND_WEIGHT["vwap-20d"],
    });
  }

  // Anchored VWAP YTD — strict mode: requires real volume; generic: always shown
  if (should("anchored-vwap-ytd") && (aVWAP > 0 || !strict)) {
    const avwap   = aVWAP > 0 ? aVWAP : anchoredVWAP(bars);
    const aVWAPV: Verdict = close > avwap ? "Bullish" : "Bearish";
    const avwapPct = ((close - avwap) / (avwap || 1)) * 100;
    indicators.push({
      id: "anchored-vwap", name: "Anchored VWAP (YTD)", category: "Flow", source: "computed",
      verdict: aVWAPV,
      strength: strFn(Math.abs(close - avwap) / (avwap || 1), 0.02, 0.01),
      value: parseFloat(avwap.toFixed(2)),
      description: `${avwapPct > 0 ? "+" : ""}${avwapPct.toFixed(1)}% vs YTD AVWAP (${avwap.toFixed(0)}) — ${close > avwap ? "all YTD buyers profitable: strong institutional floor" : "avg YTD buyer underwater: overhead supply"}`,
      weight: IND_WEIGHT["anchored-vwap-ytd"],
    });
  }

  // Anchored VWAP Weekly — NIFTY_BANK only; requires real volume (null = skip)
  if (should("anchored-vwap-weekly") && aVWAPW !== null) {
    const awV: Verdict = close > aVWAPW ? "Bullish" : "Bearish";
    indicators.push({
      id: "anchored-vwap-weekly", name: "Anchored VWAP (Weekly)", category: "Flow", source: "computed",
      verdict: awV,
      strength: strFn(Math.abs(close - aVWAPW) / (aVWAPW || 1), 0.01, 0.004),
      value: parseFloat(aVWAPW.toFixed(2)),
      description: `Weekly AVWAP ${aVWAPW.toFixed(0)} (Mon anchor) — ${awV === "Bullish" ? "dealer/institutional net long this week" : "dealer/institutional net short — selling pressure"}`,
      weight: IND_WEIGHT["anchored-vwap-weekly"],
    });
  }

  if (should("flow-score") && dbFlow !== null) {
    const flowV: Verdict = dbFlow > 60 ? "Bullish" : dbFlow < 40 ? "Bearish" : "Neutral";
    indicators.push({
      id: "flow-score", name: "Flow Score", category: "Flow", source: "db",
      verdict: flowV,
      strength: strFn(Math.abs(dbFlow - 50), 20, 10),
      value: parseFloat(dbFlow.toFixed(1)),
      description: `Flow score ${dbFlow.toFixed(1)}/100 — ${flowV === "Bullish" ? "capital inflow momentum" : flowV === "Bearish" ? "capital outflow pressure" : "balanced flows"}`,
      weight: IND_WEIGHT["flow-score"],
    });
  }

  if (should("rel-strength") && dbRelStr !== null) {
    const rsV: Verdict = dbRelStr > 1.02 ? "Bullish" : dbRelStr < 0.98 ? "Bearish" : "Neutral";
    indicators.push({
      id: "rel-strength", name: "Relative Strength (60D)", category: "Flow", source: "db",
      verdict: rsV,
      strength: strFn(Math.abs(dbRelStr - 1), 0.05, 0.02),
      value: parseFloat(dbRelStr.toFixed(4)),
      description: `60D rel strength ${dbRelStr.toFixed(3)} vs benchmark — ${dbRelStr > 1 ? "outperforming" : "underperforming"}`,
      weight: IND_WEIGHT["rel-strength"],
    });
  }

  // Options PCR — primary derivative market positioning signal (VERY HIGH weight)
  if (should("opt-pcr") && dbPCR !== null) {
    const pcrV: Verdict = dbPCR > 1.2 ? "Bullish" : dbPCR < 0.8 ? "Bearish" : "Neutral";
    const pcrContext = dbPCR > 1.5 ? "extreme put writing — institutions very bullish"
      : dbPCR > 1.2 ? "put writing dominant → upside expected"
      : dbPCR < 0.6 ? "extreme call writing — institutions very bearish"
      : dbPCR < 0.8 ? "call writing dominant → resistance overhead"
      : "balanced CE/PE OI — no clear directional bias";
    indicators.push({
      id: "opt-pcr", name: "Options PCR", category: "Flow", source: "db",
      verdict: pcrV,
      strength: (dbPCR > 1.5 || dbPCR < 0.6) ? "Strong" : (dbPCR > 1.2 || dbPCR < 0.8) ? "Moderate" : "Weak",
      value: parseFloat(dbPCR.toFixed(3)),
      description: `PCR ${dbPCR.toFixed(3)} — ${pcrContext}`,
      weight: IND_WEIGHT["opt-pcr"],
    });
  }

  if (should("opt-oi-buildup") && dbCeOI !== null && dbPeOI !== null) {
    const totalOI = dbCeOI + dbPeOI;
    const peBias  = totalOI > 0 ? dbPeOI / totalOI : 0.5;
    const oiV: Verdict = peBias > 0.55 ? "Bullish" : peBias < 0.45 ? "Bearish" : "Neutral";
    indicators.push({
      id: "opt-oi-buildup", name: "OI Build-up", category: "Flow", source: "db",
      verdict: oiV,
      strength: Math.abs(peBias - 0.5) > 0.15 ? "Strong" : Math.abs(peBias - 0.5) > 0.1 ? "Moderate" : "Weak",
      value: parseFloat(totalOI.toFixed(1)),
      description: `CE OI ${dbCeOI.toFixed(1)}L · PE OI ${dbPeOI.toFixed(1)}L (${(peBias * 100).toFixed(0)}% PE) — ${oiV === "Bullish" ? "put writers dominant: upside bias" : oiV === "Bearish" ? "call writers capping upside" : "balanced build-up"}`,
      weight: IND_WEIGHT["opt-oi-buildup"],
    });
  }

  // OBV — trend direction (slope) is the institutional signal; absolute value gives context
  if (should("obv") && useVol) {
    const obvV: Verdict = obvTrend > 0 ? "Bullish" : obvTrend < 0 ? "Bearish" : "Neutral";
    // Strengthen when OBV slope and price direction agree; note divergence when they split
    const priceTrend = change20d > 1 ? "up" : change20d < -1 ? "down" : "flat";
    const obvDivergence = (obvTrend > 0 && priceTrend === "down") ? " — OBV/price divergence: accumulation under selling"
      : (obvTrend < 0 && priceTrend === "up")                    ? " — OBV/price divergence: distribution under buying"
      : "";
    indicators.push({
      id: "obv", name: "OBV (Accumulation)", category: "Flow", source: "computed",
      verdict: obvV,
      strength: obvDivergence ? "Strong" : (obvTrend !== 0 ? "Moderate" : "Weak"),
      value: parseFloat(obvVal.toFixed(1)),
      description: `OBV ${obvTrend > 0 ? "rising ↑" : obvTrend < 0 ? "falling ↓" : "flat"} (net ${obvVal > 0 ? "+" : ""}${obvVal.toFixed(0)})${obvDivergence || (obvTrend > 0 ? " — smart money accumulating" : obvTrend < 0 ? " — distribution in progress" : " — neutral volume flow")}`,
      weight: IND_WEIGHT["obv"],
    });
  }

  // Volume Spike — breakout participation; very high weight for high-beta indices
  if (should("volume-spike") && useVol) {
    const vsV: Verdict = volSpike > 50 ? "Bullish" : volSpike < -30 ? "Bearish" : "Neutral";
    indicators.push({
      id: "volume-spike", name: "Volume Spike", category: "Flow", source: "computed",
      verdict: vsV,
      strength: Math.abs(volSpike) > 100 ? "Strong" : Math.abs(volSpike) > 50 ? "Moderate" : "Weak",
      value: parseFloat(volSpike.toFixed(1)),
      description: `Volume ${volSpike > 0 ? "+" : ""}${volSpike.toFixed(0)}% vs 20D avg — ${vsV === "Bullish" ? "strong participation: institutional breakout signal" : vsV === "Bearish" ? "volume drying up: lack of conviction" : "normal activity — no breakout"}`,
      weight: IND_WEIGHT["volume-spike"],
    });
  }

  // DXY Macro — USD strength impact, adjusted for sector correlation direction
  if (should("dxy-macro") && dxyCloses.length >= 21) {
    const dxyImpact = dxyChange20d * dxyCorr;
    const dxyV: Verdict = dxyImpact > 1.5 ? "Bullish" : dxyImpact < -1.5 ? "Bearish" : "Neutral";
    const dxyContext = dxyCorr > 0
      ? (dxyChange20d > 0 ? "USD ↑ → USD revenues higher: positive for earnings" : "USD ↓ → earnings headwind")
      : (dxyChange20d > 0 ? "USD ↑ → commodity prices lower: margin pressure" : "USD ↓ → commodity prices higher: tailwind");
    indicators.push({
      id: "dxy-macro", name: "DXY Macro Impact", category: "Flow", source: "computed",
      verdict: dxyV,
      strength: Math.abs(dxyChange20d) > 3 ? "Strong" : Math.abs(dxyChange20d) > 1.5 ? "Moderate" : "Weak",
      value: parseFloat(dxyChange20d.toFixed(2)),
      description: `DXY ${dxyChange20d > 0 ? "+" : ""}${dxyChange20d.toFixed(1)}% (20D at ${dxyCloses.at(-1)?.toFixed(1)}) — ${dxyContext}`,
      weight: IND_WEIGHT["dxy-macro"],
    });
  }

  // Yield Macro — rising US10Y = FII outflows from EM India (inverse relationship)
  if (should("yield-macro") && yieldCloses.length >= 21) {
    const yieldCurrent = yieldCloses.at(-1) ?? 0;
    const yieldV: Verdict = yieldChange20d > 0.15 ? "Bearish" : yieldChange20d < -0.15 ? "Bullish" : "Neutral";
    const yieldContext = yieldV === "Bearish"
      ? `rising yields (${yieldCurrent.toFixed(2)}%) → FII selling EM equities, INR pressure`
      : yieldV === "Bullish"
      ? `falling yields (${yieldCurrent.toFixed(2)}%) → FII flows into EM India`
      : `stable yields (${yieldCurrent.toFixed(2)}%) — FII positioning neutral`;
    indicators.push({
      id: "yield-macro", name: "US10Y Yield Signal", category: "Flow", source: "computed",
      verdict: yieldV,
      strength: Math.abs(yieldChange20d) > 0.3 ? "Strong" : Math.abs(yieldChange20d) > 0.15 ? "Moderate" : "Weak",
      value: parseFloat(yieldCurrent.toFixed(2)),
      description: `${yieldChange20d > 0 ? "+" : ""}${yieldChange20d.toFixed(2)}% 20D change — ${yieldContext}`,
      weight: IND_WEIGHT["yield-macro"],
    });
  }

  // ── Commodity-specific cross-asset signals ─────────────────────────────────

  // DXY Commodity — all commodities priced in USD, inverse DXY correlation
  if (should("dxy-commodity") && dxyCloses.length >= 21) {
    // All commodities = -1 DXY correlation (USD up → commodity prices down)
    const dxyImpact = -dxyChange20d;
    const dxyV: Verdict = dxyImpact > 1.5 ? "Bullish" : dxyImpact < -1.5 ? "Bearish" : "Neutral";
    const dxyCtx = dxyChange20d > 0
      ? `USD ↑ ${dxyChange20d.toFixed(1)}% → commodity headwind (stronger dollar = lower USD-priced commodities)`
      : `USD ↓ ${Math.abs(dxyChange20d).toFixed(1)}% → commodity tailwind (weaker dollar = higher prices)`;
    indicators.push({
      id: "dxy-commodity", name: "DXY Dollar Impact", category: "Flow", source: "computed",
      verdict: dxyV,
      strength: Math.abs(dxyChange20d) > 3 ? "Strong" : Math.abs(dxyChange20d) > 1.5 ? "Moderate" : "Weak",
      value: parseFloat(dxyChange20d.toFixed(2)),
      description: `DXY ${dxyChange20d > 0 ? "+" : ""}${dxyChange20d.toFixed(1)}% (20D) — ${dxyCtx}`,
      weight: IND_WEIGHT["dxy-commodity"],
    });
  }

  // Real Yield Signal — US10Y level as gold/silver primary driver
  // Low/negative real yields = bullish precious metals; high real yields = bearish
  if (should("real-yield-signal") && yieldCloses.length >= 5) {
    const yieldNow = yieldCloses.at(-1) ?? 0;
    // Real yield proxy: nominal US10Y. Below 2% = negative real rates zone (bullish gold)
    // Above 4.5% = restrictive real rates (bearish gold). 2-4.5% = neutral zone.
    const ryV: Verdict = yieldNow < 2.0 ? "Bullish"
      : yieldNow < 3.5 ? "Neutral"
      : yieldNow < 4.5 ? "Bearish"
      : "Bearish";
    const ryStr: "Strong" | "Moderate" | "Weak" = yieldNow < 1.5 || yieldNow > 5 ? "Strong"
      : yieldNow < 2.0 || yieldNow > 4.5 ? "Moderate" : "Weak";
    const ryCtx = yieldNow < 2.0
      ? `US10Y ${yieldNow.toFixed(2)}% — near-zero/negative real rates: strong tailwind for gold`
      : yieldNow < 3.5
      ? `US10Y ${yieldNow.toFixed(2)}% — moderate rates: gold neutral; inflation expectations key`
      : yieldNow < 4.5
      ? `US10Y ${yieldNow.toFixed(2)}% — elevated rates: opportunity cost of holding gold rises`
      : `US10Y ${yieldNow.toFixed(2)}% — restrictive real rates: significant headwind for gold`;
    indicators.push({
      id: "real-yield-signal", name: "Real Yield Signal (US10Y)", category: "Flow", source: "computed",
      verdict: ryV,
      strength: ryStr,
      value: parseFloat(yieldNow.toFixed(2)),
      description: ryCtx,
      weight: IND_WEIGHT["real-yield-signal"],
    });
  }

  // Gold-Silver Ratio — institutional positioning signal for silver
  // GSR > 85: silver historically cheap → mean-reversion bullish for silver
  // GSR < 70: silver expensive vs gold → mean-reversion bearish for silver
  if (should("gold-silver-ratio")) {
    const goldCloses = crossAsset?.goldCloses ?? [];
    const goldNow    = goldCloses.at(-1) ?? 0;
    if (goldNow > 0 && close > 0) {
      const gsr = goldNow / close;
      const gsrV: Verdict = gsr > 85 ? "Bullish"   // silver cheap — buy the ratio compression
        : gsr < 70 ? "Bearish"                       // silver stretched — reversion risk
        : gsr > 80 ? "Neutral" : "Neutral";
      const gsrStr: "Strong" | "Moderate" | "Weak" =
        gsr > 90 || gsr < 65 ? "Strong" : gsr > 85 || gsr < 70 ? "Moderate" : "Weak";
      const gsrCtx = gsr > 85
        ? `GSR ${gsr.toFixed(1)} — silver historically cheap vs gold; mean-reversion rally likely`
        : gsr < 70
        ? `GSR ${gsr.toFixed(1)} — silver stretched vs gold; historically rich, underperformance risk`
        : `GSR ${gsr.toFixed(1)} — gold/silver ratio in normal range (70–85); no extreme positioning`;
      indicators.push({
        id: "gold-silver-ratio", name: "Gold/Silver Ratio", category: "Flow", source: "computed",
        verdict: gsrV,
        strength: gsrStr,
        value: parseFloat(gsr.toFixed(1)),
        description: gsrCtx,
        weight: IND_WEIGHT["gold-silver-ratio"],
      });
    }
  }

  // Seasonal Bias — NatGas calendar seasonality (strongest predictive factor)
  // Q4/Q1 (Oct–Feb): winter heating demand → bullish
  // Q2 (Apr–May): shoulder season, storage builds → bearish
  // Q3 (Jun–Sep): mild seasonal with hurricane risk → neutral/slightly bullish
  if (should("seasonal-bias")) {
    const month = new Date().getMonth() + 1; // 1=Jan … 12=Dec
    let sbV: Verdict;
    let sbStr: "Strong" | "Moderate" | "Weak";
    let sbCtx: string;
    if (month >= 11 || month <= 2) {
      sbV   = "Bullish"; sbStr = "Strong";
      sbCtx = `Peak winter demand (month ${month}) — heating season drives structural NatGas demand; historically strongest seasonal period`;
    } else if (month >= 3 && month <= 5) {
      sbV   = "Bearish"; sbStr = "Strong";
      sbCtx = `Shoulder season (month ${month}) — heating demand collapses, storage injections begin; seasonally weakest period for NatGas`;
    } else if (month >= 6 && month <= 8) {
      sbV   = "Neutral"; sbStr = "Moderate";
      sbCtx = `Summer cooling demand (month ${month}) — power gen provides floor; hurricane risk in Gulf can spike prices unpredictably`;
    } else {
      sbV   = "Bullish"; sbStr = "Moderate";
      sbCtx = `Pre-winter setup (month ${month}) — storage draws begin, market positions for heating season; seasonally turning bullish`;
    }
    indicators.push({
      id: "seasonal-bias", name: "Seasonal Pattern", category: "Flow", source: "computed",
      verdict: sbV,
      strength: sbStr,
      value: month,
      description: sbCtx,
      weight: IND_WEIGHT["seasonal-bias"],
    });
  }

  // ══ VOLATILITY ════════════════════════════════════════════════════════════

  if (should("atr")) {
    const atrPct = atr / (close || 1);
    // Regime context makes ATR far more actionable than just the raw value
    const atrRegimeLabel = atrRegime === "expanding"   ? "expanding ↑ (institutional risk-off)"
                         : atrRegime === "contracting" ? "contracting ↓ (breakout loading)"
                         : "normal range";
    const atrVerdict: Verdict = atrRegime === "expanding" ? "Bearish"
      : atrRegime === "contracting" ? "Neutral"   // squeeze is neutral until direction breaks
      : atrPct > 0.015 ? "Bearish" : atrPct < 0.008 ? "Bullish" : "Neutral";
    indicators.push({
      id: "atr", name: "ATR% (14)", category: "Volatility", source: "computed",
      verdict: atrVerdict,
      strength: atrRegime !== "normal" ? "Strong" : atrPct > 0.02 ? "Moderate" : "Weak",
      value: parseFloat((atrPct * 100).toFixed(2)),
      description: `Daily range ${(atrPct * 100).toFixed(2)}% — ${atrRegimeLabel}${atrRegime === "contracting" ? " · watch for directional break" : ""}`,
      weight: IND_WEIGHT["atr"],
    });
  }

  if (should("bollinger")) {
    const bollPos   = (boll.upper - boll.lower) > 0
      ? (close - boll.lower) / (boll.upper - boll.lower) : 0.5;
    const bbWidth   = ((boll.upper - boll.lower) / (boll.middle || 1)) * 100;
    const bollV: Verdict = close > boll.upper ? "Overbought" : close < boll.lower ? "Oversold" : "Neutral";
    // Middle band as dynamic support/resistance for inside-band price
    const midBandCtx = bollV === "Neutral"
      ? (close > boll.middle ? " · above mid-band (bullish bias)" : " · below mid-band (bearish bias)")
      : "";
    indicators.push({
      id: "bollinger", name: "Bollinger Bands", category: "Volatility", source: "computed",
      verdict: bollV,
      strength: boll.squeeze ? "Strong" : bollV !== "Neutral" ? "Moderate" : "Weak",
      value: parseFloat((bollPos * 100).toFixed(1)),
      description: boll.squeeze
        ? `Squeeze (BW ${bbWidth.toFixed(1)}%) — coiled spring: high-conviction breakout imminent · ${close > boll.middle ? "above mid: bull bias" : "below mid: bear bias"}`
        : `%B ${(bollPos * 100).toFixed(0)}% (BW ${bbWidth.toFixed(1)}%) — ${bollV.toLowerCase()}${midBandCtx}`,
      weight: IND_WEIGHT["bollinger"],
    });
  }

  if (should("opt-atm-iv") && dbAtmIV !== null && dbAtmIV > 0) {
    const ivV: Verdict = dbAtmIV > 20 ? "Bearish" : dbAtmIV < 12 ? "Bullish" : "Neutral";
    const ivContext = dbAtmIV > 30 ? "fear spike — potential capitulation zone"
      : dbAtmIV > 20 ? "elevated uncertainty — institutions hedging"
      : dbAtmIV < 10 ? "extreme complacency — reversal risk"
      : dbAtmIV < 12 ? "low IV → calm market, cheap option premium"
      : "normal IV regime";
    indicators.push({
      id: "opt-atm-iv", name: "ATM Implied Volatility", category: "Volatility", source: "db",
      verdict: ivV,
      strength: dbAtmIV > 28 || dbAtmIV < 10 ? "Strong" : dbAtmIV > 20 ? "Moderate" : "Weak",
      value: parseFloat(dbAtmIV.toFixed(1)),
      description: `ATM IV ${dbAtmIV.toFixed(1)}% — ${ivContext}`,
      weight: IND_WEIGHT["opt-atm-iv"],
    });
  }

  // ══ STRUCTURE ════════════════════════════════════════════════════════════

  if (should("support-resistance")) {
    const srRange = (sr.resistance - sr.support) || 1;
    const srPos   = (close - sr.support) / srRange;
    const distToRes = ((sr.resistance - close) / (close || 1)) * 100;
    const distToSup = ((close - sr.support)    / (close || 1)) * 100;
    indicators.push({
      id: "support-resistance", name: "Support / Resistance", category: "Structure", source: "computed",
      verdict: srPos > 0.65 ? "Bullish" : srPos < 0.35 ? "Bearish" : "Neutral",
      strength: (srPos > 0.80 || srPos < 0.20) ? "Strong" : "Moderate",
      value: parseFloat((srPos * 100).toFixed(1)),
      description: `S: ${sr.support.toFixed(0)} (${distToSup.toFixed(1)}% below) · R: ${sr.resistance.toFixed(0)} (${distToRes.toFixed(1)}% above) — price at ${(srPos * 100).toFixed(0)}% of range`,
      weight: IND_WEIGHT["support-resistance"],
    });
  }

  if (should("fibonacci")) {
    const fibV: Verdict = close > fib.level618 ? "Bullish" : close > fib.level382 ? "Neutral" : "Bearish";
    const fibContext = close > fib.level618 ? "above 61.8% retracement: strong recovery, target prior high"
      : close > fib.level382 ? "between 38.2–61.8%: consolidation zone"
      : "below 38.2%: deep correction territory";
    indicators.push({
      id: "fibonacci", name: "Fibonacci Level", category: "Structure", source: "computed",
      verdict: fibV, strength: "Moderate",
      value: parseFloat(fib.level618.toFixed(0)),
      description: `Fib 61.8%: ${fib.level618.toFixed(0)} · 38.2%: ${fib.level382.toFixed(0)} — ${fibContext}`,
      weight: IND_WEIGHT["fibonacci"],
    });
  }

  // Volume Profile — strict mode: requires Dhan volume; generic: always
  if (should("volume-profile") && useVol) {
    const vpVerdict: Verdict = close > vp.poc ? "Bullish" : close < vp.poc ? "Bearish" : "Neutral";
    const inVA   = close >= vp.val && close <= vp.vah;
    const pocPct = ((close - vp.poc) / (vp.poc || 1)) * 100;
    indicators.push({
      id: "volume-profile", name: "Volume Profile (POC)", category: "Structure", source: "computed",
      verdict: vpVerdict,
      strength: Math.abs(pocPct) > 2 ? "Strong" : "Moderate",
      value: parseFloat(vp.poc.toFixed(2)),
      description: `POC ${vp.poc.toFixed(0)} (${pocPct > 0 ? "+" : ""}${pocPct.toFixed(1)}%) · VAH ${vp.vah.toFixed(0)} · VAL ${vp.val.toFixed(0)} — ${inVA ? "inside value area: fair value" : close > vp.vah ? "above value area: premium price, institutional supply zone" : "below value area: discount, potential accumulation zone"}`,
      weight: IND_WEIGHT["volume-profile"],
    });
  }

  if (should("market-structure")) {
    const msVerdict: Verdict = ms.structure === "bullish" ? "Bullish"
      : ms.structure === "bearish" ? "Bearish" : "Neutral";
    const msLabel = ms.lastEvent === "BOS_UP"    ? "BOS ↑ — bullish continuation confirmed"
      : ms.lastEvent === "BOS_DOWN"  ? "BOS ↓ — bearish continuation confirmed"
      : ms.lastEvent === "CHOCH_UP"  ? "CHOCH ↑ — trend reversal signal (high conviction)"
      : ms.lastEvent === "CHOCH_DOWN"? "CHOCH ↓ — trend reversal signal (high conviction)"
      : "structure intact, no recent break";
    indicators.push({
      id: "market-structure", name: "Market Structure (BOS/CHOCH)", category: "Structure", source: "computed",
      verdict: msVerdict,
      strength: ms.lastEvent !== "none"
        ? (ms.lastEvent.startsWith("CHOCH") ? "Strong" : "Moderate")
        : "Weak",
      value: ms.swingHigh,
      description: `${ms.structure.toUpperCase()} structure | ${msLabel} | SH ${ms.swingHigh.toFixed(0)} · SL ${ms.swingLow.toFixed(0)}`,
      weight: IND_WEIGHT["market-structure"],
    });
  }

  if (should("liquidity-sweep")) {
    const sweepV: Verdict = lsweep.swept === "bullish" ? "Bullish"
      : lsweep.swept === "bearish" ? "Bearish" : "Neutral";
    const sweepContext = lsweep.swept === "bullish"
      ? `Bullish sweep at ${lsweep.level.toFixed(0)} (${lsweep.barsAgo}d ago) — stops cleared below, spring setup`
      : lsweep.swept === "bearish"
      ? `Bearish sweep at ${lsweep.level.toFixed(0)} (${lsweep.barsAgo}d ago) — stops hunted above, trap setup`
      : "No liquidity sweep — no institutional stop-hunt detected";
    indicators.push({
      id: "liquidity-sweep", name: "Liquidity Sweep", category: "Structure", source: "computed",
      verdict: sweepV,
      strength: lsweep.swept !== "none" ? (lsweep.barsAgo <= 1 ? "Strong" : "Moderate") : "Weak",
      value: lsweep.level,
      description: sweepContext,
      weight: IND_WEIGHT["liquidity-sweep"],
    });
  }

  if (should("order-blocks")) {
    const obVerdict: Verdict = ob.inDemandZone ? "Bullish" : ob.inSupplyZone ? "Bearish" : "Neutral";
    const obDesc = ob.inDemandZone
      ? `In demand OB ${ob.demandLow.toFixed(0)}–${ob.demandHigh.toFixed(0)} — institutional buy zone: high R:R long opportunity`
      : ob.inSupplyZone
      ? `In supply OB ${ob.supplyLow.toFixed(0)}–${ob.supplyHigh.toFixed(0)} — institutional sell zone: resistance expected`
      : ob.demandLow > 0 || ob.supplyLow > 0
      ? `Nearest demand ${ob.demandLow > 0 ? ob.demandLow.toFixed(0) : "—"} · supply ${ob.supplyLow > 0 ? ob.supplyLow.toFixed(0) : "—"} — price between zones`
      : "No institutional order blocks identified in range";
    indicators.push({
      id: "order-blocks", name: "Order Blocks", category: "Structure", source: "computed",
      verdict: obVerdict,
      strength: (ob.inDemandZone || ob.inSupplyZone) ? "Strong" : "Weak",
      value: ob.inDemandZone ? ob.demandLow : ob.inSupplyZone ? ob.supplyHigh : 0,
      description: obDesc,
      weight: IND_WEIGHT["order-blocks"],
    });
  }

  if (should("opt-max-pain") && dbMaxPain !== null) {
    const mpDiff  = ((close - dbMaxPain) / (dbMaxPain || 1)) * 100;
    const mpV: Verdict = Math.abs(mpDiff) < 1 ? "Neutral" : mpDiff > 0 ? "Bearish" : "Bullish";
    const mpCtx = Math.abs(mpDiff) < 1
      ? "at max pain — expiry magnet: limited directional move expected"
      : mpDiff > 3  ? "far above max pain — dealer hedging creates sell pressure"
      : mpDiff < -3 ? "far below max pain — dealer hedging creates buy support"
      : mpDiff > 0  ? "above max pain — gravity pulling toward " + dbMaxPain.toFixed(0)
      : "below max pain — gravity pulling toward " + dbMaxPain.toFixed(0);
    indicators.push({
      id: "opt-max-pain", name: "Max Pain", category: "Structure", source: "db",
      verdict: mpV,
      strength: Math.abs(mpDiff) > 3 ? "Strong" : Math.abs(mpDiff) > 1 ? "Moderate" : "Weak",
      value: parseFloat(dbMaxPain.toFixed(0)),
      description: `Max pain ${dbMaxPain.toFixed(0)} (price ${mpDiff > 0 ? "+" : ""}${mpDiff.toFixed(1)}%) — ${mpCtx}`,
      weight: IND_WEIGHT["opt-max-pain"],
    });
  }

  if (should("opt-zones") && dbOptRes !== null && dbOptSup !== null) {
    const isNearRes  = Math.abs(close - dbOptRes) / (dbOptRes || 1) < 0.015;
    const isNearSup  = Math.abs(close - dbOptSup) / (dbOptSup || 1) < 0.015;
    const distRes    = ((dbOptRes - close) / (close || 1) * 100).toFixed(1);
    const distSup    = ((close - dbOptSup) / (close || 1) * 100).toFixed(1);
    const ozV: Verdict = isNearRes ? "Bearish" : isNearSup ? "Bullish"
      : close > (dbOptRes + dbOptSup) / 2 ? "Bullish" : "Bearish";
    indicators.push({
      id: "opt-zones", name: "Options S/R Zones", category: "Structure", source: "db",
      verdict: ozV,
      strength: (isNearRes || isNearSup) ? "Strong" : "Moderate",
      value: dbOptRes,
      description: `CE wall (resistance) ${dbOptRes.toFixed(0)} (+${distRes}%) · PE wall (support) ${dbOptSup.toFixed(0)} (-${distSup}%)${isNearRes ? " — AT resistance: call writers will defend" : isNearSup ? " — AT support: put writers will defend" : ""}`,
      weight: IND_WEIGHT["opt-zones"],
    });
  }

  // ── Institutional-grade weighted scoring ─────────────────────────────────
  const trendScore      = catScore(indicators, "Trend");
  const momentumScore   = catScore(indicators, "Momentum");
  const flowScore       = catScore(indicators, "Flow");
  const volatilityScore = catScore(indicators, "Volatility");
  const structureScore  = catScore(indicators, "Structure");

  // Per-index-type category weights (replaces flat 30/25/25/10/10 for all)
  const wts = CATEGORY_WEIGHTS[TICKER_TYPE[ticker] ?? "DEFAULT"];
  const composite = Math.max(0, Math.min(100, Math.round(
    trendScore      * wts.Trend      +
    momentumScore   * wts.Momentum   +
    flowScore       * wts.Flow       +
    volatilityScore * wts.Volatility +
    structureScore  * wts.Structure
  )));

  const signal: AssetScore["signal"] =
    composite >= 70 ? "Strong Bullish" :
    composite >= 57 ? "Bullish"        :
    composite >= 43 ? "Neutral"        :
    composite >= 30 ? "Bearish"        :
    "Strong Bearish";

  // Confidence: weighted by indicator strength (Strong=3, Moderate=2, Weak=1)
  // so a few high-conviction indicators agreeing counts more than many weak ones
  const isBull  = composite >= 50;
  const dirInds = indicators.filter((i) => i.verdict !== "Neutral");
  const strengthW = (s: "Strong" | "Moderate" | "Weak") => s === "Strong" ? 3 : s === "Moderate" ? 2 : 1;
  const totalDirW = dirInds.reduce((s, i) => s + strengthW(i.strength), 0);
  const agreeW    = dirInds
    .filter((i) => isBull
      ? (i.verdict === "Bullish" || i.verdict === "Oversold")
      : (i.verdict === "Bearish" || i.verdict === "Overbought"))
    .reduce((s, i) => s + strengthW(i.strength), 0);
  const confidence = totalDirW > 0 ? Math.round((agreeW / totalDirW) * 100) : 50;

  // Risk level: multi-factor (realised vol + ATR regime + structure)
  const structureRisk = ms.lastEvent.startsWith("CHOCH") ? 1 : 0;  // reversal = +risk
  const atrRisk       = atrRegime === "expanding" ? 1 : atrRegime === "contracting" ? 0 : 0;
  const riskScore     = (rvol > 22 ? 2 : rvol > 14 ? 1 : 0) + atrRisk + structureRisk;
  const riskLevel: AssetScore["riskLevel"] = riskScore >= 3 ? "High" : riskScore >= 1 ? "Medium" : "Low";

  return {
    ticker, name, close, volume, change1d, change5d, change20d,
    indicators, hasData: indicators.length > 0, dbSignal,
    score: { trend: trendScore, momentum: momentumScore, flow: flowScore,
             volatility: volatilityScore, structure: structureScore,
             composite, signal, confidence, riskLevel,
             weights: wts, tickerType: TICKER_TYPE[ticker] ?? "DEFAULT" },
  };
}

// ─── Aggregate asset class ────────────────────────────────────────────────────

function aggregateClass(assets: AssetData[]): AssetClassData["aggregate"] {
  const active = assets.filter((a) => a.hasData);
  if (active.length === 0) {
    return { composite: 50, signal: "Neutral", flowDirection: "Neutral",
             bullCount: 0, bearCount: 0, neutralCount: 0, topAsset: "—", bottomAsset: "—" };
  }
  const composite = Math.round(active.reduce((s, a) => s + a.score.composite, 0) / active.length);
  const signal =
    composite >= 72 ? "Strong Bullish" : composite >= 58 ? "Bullish"  :
    composite >= 42 ? "Neutral"        : composite >= 28 ? "Bearish"  : "Strong Bearish";
  const flowDirection: "Inflow" | "Outflow" | "Neutral" =
    composite > 55 ? "Inflow" : composite < 45 ? "Outflow" : "Neutral";
  const bullCount    = active.filter((a) => a.score.composite >= 58).length;
  const bearCount    = active.filter((a) => a.score.composite < 42).length;
  const neutralCount = active.length - bullCount - bearCount;
  const sorted = [...active].sort((a, b) => b.score.composite - a.score.composite);
  return { composite, signal, flowDirection, bullCount, bearCount, neutralCount,
           topAsset: sorted[0]?.name ?? "—", bottomAsset: sorted.at(-1)?.name ?? "—" };
}

// ─── Asset class definitions ──────────────────────────────────────────────────

const CLASS_DEFS = [
  {
    id: "indian-equities", name: "Indian Equities", icon: "🇮🇳",
    assets: [
      // Core
      { ticker: "NIFTY50",       name: "Nifty 50"         },
      { ticker: "NIFTY_100",     name: "Nifty 100"        },
      { ticker: "SENSEX",        name: "BSE Sensex"       },
      { ticker: "FINNIFTY",      name: "Fin Nifty"        },
      // Derivative Heavy
      { ticker: "NIFTY_BANK",    name: "Nifty Bank"       },
      // Macro Sensitive
      { ticker: "NIFTY_SMALLCAP", name: "Nifty Smallcap 100" },
    ],
  },
  {
    id: "commodities", name: "Commodities", icon: "🛢️",
    assets: [
      // Precious metals
      { ticker: "GOLD",        name: "Gold"        },
      { ticker: "SILVER",      name: "Silver"      },
      // Energy
      { ticker: "CRUDE_OIL",   name: "Crude Oil"   },
      { ticker: "NATURAL_GAS", name: "Natural Gas" },
      // Base metals
      { ticker: "COPPER",      name: "Copper"      },
      { ticker: "ALUMINUM",    name: "Aluminum"    },
      { ticker: "ZINC",        name: "Zinc"        },
    ],
  },
  {
    id: "currency", name: "Currency", icon: "💱",
    assets: [
      { ticker: "USDINR", name: "USD / INR"          },
      { ticker: "DXY",    name: "DXY Dollar Index"   },
    ],
  },
  {
    id: "us-market", name: "US Market", icon: "🇺🇸",
    assets: [
      { ticker: "SPX", name: "S&P 500" },
    ],
  },
  {
    id: "fixed-income", name: "Fixed Income", icon: "📊",
    assets: [
      { ticker: "US10Y", name: "US 10Y Treasury" },
      { ticker: "US2Y",  name: "US 2Y Treasury"  },
    ],
  },
];

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // Fetch all asset tickers + DXY and US10Y for cross-asset macro context
    const allTickers    = CLASS_DEFS.flatMap((c) => c.assets.map((a) => a.ticker));
    const macroTickers  = ["DXY", "US10Y"];
    const fetchTickers  = [...new Set([...allTickers, ...macroTickers])];
    const assetRows     = await fetchAllAssets(fetchTickers);

    // Extract cross-asset bars for macro-sensitive indicators
    const dxyCloses   = (assetRows["DXY"]?.bars   ?? []).map((b) => b.close);
    const yieldCloses = (assetRows["US10Y"]?.bars  ?? []).map((b) => b.close);
    const goldCloses  = (assetRows["GOLD"]?.bars   ?? []).map((b) => b.close);
    const crossAsset: CrossAsset = { dxyCloses, yieldCloses, goldCloses };

    // Commodities need DXY + yield context (and gold gets goldCloses for silver ratio)
    const COMMODITY_SET = COMMODITY_TICKERS;

    const assetClasses: AssetClassData[] = CLASS_DEFS.map((cls) => {
      const assets = cls.assets.map(({ ticker, name }) => {
        const row = assetRows[ticker];
        if (!row) {
          return {
            ticker, name, close: 0, volume: 0, change1d: 0, change5d: 0, change20d: 0,
            indicators: [], hasData: false, dbSignal: null,
            score: { trend: 50, momentum: 50, flow: 50, volatility: 50, structure: 50,
                     composite: 50, signal: "Neutral" as const, confidence: 0, riskLevel: "Medium" as const,
                     weights: CATEGORY_WEIGHTS[TICKER_TYPE[ticker] ?? "DEFAULT"],
                     tickerType: TICKER_TYPE[ticker] ?? "DEFAULT" },
          };
        }
        // Macro indices and all commodities receive cross-asset context
        const needsCrossAsset = COMMODITY_SET.has(ticker);
        return buildAssetData(name, row, needsCrossAsset ? crossAsset : undefined);
      });
      return { id: cls.id, name: cls.name, icon: cls.icon, assets, aggregate: aggregateClass(assets) };
    });

    return NextResponse.json({ assetClasses, timestamp: new Date().toISOString() } satisfies SignalsV2Response);
  } catch (err) {
    console.error("[GET /api/signals/v2]", err);
    return NextResponse.json({ error: "Failed to compute signals" }, { status: 500 });
  }
}
