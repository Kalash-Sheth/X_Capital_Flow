// GET /api/signals
// Returns live signals computed from real NeonDB price data.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  computeRSI,
  computeMACD,
  computeSMA,
  computeBollinger,
  computeADX,
  computeOBV,
  computeATR,
  computeVWAP,
  computeHeikinAshi,
  computeFibLevels,
  computeSupportResistance,
  type OHLCVBar,
} from "../_lib/mockData";

export const dynamic = "force-dynamic";

type Verdict  = "Bullish" | "Bearish" | "Neutral" | "Overbought" | "Oversold";
type Strength = "Strong" | "Moderate" | "Weak";

export interface SignalDetail {
  formula:        string;
  computation:    string;
  affectedAssets: string[];
  interpretation: string;
  timeframe:      string;
  thresholds?:    { label: string; value: string }[];
}

interface Signal {
  id:          string;
  category:    string;
  name:        string;
  value:       number | string;
  verdict:     Verdict | string;
  strength:    Strength;
  description: string;
  asset:       string;
  timestamp:   string;
  detail:      SignalDetail;
}

function sig(confidence: number): Strength {
  if (confidence >= 0.65) return "Strong";
  if (confidence >= 0.40) return "Moderate";
  return "Weak";
}

// ─── Batch fetch all tickers ──────────────────────────────────────────────────
async function fetchAllBars(tickers: string[], days = 200): Promise<Record<string, OHLCVBar[]>> {
  const assets = await prisma.asset.findMany({
    where: { ticker: { in: tickers } },
    include: { priceData: { orderBy: { timestamp: "asc" }, take: days } },
  });
  const result: Record<string, OHLCVBar[]> = {};
  for (const asset of assets) {
    result[asset.ticker] = asset.priceData.map((r) => ({
      date:   r.timestamp.toISOString().slice(0, 10),
      open:   r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0,
    }));
  }
  return result;
}

// ─── Math helpers ─────────────────────────────────────────────────────────────
function realizedVol(closes: number[], window = 20): number {
  if (closes.length < window + 1) return 15;
  const slice   = closes.slice(-window - 1);
  const returns = slice.slice(1).map((c, i) => Math.log(c / slice[i]));
  const mean    = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return parseFloat((Math.sqrt(variance * 252) * 100).toFixed(2));
}

function toWeeklyCloses(bars: OHLCVBar[]): number[] {
  const weeks: Record<string, number> = {};
  for (const b of bars) {
    const d = new Date(b.date);
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;
    const mon = new Date(d);
    mon.setDate(d.getDate() - dow);
    const wk = mon.toISOString().split("T")[0];
    weeks[wk] = b.close;
  }
  return Object.keys(weeks).sort().map((k) => weeks[k]);
}

function volumeSpike(bars: OHLCVBar[]): number {
  if (bars.length < 21) return 1;
  const recent = bars.slice(-21);
  const avg20  = recent.slice(0, 20).reduce((s, b) => s + b.volume, 0) / 20;
  const last   = recent.at(-1)?.volume ?? 0;
  return avg20 > 0 ? parseFloat((last / avg20).toFixed(2)) : 1;
}

function sectorBreadth(barsMap: Record<string, OHLCVBar[]>, sectors: string[], period: number): number {
  let above = 0, count = 0;
  for (const ticker of sectors) {
    const bars = barsMap[ticker] ?? [];
    if (bars.length < period + 1) continue;
    const closes = bars.map((b) => b.close);
    const smaArr = computeSMA(closes, period);
    const sma    = smaArr.at(-1) ?? 0;
    if ((closes.at(-1) ?? 0) > sma) above++;
    count++;
  }
  return count > 0 ? Math.round((above / count) * 100) : 50;
}

function sectorAD(barsMap: Record<string, OHLCVBar[]>, sectors: string[]): number {
  let advances = 0, declines = 0;
  for (const ticker of sectors) {
    const closes = (barsMap[ticker] ?? []).map((b) => b.close);
    if (closes.length < 2) continue;
    if ((closes.at(-1) ?? 0) > (closes.at(-2) ?? 0)) advances++;
    else declines++;
  }
  const total = advances + declines;
  return total > 0 ? parseFloat(((advances / total) * 100).toFixed(1)) : 50;
}

function anchoredVWAP(bars: OHLCVBar[]): number {
  const year    = new Date().getFullYear();
  const yearStr = `${year}-01-01`;
  const idx     = bars.findIndex((b) => b.date >= yearStr);
  const slice   = idx >= 0 ? bars.slice(idx) : bars;
  let cumTPV = 0, cumVol = 0;
  for (const b of slice) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV  += tp * b.volume;
    cumVol  += b.volume;
  }
  // Indices have zero volume from Yahoo; fall back to arithmetic mean of typical price
  if (cumVol === 0) {
    const tpSum = slice.reduce((s, b) => s + (b.high + b.low + b.close) / 3, 0);
    return slice.length === 0 ? 0 : parseFloat((tpSum / slice.length).toFixed(2));
  }
  return parseFloat((cumTPV / cumVol).toFixed(2));
}

// ─── GET handler ──────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const today = new Date().toISOString().split("T")[0];

    const TICKERS = [
      "NIFTY50", "NIFTY_BANK", "NIFTY_IT", "NIFTY_PHARMA",
      "SMALLCAP", "GOLD", "CRUDE_OIL", "SPX",
      "US10Y", "US2Y", "COPPER", "USDINR", "DXY",
    ];
    const SECTORS = ["NIFTY50", "NIFTY_BANK", "NIFTY_IT", "NIFTY_PHARMA", "SMALLCAP", "SPX"];

    const barsMap = await fetchAllBars(TICKERS, 200);
    const lastClose = (t: string) => (barsMap[t] ?? []).at(-1)?.close ?? 0;

    function buildInd(ticker: string) {
      const bars = barsMap[ticker] ?? [];
      if (bars.length < 2) return null;
      const closes  = bars.map((b) => b.close);
      const sma20a  = computeSMA(closes, 20);
      const sma50a  = computeSMA(closes, 50);
      const sma200a = computeSMA(closes, Math.min(200, closes.length));
      return {
        bars, closes,
        rsi:      computeRSI(closes).at(-1) ?? 50,
        macd:     computeMACD(closes),
        sma20:    sma20a.at(-1)  ?? closes.at(-1)!,
        sma50:    sma50a.at(-1)  ?? closes.at(-1)!,
        sma200:   sma200a.at(-1) ?? closes.at(-1)!,
        boll:     computeBollinger(closes),
        adx:      computeADX(bars),
        obv:      computeOBV(bars),
        atr:      computeATR(bars),
        vwap:     computeVWAP(bars),
        ha:       computeHeikinAshi(bars),
        fib:      computeFibLevels(bars),
        sr:       computeSupportResistance(bars),
        volSpike: volumeSpike(bars),
        close:    closes.at(-1)!,
      };
    }

    const n      = buildInd("NIFTY50");
    const bank   = buildInd("NIFTY_BANK");
    const it     = buildInd("NIFTY_IT");
    const pharma = buildInd("NIFTY_PHARMA");
    const sc     = buildInd("SMALLCAP");
    const gold   = buildInd("GOLD");
    const crude  = buildInd("CRUDE_OIL");
    const dxy    = buildInd("DXY");

    if (!n || !gold) {
      return NextResponse.json({ error: "Insufficient price data. Run ingest first." }, { status: 404 });
    }

    const yield10y    = lastClose("US10Y");
    const yield2y     = lastClose("US2Y");
    const yieldSpread = parseFloat((yield10y - yield2y).toFixed(4));
    const CPI_ESTIMATE = 4.2;
    const realYield   = parseFloat((yield10y - CPI_ESTIMATE).toFixed(4));

    const rs = {
      goldNifty:        gold.close && n.close ? parseFloat((gold.close / n.close * 100).toFixed(4)) : 0,
      niftyUS10Y:       n.close && yield10y   ? parseFloat((n.close / (yield10y * 1000)).toFixed(4)) : 0,
      smallcapLargecap: lastClose("SMALLCAP") && n.close
        ? parseFloat((lastClose("SMALLCAP") / n.close).toFixed(4)) : 0,
      niftySPX:    n.close && lastClose("SPX")    ? parseFloat((n.close / lastClose("SPX")).toFixed(4)) : 0,
      copperGold:  lastClose("COPPER") && gold.close
        ? parseFloat((lastClose("COPPER") / gold.close).toFixed(4)) : 0,
    };

    const vixProxy    = realizedVol(n.closes, 20);
    const weeklyRSI   = computeRSI(toWeeklyCloses(barsMap["NIFTY50"] ?? [])).at(-1) ?? 50;
    const aVWAP       = anchoredVWAP(n.bars);
    const breadth50   = sectorBreadth(barsMap, SECTORS, 50);
    const breadth200  = sectorBreadth(barsMap, SECTORS, 200);
    const sectorADPct = sectorAD(barsMap, SECTORS);

    const usdinrCloses = (barsMap["USDINR"] ?? []).map((b) => b.close);
    const usdinrLast   = usdinrCloses.at(-1) ?? 84.5;
    const usdinr5dAgo  = usdinrCloses.at(-6) ?? usdinrLast;
    const usdinr5dChg  = parseFloat(((usdinrLast - usdinr5dAgo) / usdinr5dAgo * 100).toFixed(3));

    const isRiskOff = n.rsi < 45 && vixProxy > 18;
    const isRiskOn  = n.rsi > 55 && yieldSpread > 0.2 && vixProxy < 18 && n.sma50 > n.sma200;
    const regimeType = isRiskOff ? "Risk-Off" : isRiskOn ? "Risk-On" : "Neutral";
    const yieldRegime = yieldSpread < -0.1 ? "Inverted" : yieldSpread < 0.3 ? "Flat" : "Normal";

    // ── Composite scores: fully live-data inline (no mock data) ──────────────
    const goldMom20d    = (barsMap["GOLD"] ?? []).map((b) => b.close);
    const goldRet20     = goldMom20d.length >= 21 ? (goldMom20d.at(-1)! / goldMom20d.at(-21)! - 1) * 100 : 0;
    const niftyRet20    = n.closes.length >= 21   ? (n.close / n.closes.at(-21)! - 1) * 100             : 0;
    const momSpread     = Math.abs(goldRet20 - niftyRet20);
    const rotationScore = Math.min(100, Math.round(
      momSpread * 3 +
      (vixProxy > 20 ? 25 : vixProxy > 15 ? 15 : 5) +
      (Math.abs(yieldSpread) < 0.1 ? 20 : 10) +
      (Math.abs(usdinr5dChg) > 0.5 ? 20 : 10)
    ));
    const riskPressure = Math.min(100, Math.round(
      (vixProxy / 30) * 35 +
      (n.rsi < 40 ? 20 : n.rsi > 70 ? 10 : 5) +
      (Math.abs(n.macd.histogram) / (n.close * 0.005) > 1 ? 15 : 5) +
      (n.adx > 25 ? 10 : 5) +
      (yieldSpread < 0 ? 15 : yieldSpread < 0.2 ? 8 : 0)
    ));
    const healthScore = Math.min(100, Math.round(
      (n.rsi > 40 && n.rsi < 65 ? 25 : 10) +
      (n.sma50 > n.sma200 ? 20 : 0) +
      (n.adx < 30 ? 15 : 5) +
      (vixProxy < 18 ? 20 : vixProxy < 22 ? 10 : 0) +
      (rs.smallcapLargecap > 0.6 ? 20 : 10)
    ));
    const comp = { rotationScore, riskPressure, healthScore };

    const signals: Signal[] = [

      // ══════════════════════════════════════════════════════════════
      // MOMENTUM
      // ══════════════════════════════════════════════════════════════
      {
        id: "rsi-nifty-daily",
        category: "Momentum", name: "RSI (14) Daily — Nifty 50",
        value: n.rsi,
        verdict: n.rsi > 70 ? "Overbought" : n.rsi < 30 ? "Oversold" : "Neutral",
        strength: sig(Math.abs(n.rsi - 50) / 50),
        description: n.rsi > 65
          ? `RSI at ${n.rsi.toFixed(1)} approaching overbought. Watch for pullback.`
          : n.rsi < 35
          ? `RSI at ${n.rsi.toFixed(1)} in oversold zone — contrarian buy signal.`
          : `RSI at ${n.rsi.toFixed(1)} in neutral zone.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "RSI = 100 − 100 / (1 + RS)   |   RS = AvgGain(14) / AvgLoss(14)",
          computation: "Compares average up-closes vs down-closes over 14 daily bars using Wilder's smoothed EMA. Ranges 0–100.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Above 70 → overbought, mean-reversion risk. Below 30 → oversold, bounce potential. 45–55 → neutral zone.",
          timeframe: "Daily",
          thresholds: [{ label: "Overbought", value: "> 70" }, { label: "Neutral", value: "45–55" }, { label: "Oversold", value: "< 30" }],
        },
      },
      {
        id: "rsi-nifty-weekly",
        category: "Momentum", name: "RSI (14) Weekly — Nifty 50",
        value: weeklyRSI,
        verdict: weeklyRSI > 70 ? "Overbought" : weeklyRSI < 30 ? "Oversold" : "Neutral",
        strength: sig(Math.abs(weeklyRSI - 50) / 50),
        description: `Weekly RSI at ${weeklyRSI.toFixed(1)}. ${weeklyRSI > 60 ? "Long-term momentum still constructive." : weeklyRSI < 40 ? "Weekly momentum turning bearish — structural weakness." : "Weekly momentum neutral."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Same as daily RSI but applied to weekly close prices (last close of each calendar week)",
          computation: "Daily bars are aggregated to weekly by taking the Friday (last trading day) close. RSI(14) is then computed on the weekly series.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Weekly RSI filters out daily noise. Below 40 = structural bear trend. Above 60 = structural bull trend. More reliable than daily for medium-term trend.",
          timeframe: "Weekly",
          thresholds: [{ label: "Bull trend", value: "> 60" }, { label: "Neutral", value: "40–60" }, { label: "Bear trend", value: "< 40" }],
        },
      },
      {
        id: "rsi-bank",
        category: "Momentum", name: "RSI (14) — Nifty Bank",
        value: bank?.rsi ?? 50,
        verdict: (bank?.rsi ?? 50) > 70 ? "Overbought" : (bank?.rsi ?? 50) < 30 ? "Oversold" : "Neutral",
        strength: sig(Math.abs((bank?.rsi ?? 50) - 50) / 50),
        description: `Nifty Bank RSI at ${(bank?.rsi ?? 50).toFixed(1)}. Banking sector momentum ${(bank?.rsi ?? 50) > 55 ? "positive" : (bank?.rsi ?? 50) < 45 ? "weakening" : "neutral"}.`,
        asset: "NIFTY_BANK", timestamp: today,
        detail: {
          formula: "RSI(14) computed on daily Nifty Bank index closes",
          computation: "Wilder RSI on 14 daily closes of Nifty Bank index. Banks are rate-sensitive — RSI divergence from Nifty 50 signals sector rotation.",
          affectedAssets: ["NIFTY_BANK", "NIFTY50"],
          interpretation: "Banking sector RSI divergence from Nifty often precedes broad market reversals. Bank RSI < Nifty RSI = sector underperformance signal.",
          timeframe: "Daily",
          thresholds: [{ label: "Overbought", value: "> 70" }, { label: "Neutral", value: "45–55" }, { label: "Oversold", value: "< 30" }],
        },
      },
      {
        id: "rsi-gold",
        category: "Momentum", name: "RSI (14) — Gold",
        value: gold.rsi,
        verdict: gold.rsi > 65 ? "Bullish" : gold.rsi < 40 ? "Bearish" : "Neutral",
        strength: sig(Math.abs(gold.rsi - 50) / 50),
        description: `Gold RSI at ${gold.rsi.toFixed(1)}. ${gold.rsi > 60 ? "Safe-haven demand driving gold higher." : "Gold consolidating."}`,
        asset: "GOLD", timestamp: today,
        detail: {
          formula: "RSI(14) on daily gold (MCX/USD) closing prices",
          computation: "Gold RSI above 60 while equity RSI is below 50 signals risk-off regime and active safe-haven rotation.",
          affectedAssets: ["GOLD", "NIFTY50"],
          interpretation: "Gold RSI > 60 + Nifty RSI < 45 = risk-off rotation active. Gold RSI < 40 = gold losing momentum, risk-on possible.",
          timeframe: "Daily",
          thresholds: [{ label: "Bullish (safe-haven demand)", value: "> 65" }, { label: "Neutral", value: "45–60" }, { label: "Bearish", value: "< 40" }],
        },
      },
      {
        id: "rsi-pharma",
        category: "Momentum", name: "RSI (14) — Nifty Pharma",
        value: pharma?.rsi ?? 50,
        verdict: (pharma?.rsi ?? 50) > 65 ? "Bullish" : (pharma?.rsi ?? 50) < 35 ? "Bearish" : "Neutral",
        strength: Math.abs((pharma?.rsi ?? 50) - 50) > 15 ? "Strong" : "Moderate",
        description: `Pharma RSI at ${(pharma?.rsi ?? 50).toFixed(1)}. ${(pharma?.rsi ?? 50) > 60 ? "Defensive rotation boosting pharma." : "Pharma momentum neutral."}`,
        asset: "NIFTY_PHARMA", timestamp: today,
        detail: {
          formula: "RSI(14) on daily Nifty Pharma index closes",
          computation: "Pharma is a defensive sector — elevated RSI during market stress signals flight to defensives.",
          affectedAssets: ["NIFTY_PHARMA"],
          interpretation: "Pharma RSI rising while Nifty RSI falls = defensive rotation. Confirms risk-off regime signal.",
          timeframe: "Daily",
          thresholds: [{ label: "Defensive rotation active", value: "> 60" }, { label: "Neutral", value: "40–60" }, { label: "Underperforming", value: "< 35" }],
        },
      },
      {
        id: "macd-nifty",
        category: "Momentum", name: "MACD — Nifty 50",
        value: n.macd.histogram,
        verdict: n.macd.histogram > 0 ? "Bullish" : "Bearish",
        strength: sig(Math.min(1, Math.abs(n.macd.histogram) / (n.close * 0.005))),
        description: `MACD ${n.macd.macd.toFixed(1)}, Signal ${n.macd.signal.toFixed(1)}, Histogram ${n.macd.histogram.toFixed(1)}. ${n.macd.histogram > 0 ? "Bullish momentum building." : "Bearish momentum present."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "MACD = EMA(12) − EMA(26)   |   Signal = EMA(MACD, 9)   |   Histogram = MACD − Signal",
          computation: "Exponential moving average crossover system. Histogram measures the spread between MACD and its signal line — positive = upward acceleration.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Histogram crossing zero from below = buy signal. Zero cross from above = sell. Histogram shrinking while price rising = weakening momentum (bearish divergence).",
          timeframe: "Daily",
          thresholds: [{ label: "Bullish momentum", value: "Histogram > 0" }, { label: "Bearish momentum", value: "Histogram < 0" }, { label: "Momentum shift", value: "Zero crossover" }],
        },
      },
      {
        id: "macd-it",
        category: "Momentum", name: "MACD — Nifty IT",
        value: it?.macd.histogram ?? 0,
        verdict: (it?.macd.histogram ?? 0) > 0 ? "Bullish" : "Bearish",
        strength: sig(Math.min(1, Math.abs(it?.macd.histogram ?? 0) / ((it?.close ?? 1) * 0.005))),
        description: `IT sector MACD histogram ${(it?.macd.histogram ?? 0).toFixed(1)}. ${(it?.macd.histogram ?? 0) > 0 ? "IT outperformance likely to continue." : "IT losing momentum."}`,
        asset: "NIFTY_IT", timestamp: today,
        detail: {
          formula: "MACD(12,26,9) on Nifty IT daily closes",
          computation: "Nifty IT tracks global tech sentiment and USD/INR. IT MACD divergence from Nifty 50 MACD indicates sector-specific flows vs broad market.",
          affectedAssets: ["NIFTY_IT", "USDINR"],
          interpretation: "IT MACD positive while Nifty MACD negative = IT acting as market leader. IT USD-revenue exposure makes it sensitive to USDINR moves.",
          timeframe: "Daily",
          thresholds: [{ label: "Bullish", value: "Histogram > 0" }, { label: "Bearish", value: "Histogram < 0" }],
        },
      },
      {
        id: "macd-bank",
        category: "Momentum", name: "MACD — Nifty Bank",
        value: bank?.macd.histogram ?? 0,
        verdict: (bank?.macd.histogram ?? 0) > 0 ? "Bullish" : "Bearish",
        strength: sig(Math.min(1, Math.abs(bank?.macd.histogram ?? 0) / ((bank?.close ?? 1) * 0.005))),
        description: `Nifty Bank MACD histogram ${(bank?.macd.histogram ?? 0).toFixed(1)}. ${(bank?.macd.histogram ?? 0) > 0 ? "Banking sector momentum positive." : "Bank sector selling pressure."}`,
        asset: "NIFTY_BANK", timestamp: today,
        detail: {
          formula: "MACD(12,26,9) on Nifty Bank daily closes",
          computation: "Banks have highest weightage in Nifty 50. Bank MACD is a leading indicator for broad market direction. Rate cut expectations drive bank MACD positively.",
          affectedAssets: ["NIFTY_BANK", "NIFTY50"],
          interpretation: "Bank MACD leads Nifty MACD by 1–2 sessions. A bank MACD bull cross before Nifty MACD cross confirms the breakout.",
          timeframe: "Daily",
          thresholds: [{ label: "Bullish", value: "Histogram > 0" }, { label: "Bearish", value: "Histogram < 0" }],
        },
      },

      // ══════════════════════════════════════════════════════════════
      // TREND
      // ══════════════════════════════════════════════════════════════
      {
        id: "ma-cross-nifty",
        category: "Trend", name: "MA Crossover 50/200 — Nifty 50",
        value: parseFloat((n.sma50 - n.sma200).toFixed(2)),
        verdict: n.sma50 > n.sma200 ? "Bullish" : "Bearish",
        strength: n.sma50 > n.sma200 * 1.02 || n.sma50 < n.sma200 * 0.98 ? "Strong" : "Moderate",
        description: n.sma50 > n.sma200
          ? `Golden Cross: SMA50 (${n.sma50.toFixed(0)}) above SMA200 (${n.sma200.toFixed(0)}). Long-term uptrend intact.`
          : `Death Cross: SMA50 (${n.sma50.toFixed(0)}) below SMA200 (${n.sma200.toFixed(0)}). Long-term downtrend.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Golden Cross: SMA(50) > SMA(200)   |   Death Cross: SMA(50) < SMA(200)",
          computation: "50-day and 200-day simple moving averages of Nifty 50 daily closes. Their relative position defines the long-term trend regime.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Golden Cross (50>200) = confirmed long-term bull trend. Death Cross = structural bear. The spread (50−200) shows trend strength: wider = more entrenched.",
          timeframe: "Daily",
          thresholds: [{ label: "Strong Bull (Golden Cross)", value: "SMA50 > SMA200 by >2%" }, { label: "Weak Bull", value: "SMA50 > SMA200" }, { label: "Bear (Death Cross)", value: "SMA50 < SMA200" }],
        },
      },
      {
        id: "price-vs-sma20",
        category: "Trend", name: "Price vs 20 DMA — Nifty 50",
        value: parseFloat(((n.close / n.sma20 - 1) * 100).toFixed(2)),
        verdict: n.close > n.sma20 ? "Bullish" : "Bearish",
        strength: Math.abs(n.close - n.sma20) / n.sma20 > 0.02 ? "Strong" : "Moderate",
        description: `Price ${n.close > n.sma20 ? "above" : "below"} 20 DMA (${n.sma20.toFixed(0)}). Short-term trend ${n.close > n.sma20 ? "bullish" : "bearish"}.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "% from 20DMA = (Price − SMA20) / SMA20 × 100",
          computation: "20-day simple moving average used as dynamic short-term support/resistance. Deviation % shows how extended price is from recent mean.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Price > 20DMA = short-term uptrend. Price > 20DMA by >3% = overextended, mean-reversion risk. Price < 20DMA for 3+ days = short-term bear.",
          timeframe: "Daily",
          thresholds: [{ label: "Bullish", value: "Price > 20DMA" }, { label: "Extended (caution)", value: "Price > 20DMA by >3%" }, { label: "Bearish", value: "Price < 20DMA" }],
        },
      },
      {
        id: "price-vs-sma50",
        category: "Trend", name: "Price vs 50 DMA — Nifty 50",
        value: parseFloat(((n.close / n.sma50 - 1) * 100).toFixed(2)),
        verdict: n.close > n.sma50 ? "Bullish" : "Bearish",
        strength: Math.abs(n.close - n.sma50) / n.sma50 > 0.03 ? "Strong" : "Moderate",
        description: `Nifty at ${n.close.toFixed(0)} is ${n.close > n.sma50 ? "above" : "below"} 50 DMA (${n.sma50.toFixed(0)}). Medium-term trend ${n.close > n.sma50 ? "intact" : "broken"}.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "% from 50DMA = (Price − SMA50) / SMA50 × 100",
          computation: "50-day SMA is the most-watched medium-term moving average by institutional traders. Acts as key support in bull markets.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Price consistently holding above 50DMA = bull trend confirmation. Close below 50DMA on above-avg volume = medium-term trend break.",
          timeframe: "Daily",
          thresholds: [{ label: "Medium-term Bull", value: "Price > 50DMA" }, { label: "Caution", value: "Price at 50DMA ±1%" }, { label: "Medium-term Bear", value: "Price < 50DMA" }],
        },
      },
      {
        id: "price-vs-sma200",
        category: "Trend", name: "Price vs 200 DMA — Nifty 50",
        value: parseFloat(((n.close / n.sma200 - 1) * 100).toFixed(2)),
        verdict: n.close > n.sma200 ? "Bullish" : "Bearish",
        strength: Math.abs(n.close - n.sma200) / n.sma200 > 0.05 ? "Strong" : "Moderate",
        description: `Nifty at ${n.close.toFixed(0)} is ${n.close > n.sma200 ? "above" : "below"} 200 DMA (${n.sma200.toFixed(0)}). Long-term ${n.close > n.sma200 ? "bull" : "bear"} structure.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "% from 200DMA = (Price − SMA200) / SMA200 × 100",
          computation: "200-day SMA defines the primary long-term trend. FII/DII allocation decisions are often benchmarked against price vs 200DMA.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Price above 200DMA = structural bull market. Below 200DMA = structural bear. Many funds mandatorily reduce equity allocation when Nifty breaks 200DMA.",
          timeframe: "Daily",
          thresholds: [{ label: "Bull market structure", value: "Price > 200DMA" }, { label: "Bear market warning", value: "Price < 200DMA" }],
        },
      },
      {
        id: "heikin-ashi",
        category: "Trend", name: "Heikin Ashi Trend — Nifty 50",
        value: n.ha === "bullish" ? 1 : n.ha === "bearish" ? -1 : 0,
        verdict: n.ha === "bullish" ? "Bullish" : n.ha === "bearish" ? "Bearish" : "Neutral",
        strength: n.ha !== "neutral" ? "Moderate" : "Weak",
        description: `Heikin Ashi trend is ${n.ha}. ${n.ha === "bullish" ? "4+ of last 5 HA bars bullish — trend intact." : n.ha === "bearish" ? "Bearish HA pattern — consecutive red bars confirm downtrend." : "Mixed HA pattern — consolidation phase."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "HA Close = (O+H+L+C)/4   |   HA Open = (prev HA Open + prev HA Close)/2   |   HA High/Low = max/min of real H/L and HA O/C",
          computation: "Heikin Ashi bars average out price noise. Consecutive bullish (green) HA bars = persistent uptrend. Doji-like HA = potential reversal.",
          affectedAssets: ["NIFTY50"],
          interpretation: "4+ consecutive bull HA bars = strong trend, stay long. 4+ bear HA bars = strong downtrend. Doji HA after trend = reversal signal.",
          timeframe: "Daily",
          thresholds: [{ label: "Strong Bull", value: "4–5 of 5 bars bullish" }, { label: "Neutral/Reversal", value: "Mixed bars" }, { label: "Strong Bear", value: "4–5 of 5 bars bearish" }],
        },
      },
      {
        id: "adx-nifty",
        category: "Trend", name: "ADX (14) — Nifty 50",
        value: n.adx,
        verdict: n.adx > 25 ? (n.close > n.sma20 ? "Bullish" : "Bearish") : "Neutral",
        strength: n.adx > 40 ? "Strong" : n.adx > 25 ? "Moderate" : "Weak",
        description: `ADX at ${n.adx.toFixed(1)}. ${n.adx > 40 ? "Very strong trend." : n.adx > 25 ? "Trending market — directional trades valid." : "Weak trend — range-bound conditions."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "ADX = smoothed average of DX   |   DX = |+DI − −DI| / (+DI + −DI) × 100   |   ±DI from Smoothed ±DM / ATR",
          computation: "ADX measures trend strength regardless of direction. Computed from +DI (upward directional movement) and −DI (downward). Values 0–100.",
          affectedAssets: ["NIFTY50"],
          interpretation: "ADX < 20 = no trend (range market, avoid breakout trades). ADX 20–25 = weak trend forming. ADX 25–40 = trending market. ADX > 40 = strong trend, stay with it.",
          timeframe: "Daily",
          thresholds: [{ label: "No trend", value: "< 20" }, { label: "Weak trend", value: "20–25" }, { label: "Strong trend", value: "25–40" }, { label: "Very strong", value: "> 40" }],
        },
      },
      {
        id: "vwap-20d",
        category: "Trend", name: "VWAP (20D Rolling) — Nifty 50",
        value: n.vwap,
        verdict: n.close > n.vwap ? "Bullish" : "Bearish",
        strength: Math.abs(n.close - n.vwap) / n.vwap > 0.015 ? "Strong" : "Moderate",
        description: `Price (${n.close.toFixed(0)}) is ${n.close > n.vwap ? "above" : "below"} 20D VWAP (${n.vwap.toFixed(0)}). ${n.close > n.vwap ? "Buyers in control over 20 sessions." : "Sellers in control — sellers entered at lower average."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "VWAP = Σ(Typical Price × Volume) / Σ(Volume)   |   Typical Price = (H + L + C) / 3",
          computation: "Volume-Weighted Average Price over the last 20 trading days. Represents the average price paid by all market participants weighted by volume.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Price above VWAP = institutional buyers are in profit, likely to add. Price below VWAP = institutions are underwater, may sell on rallies. Used by all algo/institutional desks.",
          timeframe: "Daily (20-session rolling)",
          thresholds: [{ label: "Bullish", value: "Price > VWAP" }, { label: "Bearish", value: "Price < VWAP" }],
        },
      },
      {
        id: "anchored-vwap",
        category: "Trend", name: "Anchored VWAP (YTD) — Nifty 50",
        value: aVWAP,
        verdict: n.close > aVWAP ? "Bullish" : "Bearish",
        strength: Math.abs(n.close - aVWAP) / (aVWAP || 1) > 0.02 ? "Strong" : "Moderate",
        description: `Price (${n.close.toFixed(0)}) is ${n.close > aVWAP ? "above" : "below"} YTD anchored VWAP (${aVWAP.toFixed(0)}). YTD ${n.close > aVWAP ? "net buyers in profit." : "average buyer is underwater."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Same as VWAP but anchored from Jan 1 of current year",
          computation: "VWAP computed from the first trading day of the calendar year (Jan 1). Represents the average entry price of all year-to-date participants.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Price above YTD AVWAP = all YTD buyers are in profit, strong hands holding. Price below = majority of YTD participants are underwater, supply overhead.",
          timeframe: "YTD (resets each Jan 1)",
          thresholds: [{ label: "All YTD buyers in profit", value: "Price > AVWAP" }, { label: "YTD buyers underwater", value: "Price < AVWAP" }],
        },
      },

      // ══════════════════════════════════════════════════════════════
      // VOLATILITY
      // ══════════════════════════════════════════════════════════════
      {
        id: "boll-nifty",
        category: "Volatility", name: "Bollinger Bands — Nifty 50",
        value: parseFloat((((n.close - n.boll.lower) / (n.boll.upper - n.boll.lower || 1)) * 100).toFixed(1)),
        verdict: n.close > n.boll.upper ? "Overbought" : n.close < n.boll.lower ? "Oversold" : "Neutral",
        strength: n.boll.squeeze ? "Weak" : "Moderate",
        description: n.boll.squeeze
          ? "Bollinger squeeze — low volatility phase, breakout imminent."
          : `%B at ${(((n.close - n.boll.lower) / (n.boll.upper - n.boll.lower || 1)) * 100).toFixed(0)}%. Price within bands.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Upper = SMA(20) + 2σ   |   Lower = SMA(20) − 2σ   |   %B = (Price − Lower) / (Upper − Lower) × 100",
          computation: "Bands expand/contract based on 20-day standard deviation. %B shows position within band (0=lower, 50=middle, 100=upper).",
          affectedAssets: ["NIFTY50"],
          interpretation: "%B > 100 = price outside upper band (overbought). %B < 0 = below lower band (oversold). Squeeze (narrow band) = low vol phase, impending breakout.",
          timeframe: "Daily",
          thresholds: [{ label: "Overbought (%B)", value: "> 100" }, { label: "Middle", value: "50" }, { label: "Oversold (%B)", value: "< 0" }],
        },
      },
      {
        id: "boll-squeeze",
        category: "Volatility", name: "Bollinger Band Squeeze — Nifty 50",
        value: parseFloat((((n.boll.upper - n.boll.lower) / n.boll.middle) * 100).toFixed(2)),
        verdict: n.boll.squeeze ? "Neutral" : "Neutral",
        strength: n.boll.squeeze ? "Strong" : "Weak",
        description: n.boll.squeeze
          ? `Band squeeze active — bandwidth ${(((n.boll.upper - n.boll.lower) / n.boll.middle) * 100).toFixed(1)}%. Explosive move imminent, direction uncertain.`
          : `Bandwidth at ${(((n.boll.upper - n.boll.lower) / n.boll.middle) * 100).toFixed(1)}%. Normal volatility regime, no squeeze.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Bandwidth = (Upper − Lower) / Middle × 100   |   Squeeze = Bandwidth < 4%",
          computation: "Bollinger Band width measures volatility contraction. When bandwidth drops to multi-month lows, it signals a period of extreme low volatility — classically precedes a major move.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Squeeze active (bandwidth < 4%) = coiled spring. Next directional move will likely be strong. Buy the breakout above upper band or sell below lower band after squeeze.",
          timeframe: "Daily",
          thresholds: [{ label: "Squeeze active", value: "Bandwidth < 4%" }, { label: "Normal", value: "4–8%" }, { label: "High volatility", value: "> 8%" }],
        },
      },
      {
        id: "boll-smallcap",
        category: "Volatility", name: "Bollinger Bands — Smallcap",
        value: sc ? parseFloat((((sc.close - sc.boll.lower) / (sc.boll.upper - sc.boll.lower || 1)) * 100).toFixed(1)) : 50,
        verdict: sc?.close && sc.close > sc.boll.upper ? "Overbought" : sc?.close && sc.close < sc.boll.lower ? "Oversold" : "Neutral",
        strength: "Moderate",
        description: sc
          ? `Smallcap %B at ${(((sc.close - sc.boll.lower) / (sc.boll.upper - sc.boll.lower || 1)) * 100).toFixed(0)}%. ${sc.boll.squeeze ? "Volatility compression — potential explosive move." : "Normal vol regime."}`
          : "Smallcap data unavailable.",
        asset: "SMALLCAP", timestamp: today,
        detail: {
          formula: "Bollinger %B on Nifty Smallcap 100 daily closes (20-period, 2σ)",
          computation: "Smallcap indices are more volatile than Nifty. Squeeze in smallcap often precedes sector-wide rotational moves.",
          affectedAssets: ["SMALLCAP", "NIFTY50"],
          interpretation: "Smallcap breaking out of squeeze before Nifty = risk-on rotation signal. Smallcap breaking down = breadth deterioration.",
          timeframe: "Daily",
          thresholds: [{ label: "Overbought", value: "%B > 100" }, { label: "Oversold", value: "%B < 0" }],
        },
      },
      {
        id: "vix-proxy",
        category: "Volatility", name: "India VIX Proxy (Realized Vol)",
        value: vixProxy,
        verdict: vixProxy > 20 ? "Bearish" : vixProxy < 13 ? "Bullish" : "Neutral",
        strength: vixProxy > 25 || vixProxy < 12 ? "Strong" : "Moderate",
        description: vixProxy > 20
          ? `Realized vol ${vixProxy.toFixed(1)}% annualized — elevated fear. Defensive positioning.`
          : vixProxy < 14
          ? `Realized vol ${vixProxy.toFixed(1)}% — low vol complacency. Mean-reversion risk.`
          : `Realized vol ${vixProxy.toFixed(1)}% — moderate, normal market conditions.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "RVol = √(Σ(ln(Cₙ/Cₙ₋₁) − μ)² / N × 252) × 100   |   N = 20 days",
          computation: "20-day annualized realized volatility of log returns. Proxy for India VIX (which measures implied vol from Nifty options). Computed from actual daily price moves.",
          affectedAssets: ["NIFTY50"],
          interpretation: "< 13% = complacency, low vol often precedes spikes. 13–18% = normal. 18–25% = elevated, reduce risk. > 25% = fear regime, max defensiveness.",
          timeframe: "20-day rolling, annualized",
          thresholds: [{ label: "Low vol (complacency)", value: "< 13%" }, { label: "Normal", value: "13–18%" }, { label: "Elevated", value: "18–25%" }, { label: "Fear regime", value: "> 25%" }],
        },
      },
      {
        id: "atr-nifty",
        category: "Volatility", name: "ATR (14) — Nifty 50",
        value: n.atr,
        verdict: n.atr / n.close > 0.015 ? "Bearish" : n.atr / n.close < 0.008 ? "Bullish" : "Neutral",
        strength: n.atr / n.close > 0.02 ? "Strong" : "Moderate",
        description: `ATR at ${n.atr.toFixed(0)} points (${((n.atr / n.close) * 100).toFixed(2)}% of price). ${n.atr / n.close > 0.015 ? "High daily range — volatility elevated, wider stops needed." : "Normal daily range — orderly market conditions."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "ATR = EMA(TR, 14)   |   TR = max(H−L, |H−prevC|, |L−prevC|)",
          computation: "True Range captures gap opens. 14-period EMA of TR gives Average True Range. Normalized by price (ATR%) removes price level bias.",
          affectedAssets: ["NIFTY50"],
          interpretation: "ATR% > 1.5% = high volatility day expected, wider stops. ATR% < 0.8% = calm market, tight stop-losses viable. Rising ATR during downtrend = panic selling.",
          timeframe: "Daily",
          thresholds: [{ label: "High vol (ATR%)", value: "> 1.5%" }, { label: "Normal", value: "0.8–1.5%" }, { label: "Low vol", value: "< 0.8%" }],
        },
      },
      {
        id: "support-resistance",
        category: "Volatility", name: "Support / Resistance — Nifty 50",
        value: parseFloat(((n.close - n.sr.support) / (n.sr.resistance - n.sr.support || 1) * 100).toFixed(1)),
        verdict: n.close > (n.sr.support + n.sr.resistance) / 2 ? "Bullish" : "Bearish",
        strength: "Moderate",
        description: `Support: ${n.sr.support.toFixed(0)} | Resistance: ${n.sr.resistance.toFixed(0)}. Price at ${(((n.close - n.sr.support) / (n.sr.resistance - n.sr.support || 1)) * 100).toFixed(0)}% of the range.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Support = min(Low, 50 days)   |   Resistance = max(High, 50 days)",
          computation: "Identifies the lowest low and highest high over the past 50 trading days (≈2.5 months). % position shows where current price sits in the range.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Price near resistance (>80%) = supply zone, caution on longs. Price near support (<20%) = demand zone, watch for bounce. Break outside range = new trend.",
          timeframe: "50-day rolling",
          thresholds: [{ label: "Support", value: n.sr.support.toFixed(0) }, { label: "Resistance", value: n.sr.resistance.toFixed(0) }, { label: "Mid-range", value: ((n.sr.support + n.sr.resistance) / 2).toFixed(0) }],
        },
      },
      {
        id: "fibonacci",
        category: "Volatility", name: "Fibonacci Retracement — Nifty 50",
        value: parseFloat((n.fib.level618).toFixed(0)),
        verdict: n.close > n.fib.level618 ? "Bullish" : n.close > n.fib.level382 ? "Neutral" : "Bearish",
        strength: "Moderate",
        description: `Fib levels (50D swing): 38.2% = ${n.fib.level382.toFixed(0)}, 50% = ${n.fib.level500.toFixed(0)}, 61.8% = ${n.fib.level618.toFixed(0)}. Price at ${n.close.toFixed(0)} is ${n.close > n.fib.level618 ? "above golden ratio" : n.close > n.fib.level382 ? "in retracement zone" : "below key support"}.`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Levels: 0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100% of range (High − Low)",
          computation: "Fibonacci ratios applied to the 50-day high-low range. In an uptrend, 38.2–61.8% pullbacks are considered healthy retracements and buying zones.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Price bouncing off 61.8% (golden ratio) = strong support, high-probability long. Break of 78.6% in an uptrend = trend reversal signal. 23.6% = shallow pullback, momentum intact.",
          timeframe: "50-day swing",
          thresholds: [
            { label: "Shallow pullback", value: n.fib.level236.toFixed(0) + " (23.6%)" },
            { label: "Normal retracement", value: n.fib.level382.toFixed(0) + " (38.2%)" },
            { label: "Golden ratio (key)", value: n.fib.level618.toFixed(0) + " (61.8%)" },
          ],
        },
      },

      // ══════════════════════════════════════════════════════════════
      // VOLUME
      // ══════════════════════════════════════════════════════════════
      {
        id: "obv-nifty",
        category: "Volume", name: "OBV Trend — Nifty 50",
        value: n.obv,
        verdict: n.obv > 10 ? "Bullish" : n.obv < -10 ? "Bearish" : "Neutral",
        strength: Math.abs(n.obv) > 20 ? "Strong" : Math.abs(n.obv) > 10 ? "Moderate" : "Weak",
        description: n.obv > 10 ? `OBV in accumulation (${n.obv.toFixed(1)}). Smart money buying on dips.` : n.obv < -10 ? `OBV in distribution (${n.obv.toFixed(1)}). Volume supporting downside.` : `OBV neutral (${n.obv.toFixed(1)}).`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "OBV += Volume if Close > prevClose   |   OBV −= Volume if Close < prevClose   |   Normalized to −100 to +100",
          computation: "Running total of volume: add full day volume on up days, subtract on down days. Reveals if volume is flowing into or out of the market.",
          affectedAssets: ["NIFTY50"],
          interpretation: "OBV rising while price flat = accumulation (bullish divergence, imminent breakout). OBV falling while price flat = distribution (bearish, impending breakdown). OBV confirms trend when in sync.",
          timeframe: "Daily (cumulative)",
          thresholds: [{ label: "Accumulation", value: "OBV > +10" }, { label: "Neutral", value: "−10 to +10" }, { label: "Distribution", value: "OBV < −10" }],
        },
      },
      {
        id: "volume-spike",
        category: "Volume", name: "Volume Spike vs 20D Avg — Nifty 50",
        value: n.volSpike,
        verdict: n.volSpike > 1.5 ? (n.close > (n.closes.at(-2) ?? n.close) ? "Bullish" : "Bearish") : "Neutral",
        strength: n.volSpike > 2.0 ? "Strong" : n.volSpike > 1.5 ? "Moderate" : "Weak",
        description: `Volume ${n.volSpike.toFixed(2)}× the 20D average. ${n.volSpike > 1.5 ? `Significant volume spike — ${n.close > (n.closes.at(-2) ?? n.close) ? "strong buying interest" : "heavy selling pressure"}.` : "Volume within normal range."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Spike Ratio = Today's Volume / 20D Avg Volume",
          computation: "Compares current session volume to the 20-day average. Spikes (>1.5×) on price moves confirm institutional participation.",
          affectedAssets: ["NIFTY50"],
          interpretation: "Spike (>1.5×) on up day = institutional buying, bullish confirmation. Spike on down day = panic selling or distribution, bearish. Low vol on rally = weak move, not sustained.",
          timeframe: "Daily vs 20D average",
          thresholds: [{ label: "Major spike", value: "> 2×" }, { label: "Moderate spike", value: "1.5–2×" }, { label: "Normal", value: "0.7–1.5×" }, { label: "Low volume", value: "< 0.7×" }],
        },
      },

      // ══════════════════════════════════════════════════════════════
      // RELATIVE STRENGTH
      // ══════════════════════════════════════════════════════════════
      {
        id: "rs-gold-nifty",
        category: "Relative Strength", name: "Gold / Nifty Ratio",
        value: rs.goldNifty,
        verdict: rs.goldNifty > 20 ? "Bearish" : rs.goldNifty < 15 ? "Bullish" : "Neutral",
        strength: "Moderate",
        description: `Gold/Nifty ratio at ${rs.goldNifty.toFixed(2)}. ${rs.goldNifty > 18 ? "Rising ratio = risk-off, gold outperforming." : "Equity preference — risk-on."}`,
        asset: "GOLD", timestamp: today,
        detail: {
          formula: "Gold/Nifty Ratio = Gold Price / Nifty 50 × 100",
          computation: "Tracks relative performance of gold (safe-haven) vs equity (risk asset). Rising ratio = capital rotating from equity to gold.",
          affectedAssets: ["GOLD", "NIFTY50"],
          interpretation: "Rising ratio = risk-off regime, defensive positioning. Falling ratio = risk-on, equity outperforming safe-havens. Key regime-change indicator.",
          timeframe: "Daily",
          thresholds: [{ label: "Risk-off (gold winning)", value: "> 20" }, { label: "Neutral", value: "15–20" }, { label: "Risk-on (equity winning)", value: "< 15" }],
        },
      },
      {
        id: "rs-nifty-us10y",
        category: "Relative Strength", name: "Nifty / US10Y Ratio",
        value: rs.niftyUS10Y,
        verdict: rs.niftyUS10Y > 5 ? "Bullish" : rs.niftyUS10Y < 3 ? "Bearish" : "Neutral",
        strength: "Moderate",
        description: `Nifty/10Y ratio at ${rs.niftyUS10Y.toFixed(3)}. ${rs.niftyUS10Y > 4.5 ? "Equity remains attractive relative to bonds." : "Bonds becoming competitive vs equity on risk-adjusted basis."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Nifty / (US10Y Yield × 1000)   — normalizes index to yield units",
          computation: "Compares equity market level relative to bond yields. Rising 10Y yield increases the denominator, making equity relatively expensive.",
          affectedAssets: ["NIFTY50", "US10Y"],
          interpretation: "High ratio = equity cheap relative to bond yields. Low ratio = bonds competitive with equity. When 10Y rises sharply, this ratio falls, triggering equity rotation to bonds.",
          timeframe: "Daily",
          thresholds: [{ label: "Equity attractive", value: "> 5" }, { label: "Neutral", value: "3–5" }, { label: "Bonds competitive", value: "< 3" }],
        },
      },
      {
        id: "rs-smallcap-largecap",
        category: "Relative Strength", name: "Smallcap / Largecap Ratio",
        value: rs.smallcapLargecap,
        verdict: rs.smallcapLargecap > 0.8 ? "Bullish" : rs.smallcapLargecap < 0.6 ? "Bearish" : "Neutral",
        strength: "Moderate",
        description: `Smallcap/Largecap ratio at ${rs.smallcapLargecap.toFixed(3)}. ${rs.smallcapLargecap > 0.75 ? "Broad participation — healthy risk appetite." : "Flight to large-cap safety."}`,
        asset: "SMALLCAP", timestamp: today,
        detail: {
          formula: "Smallcap Index / Nifty 50 Index",
          computation: "Measures relative performance of small-cap vs large-cap equities. Rising ratio = broad market rally with risk appetite. Falling ratio = flight to quality.",
          affectedAssets: ["SMALLCAP", "NIFTY50"],
          interpretation: "Rising ratio = healthy bull market with broad participation. Falling ratio = large-cap concentration, fragile rally. Ratio breakdown often precedes Nifty correction.",
          timeframe: "Daily",
          thresholds: [{ label: "Broad participation (bull)", value: "> 0.8" }, { label: "Neutral", value: "0.6–0.8" }, { label: "Flight to quality", value: "< 0.6" }],
        },
      },
      {
        id: "rs-nifty-spx",
        category: "Relative Strength", name: "Nifty / S&P 500 Ratio",
        value: rs.niftySPX,
        verdict: rs.niftySPX > 4.5 ? "Bullish" : rs.niftySPX < 3.5 ? "Bearish" : "Neutral",
        strength: "Moderate",
        description: `Nifty/SPX ratio at ${rs.niftySPX.toFixed(2)}. ${rs.niftySPX > 4.2 ? "India outperforming US — FII allocation likely to increase." : "India underperforming US."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Nifty 50 / S&P 500 (price ratio, unhedged)",
          computation: "Compares Indian equity performance vs US equity. Rising ratio = India outperformance, attracting global FII flows. Falling = US markets preferred.",
          affectedAssets: ["NIFTY50", "SPX", "USDINR"],
          interpretation: "Rising ratio = EM premium for India. FII flows follow this ratio — sustained outperformance attracts incremental allocation. Ratio also influenced by USD/INR.",
          timeframe: "Daily",
          thresholds: [{ label: "India outperforming", value: "> 4.5" }, { label: "Neutral", value: "3.5–4.5" }, { label: "US outperforming", value: "< 3.5" }],
        },
      },
      {
        id: "rs-copper-gold",
        category: "Relative Strength", name: "Copper / Gold Ratio",
        value: rs.copperGold,
        verdict: rs.copperGold > 0.002 ? "Bullish" : rs.copperGold < 0.001 ? "Bearish" : "Neutral",
        strength: "Moderate",
        description: `Copper/Gold ratio at ${rs.copperGold.toFixed(4)}. ${rs.copperGold > 0.0015 ? "Rising copper vs gold — global growth positive." : "Falling ratio — growth concerns."}`,
        asset: "COPPER", timestamp: today,
        detail: {
          formula: "Copper Price / Gold Price",
          computation: "Copper (industrial metal) vs Gold (safe-haven). Rising ratio = markets pricing growth over safety. Falling = risk-off, recession concern.",
          affectedAssets: ["COPPER", "GOLD"],
          interpretation: "Copper/Gold ratio is one of the best leading indicators for global growth and bond yields. Rising ratio often precedes rising 10Y yields. Falling ratio = deflationary signal.",
          timeframe: "Daily",
          thresholds: [{ label: "Growth positive", value: "> 0.002" }, { label: "Neutral", value: "0.001–0.002" }, { label: "Deflationary signal", value: "< 0.001" }],
        },
      },

      // ══════════════════════════════════════════════════════════════
      // MACRO
      // ══════════════════════════════════════════════════════════════
      {
        id: "us10y-yield",
        category: "Macro", name: "US 10Y Treasury Yield",
        value: yield10y,
        verdict: yield10y > 5 ? "Bearish" : yield10y < 3.5 ? "Bullish" : "Neutral",
        strength: yield10y > 5.5 || yield10y < 3 ? "Strong" : "Moderate",
        description: `US 10Y yield at ${yield10y.toFixed(2)}%. ${yield10y > 4.5 ? "High yields compress equity multiples and pressure EM flows." : yield10y < 3.5 ? "Low yields supportive of equity valuations." : "Yield in neutral zone."}`,
        asset: "US10Y", timestamp: today,
        detail: {
          formula: "Direct yield from US Treasury 10-year bond market pricing",
          computation: "The 10Y yield is the benchmark global risk-free rate. It directly affects equity P/E compression, mortgage rates, and emerging market capital flows.",
          affectedAssets: ["US10Y", "NIFTY50", "GOLD", "USDINR"],
          interpretation: "Rising 10Y = pressure on high-PE equities, DXY strength, FII outflows from India. Falling 10Y = equity-friendly, EM inflows. Critical level: 4.5–5% for equity impact.",
          timeframe: "Daily",
          thresholds: [{ label: "Supportive for equities", value: "< 3.5%" }, { label: "Neutral", value: "3.5–4.5%" }, { label: "Pressure on equities", value: "> 4.5%" }, { label: "High stress", value: "> 5%" }],
        },
      },
      {
        id: "us2y-yield",
        category: "Macro", name: "US 2Y Treasury Yield",
        value: yield2y,
        verdict: yield2y > 5 ? "Bearish" : yield2y < 3 ? "Bullish" : "Neutral",
        strength: yield2y > 5 ? "Strong" : "Moderate",
        description: `US 2Y yield at ${yield2y.toFixed(2)}%. ${yield2y > 4.5 ? "Elevated short-term rates signal tight Fed policy — risk-off." : "Short-term rates declining — potential Fed pivot signal."}`,
        asset: "US2Y", timestamp: today,
        detail: {
          formula: "Direct yield from US Treasury 2-year bond market pricing",
          computation: "2Y yield most directly reflects Fed Funds Rate expectations. Rapid moves in 2Y signal market re-pricing of Fed policy trajectory.",
          affectedAssets: ["US2Y", "USDINR", "NIFTY50"],
          interpretation: "2Y falling faster than 10Y = steepening curve, growth expectations improving. 2Y above 10Y = inversion, recession risk. 2Y most sensitive to Fed rate change news.",
          timeframe: "Daily",
          thresholds: [{ label: "Tight Fed policy", value: "> 5%" }, { label: "Neutral", value: "3–5%" }, { label: "Easy policy", value: "< 3%" }],
        },
      },
      {
        id: "yield-curve",
        category: "Macro", name: "Yield Curve (10Y − 2Y)",
        value: yieldSpread,
        verdict: yieldSpread > 0.3 ? "Bullish" : yieldSpread < 0 ? "Bearish" : "Neutral",
        strength: Math.abs(yieldSpread) > 0.5 ? "Strong" : "Moderate",
        description: yieldSpread < 0
          ? `Inverted: 10Y−2Y = ${yieldSpread.toFixed(2)}%. Historically precedes recession. Risk-off.`
          : `Yield spread ${yieldSpread.toFixed(2)}%. ${yieldSpread > 0.3 ? "Normal slope — growth expectations positive." : "Flat curve — economic uncertainty."}`,
        asset: "US10Y", timestamp: today,
        detail: {
          formula: "Yield Spread = US 10Y Yield − US 2Y Yield",
          computation: "Spread between long-term and short-term US government bond yields. Positive = normal upward slope. Negative = inverted (short > long).",
          affectedAssets: ["US10Y", "US2Y", "NIFTY50", "GOLD"],
          interpretation: "Inversion (spread < 0) has preceded every US recession since 1970. India equities typically correct 6–18 months after US curve inverts. Steepening from inversion = recovery signal.",
          timeframe: "Daily",
          thresholds: [{ label: "Normal (growth)", value: "> 0.3%" }, { label: "Flat (caution)", value: "0–0.3%" }, { label: "Inverted (recession)", value: "< 0%" }],
        },
      },
      {
        id: "real-yield",
        category: "Macro", name: "Real Yield (10Y − CPI est.)",
        value: realYield,
        verdict: realYield > 1.5 ? "Bearish" : realYield < 0 ? "Bullish" : "Neutral",
        strength: Math.abs(realYield) > 1.5 ? "Strong" : "Moderate",
        description: `Real yield ${realYield.toFixed(2)}% (10Y ${yield10y.toFixed(2)}% − CPI est. ${CPI_ESTIMATE}%). ${realYield > 1 ? "Positive real yields make bonds attractive vs equity." : "Low/negative real yield favors gold and real assets."}`,
        asset: "US10Y", timestamp: today,
        detail: {
          formula: "Real Yield = Nominal 10Y Yield − CPI Inflation Rate (est. 4.2%)",
          computation: "Inflation-adjusted bond yield. When real yields are negative, bonds lose purchasing power — investors prefer gold, commodities, equities. Positive real yields = bond competition for equities.",
          affectedAssets: ["US10Y", "GOLD", "NIFTY50"],
          interpretation: "Negative real yield = gold and equity positive. Rapidly rising real yield (>2%) = pressure on high-PE equities. Real yields drive gold price inversely.",
          timeframe: "Daily",
          thresholds: [{ label: "Gold-positive (neg. real yield)", value: "< 0%" }, { label: "Neutral", value: "0–1.5%" }, { label: "Equity-negative (high real yield)", value: "> 1.5%" }],
        },
      },
      {
        id: "crude-trend",
        category: "Macro", name: "Crude Oil Trend (RSI)",
        value: crude?.rsi ?? 50,
        verdict: (crude?.rsi ?? 50) > 60 ? "Bearish" : (crude?.rsi ?? 50) < 40 ? "Bullish" : "Neutral",
        strength: Math.abs((crude?.rsi ?? 50) - 50) > 15 ? "Strong" : "Moderate",
        description: (crude?.rsi ?? 50) < 40
          ? `Crude weakening (RSI ${(crude?.rsi ?? 50).toFixed(1)}). Positive for India — lower import bill, reduced CAD pressure.`
          : (crude?.rsi ?? 50) > 60
          ? `Crude strengthening (RSI ${(crude?.rsi ?? 50).toFixed(1)}). Headwind for India — watch INR and inflation.`
          : `Crude consolidating at $${(crude?.close ?? 0).toFixed(2)}.`,
        asset: "CRUDE_OIL", timestamp: today,
        detail: {
          formula: "RSI(14) on Crude Oil (Brent/MCX) daily closes",
          computation: "India imports ~85% of crude oil. Crude price directly affects India's trade deficit (CAD), inflation (CPI), INR, and RBI rate stance.",
          affectedAssets: ["CRUDE_OIL", "USDINR", "NIFTY50"],
          interpretation: "Crude > $90/bbl: INR pressure, inflation, RBI holds rates → equity P/E compression. Crude < $70/bbl: India macro tailwind, INR stable, rate cuts possible → equity positive.",
          timeframe: "Daily",
          thresholds: [{ label: "India tailwind", value: "RSI < 40" }, { label: "Neutral", value: "RSI 40–60" }, { label: "India headwind", value: "RSI > 60" }],
        },
      },
      {
        id: "dxy-index",
        category: "Macro", name: "DXY — US Dollar Index",
        value: dxy ? dxy.close : lastClose("USDINR"),
        verdict: dxy
          ? (dxy.close > dxy.sma50 ? "Bearish" : "Bullish")
          : (usdinrLast > 84 ? "Bearish" : "Bullish"),
        strength: dxy ? (Math.abs(dxy.close - dxy.sma50) / dxy.sma50 > 0.01 ? "Strong" : "Moderate") : "Moderate",
        description: dxy
          ? `DXY at ${dxy.close.toFixed(2)}, ${dxy.close > dxy.sma50 ? "above" : "below"} 50 DMA (${dxy.sma50.toFixed(2)}). ${dxy.close > dxy.sma50 ? "Strong dollar = EM outflow pressure." : "Dollar weakening = EM inflow opportunity."}`
          : `USD/INR proxy: ${usdinrLast.toFixed(2)}. ${usdinrLast > 84 ? "INR weak — FII outflow pressure." : "INR stable."}`,
        asset: dxy ? "DXY" : "USDINR", timestamp: today,
        detail: {
          formula: "DXY = Geometric weighted average of USD vs EUR(57.6%), JPY(13.6%), GBP(11.9%), CAD(9.1%), SEK(4.2%), CHF(3.6%)",
          computation: "The US Dollar Index tracks USD strength vs a basket of 6 major currencies. When DXY data unavailable, USD/INR momentum is used as a proxy for dollar direction.",
          affectedAssets: ["DXY", "USDINR", "GOLD", "NIFTY50"],
          interpretation: "Rising DXY = dollar strengthening → gold falls, EM equities (incl. India) face FII outflows, commodity prices fall. Falling DXY = EM tailwind, gold rises.",
          timeframe: "Daily",
          thresholds: [{ label: "Dollar strong (EM headwind)", value: "DXY > 104" }, { label: "Neutral", value: "DXY 100–104" }, { label: "Dollar weak (EM tailwind)", value: "DXY < 100" }],
        },
      },
      {
        id: "fii-proxy",
        category: "Macro", name: "FII Flow Proxy (USD/INR 5D)",
        value: usdinr5dChg,
        verdict: usdinr5dChg > 0.5 ? "Bearish" : usdinr5dChg < -0.5 ? "Bullish" : "Neutral",
        strength: Math.abs(usdinr5dChg) > 1 ? "Strong" : "Moderate",
        description: `USD/INR 5-day change: ${usdinr5dChg > 0 ? "+" : ""}${usdinr5dChg}%. ${usdinr5dChg > 0.5 ? "INR weakening → FII outflow pressure on Indian equities." : usdinr5dChg < -0.5 ? "INR strengthening → FII inflow signal, equity positive." : "INR stable — neutral FII flow environment."}`,
        asset: "USDINR", timestamp: today,
        detail: {
          formula: "USD/INR 5D Change % = (Current − 5 Sessions Ago) / 5 Sessions Ago × 100",
          computation: "USD/INR movement is the most accessible proxy for FII flow direction. FII buying → sell USD, buy INR (INR strengthens). FII selling → buy USD, sell INR (INR weakens).",
          affectedAssets: ["USDINR", "NIFTY50"],
          interpretation: "INR weakening >0.5% in 5 days = FII net selling likely. INR strengthening = FII net buying. Direct impact on Nifty earnings for export sectors (IT, Pharma).",
          timeframe: "5-day rolling",
          thresholds: [{ label: "FII selling (INR weak)", value: "USD/INR +0.5%+" }, { label: "Neutral", value: "−0.5% to +0.5%" }, { label: "FII buying (INR strong)", value: "USD/INR −0.5%+" }],
        },
      },
      {
        id: "cpi-estimate",
        category: "Macro", name: "India CPI (Est.)",
        value: CPI_ESTIMATE,
        verdict: CPI_ESTIMATE > 5 ? "Bearish" : CPI_ESTIMATE < 3 ? "Bullish" : "Neutral",
        strength: "Weak",
        description: `CPI estimate at ${CPI_ESTIMATE}%. ${CPI_ESTIMATE > 5 ? "Above RBI tolerance band (2–6%). Rate cuts unlikely." : CPI_ESTIMATE < 4 ? "Within RBI comfort zone. Rate cut potential remains." : "Within RBI band — policy neutral."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "CPI = trailing 12M consumer price index (estimate, updated monthly)",
          computation: "India CPI is released monthly by MoSPI. This is a static estimate (4.2%) used until live data is available. CPI directly affects RBI rate decisions and equity valuation.",
          affectedAssets: ["NIFTY50", "US10Y", "GOLD"],
          interpretation: "CPI > 6% = RBI raises rates, equity negative. CPI < 4% = RBI can cut, equity positive. CPI 4–6% = RBI neutral, rate trajectory data-dependent.",
          timeframe: "Monthly estimate (static between releases)",
          thresholds: [{ label: "Rate cut possible", value: "< 4%" }, { label: "RBI neutral", value: "4–6%" }, { label: "Rate hike risk", value: "> 6%" }],
        },
      },

      // ══════════════════════════════════════════════════════════════
      // BREADTH
      // ══════════════════════════════════════════════════════════════
      {
        id: "breadth-50dma",
        category: "Breadth", name: "Sector Breadth — % above 50 DMA",
        value: breadth50,
        verdict: breadth50 > 70 ? "Bullish" : breadth50 < 40 ? "Bearish" : "Neutral",
        strength: breadth50 > 80 || breadth50 < 30 ? "Strong" : "Moderate",
        description: `${breadth50}% of tracked sector indices (${SECTORS.join(", ")}) are above their 50 DMA. ${breadth50 > 70 ? "Broad participation — healthy bull market." : breadth50 < 40 ? "Broad weakness — majority of sectors in short-term downtrend." : "Mixed breadth — selective opportunities."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "% Above 50DMA = (# Sector Indices above SMA50) / Total Sectors × 100",
          computation: `Computed across ${SECTORS.length} sector/market indices: ${SECTORS.join(", ")}. Each index checked if current close > 50-day SMA.`,
          affectedAssets: SECTORS,
          interpretation: "> 70% = broad bull market, risk-on confirmed. 40–70% = selective market. < 40% = broad weakness, risk-off. Falling breadth while Nifty rises = divergence, distribution.",
          timeframe: "Daily (50-day SMA reference)",
          thresholds: [{ label: "Broad bull", value: "> 70%" }, { label: "Mixed", value: "40–70%" }, { label: "Broad bear", value: "< 40%" }],
        },
      },
      {
        id: "breadth-200dma",
        category: "Breadth", name: "Sector Breadth — % above 200 DMA",
        value: breadth200,
        verdict: breadth200 > 65 ? "Bullish" : breadth200 < 35 ? "Bearish" : "Neutral",
        strength: breadth200 > 80 || breadth200 < 25 ? "Strong" : "Moderate",
        description: `${breadth200}% of tracked sectors above 200 DMA. ${breadth200 > 65 ? "Long-term bull market with broad structural strength." : breadth200 < 35 ? "Structural bear market — majority of sectors below long-term average." : "Mixed long-term picture."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "% Above 200DMA = (# Sector Indices above SMA200) / Total Sectors × 100",
          computation: `Same as 50DMA breadth but using the 200-day SMA. Requires 200+ days of data. Computed across: ${SECTORS.join(", ")}.`,
          affectedAssets: SECTORS,
          interpretation: "> 65% = long-term bull structure intact, dips are buying opportunities. < 35% = structural bear, rallies are selling opportunities. Most reliable breadth measure for macro allocation.",
          timeframe: "Daily (200-day SMA reference)",
          thresholds: [{ label: "Long-term bull", value: "> 65%" }, { label: "Mixed", value: "35–65%" }, { label: "Long-term bear", value: "< 35%" }],
        },
      },
      {
        id: "sector-ad",
        category: "Breadth", name: "Sector Advance / Decline Ratio",
        value: sectorADPct,
        verdict: sectorADPct > 65 ? "Bullish" : sectorADPct < 35 ? "Bearish" : "Neutral",
        strength: sectorADPct > 80 || sectorADPct < 20 ? "Strong" : "Moderate",
        description: `${sectorADPct.toFixed(0)}% of tracked sectors advancing today. ${sectorADPct > 65 ? "Broad advance — healthy upward session." : sectorADPct < 35 ? "Broad decline — wide selling across sectors." : "Mixed day — no clear directional bias."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "A/D Ratio = Advancing Sectors / (Advancing + Declining Sectors) × 100",
          computation: `Today's price vs prior close across ${SECTORS.length} sectors: ${SECTORS.join(", ")}. Higher ratio = more sectors participating in today's move.`,
          affectedAssets: SECTORS,
          interpretation: "A/D > 80% on up days = strong broad rally, confirmed by participation. A/D < 20% = panic selling across board. Nifty up but A/D < 40% = narrow, suspect rally.",
          timeframe: "Daily",
          thresholds: [{ label: "Broad advance", value: "> 65%" }, { label: "Mixed", value: "35–65%" }, { label: "Broad decline", value: "< 35%" }],
        },
      },
      {
        id: "breadth-smallcap",
        category: "Breadth", name: "Market Breadth (Smallcap vs Nifty)",
        value: parseFloat((rs.smallcapLargecap * 100).toFixed(1)),
        verdict: rs.smallcapLargecap > 0.75 ? "Bullish" : rs.smallcapLargecap < 0.6 ? "Bearish" : "Neutral",
        strength: "Moderate",
        description: rs.smallcapLargecap > 0.75
          ? "Broad market participation — more than large caps rallying. Healthy bull."
          : "Narrow breadth — only selective large-caps holding up.",
        asset: "SMALLCAP", timestamp: today,
        detail: {
          formula: "Smallcap/Nifty Price Ratio × 100",
          computation: "A higher ratio means smallcap index is performing closer to (or outperforming) the Nifty 50, indicating broader market participation beyond large-caps.",
          affectedAssets: ["SMALLCAP", "NIFTY50"],
          interpretation: "Ratio > 0.75 = strong breadth, mid & small caps participating. Ratio declining while Nifty holds = large-cap concentration, leadership narrowing (bearish divergence).",
          timeframe: "Daily",
          thresholds: [{ label: "Broad participation", value: "Ratio > 0.75" }, { label: "Narrowing leadership", value: "0.6–0.75" }, { label: "Flight to quality", value: "< 0.6" }],
        },
      },

      // ══════════════════════════════════════════════════════════════
      // COMPOSITE
      // ══════════════════════════════════════════════════════════════
      {
        id: "regime-signal",
        category: "Composite", name: "Risk-On / Risk-Off Regime",
        value: regimeType === "Risk-On" ? 1 : regimeType === "Risk-Off" ? -1 : 0,
        verdict: regimeType === "Risk-On" ? "Bullish" : regimeType === "Risk-Off" ? "Bearish" : "Neutral",
        strength: isRiskOff || isRiskOn ? "Strong" : "Moderate",
        description: `Current regime: ${regimeType}. ${regimeType === "Risk-Off" ? "RSI < 45, elevated RVol > 18% — defensive positioning, reduce equity." : regimeType === "Risk-On" ? "RSI > 55, low RVol, positive yield spread, Golden Cross — increase risk assets." : "Mixed signals — balanced allocation recommended."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Risk-Off: RSI<45 AND RVol>18%   |   Risk-On: RSI>55 AND YieldSpread>0.2% AND RVol<18% AND SMA50>SMA200",
          computation: "Rule-based regime classification combining Nifty RSI, 20D realized volatility, US yield spread, and MA crossover. Each condition weighted equally.",
          affectedAssets: ["NIFTY50", "GOLD", "US10Y", "USDINR"],
          interpretation: "Risk-On: overweight equity, underweight bonds/gold. Risk-Off: overweight gold/bonds, underweight equity. Neutral: balanced, reduce position sizes.",
          timeframe: "Daily (re-evaluated each session)",
          thresholds: [{ label: "Risk-On conditions", value: "RSI>55, RVol<18%, Spread>0.2%" }, { label: "Neutral", value: "Mixed indicators" }, { label: "Risk-Off conditions", value: "RSI<45 + RVol>18%" }],
        },
      },
      {
        id: "yield-regime",
        category: "Composite", name: "Yield Curve Regime",
        value: yieldSpread,
        verdict: yieldRegime === "Normal" ? "Bullish" : yieldRegime === "Inverted" ? "Bearish" : "Neutral",
        strength: yieldRegime !== "Normal" ? "Strong" : "Moderate",
        description: `Yield curve is ${yieldRegime} (spread: ${yieldSpread > 0 ? "+" : ""}${yieldSpread.toFixed(2)}%). ${yieldRegime === "Inverted" ? "Inverted curve has preceded every US recession since 1970 — risk-off allocation." : yieldRegime === "Flat" ? "Flat curve signals slowing growth — reduce cyclicals." : "Normal curve — expansionary environment."}`,
        asset: "US10Y", timestamp: today,
        detail: {
          formula: "Normal: Spread > 0.3%   |   Flat: 0–0.3%   |   Inverted: < 0%",
          computation: "Classifies the 10Y-2Y spread into three regimes historically associated with distinct economic phases and equity performance patterns.",
          affectedAssets: ["US10Y", "US2Y", "NIFTY50", "GOLD"],
          interpretation: "Inverted → recession warning, 6–18 month lead. Flat → late cycle, avoid deep cyclicals. Normal → early/mid cycle, risk assets favored. Steepening from inversion = recovery.",
          timeframe: "Daily",
          thresholds: [{ label: "Growth phase", value: "Spread > 0.3%" }, { label: "Late cycle", value: "0–0.3%" }, { label: "Recession risk", value: "< 0%" }],
        },
      },
      {
        id: "rotation-score",
        category: "Composite", name: "Capital Rotation Score",
        value: comp.rotationScore,
        verdict: comp.rotationScore > 65 ? "Bearish" : comp.rotationScore > 40 ? "Neutral" : "Bullish",
        strength: comp.rotationScore > 70 ? "Strong" : comp.rotationScore > 45 ? "Moderate" : "Weak",
        description: `Rotation Score ${comp.rotationScore}/100. ${comp.rotationScore > 65 ? "High rotation — asset class repositioning active. Expect volatility." : comp.rotationScore < 30 ? "Low rotation — trend continuation likely." : "Moderate rotation."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Rotation Score = f(FII flow magnitude, DII flow magnitude, Gold/Nifty ratio divergence, VIX level)",
          computation: "Composite score measuring how actively capital is rotating across asset classes. Higher score = more cross-asset movement, more volatility and uncertainty.",
          affectedAssets: ["NIFTY50", "GOLD", "USDINR"],
          interpretation: "Score > 65: active rotation, use stop-losses, reduce position size. 30–65: normal rotation, trend-following valid. < 30: low rotation, momentum strategies work best.",
          timeframe: "Daily",
          thresholds: [{ label: "High rotation (volatile)", value: "> 65" }, { label: "Normal rotation", value: "30–65" }, { label: "Low rotation (trend)", value: "< 30" }],
        },
      },
      {
        id: "risk-pressure",
        category: "Composite", name: "Risk Pressure Index",
        value: comp.riskPressure,
        verdict: comp.riskPressure > 60 ? "Bearish" : comp.riskPressure < 30 ? "Bullish" : "Neutral",
        strength: comp.riskPressure > 70 ? "Strong" : comp.riskPressure > 40 ? "Moderate" : "Weak",
        description: `Risk Pressure ${comp.riskPressure}/100. ${comp.riskPressure > 60 ? "Elevated risk — multiple stress indicators active. Reduce exposure." : comp.riskPressure < 30 ? "Low risk environment — conditions favorable for risk assets." : "Moderate risk environment."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Risk Pressure = f(VIX level, FII flow direction, RSI extremes, MACD magnitude, ADX)",
          computation: "Aggregates multiple risk indicators into a single stress index. Captures both realized volatility, flow stress, and technical breakdown signals.",
          affectedAssets: ["NIFTY50", "GOLD", "USDINR"],
          interpretation: "> 70: high stress, cut equity exposure significantly. 40–70: elevated, be selective. < 30: low stress, risk assets outperform, increase equity allocation.",
          timeframe: "Daily",
          thresholds: [{ label: "Low stress (risk-on)", value: "< 30" }, { label: "Moderate", value: "30–60" }, { label: "High stress (risk-off)", value: "> 60" }],
        },
      },
      {
        id: "health-score",
        category: "Composite", name: "Market Health Score",
        value: comp.healthScore,
        verdict: comp.healthScore > 65 ? "Bullish" : comp.healthScore < 40 ? "Bearish" : "Neutral",
        strength: comp.healthScore > 75 ? "Strong" : comp.healthScore > 50 ? "Moderate" : "Weak",
        description: `Market Health ${comp.healthScore}/100. ${comp.healthScore > 65 ? "Healthy internals — breadth, flows, momentum all supportive." : comp.healthScore < 40 ? "Deteriorating health — multiple indicators in warning zone." : "Mixed health indicators."}`,
        asset: "NIFTY50", timestamp: today,
        detail: {
          formula: "Health Score = f(RSI in healthy zone, DII flow support, ADX trend quality, VIX calm, Smallcap participation)",
          computation: "Composite measure of market quality — not just direction, but the sustainability and breadth of the current trend.",
          affectedAssets: ["NIFTY50", "SMALLCAP"],
          interpretation: "> 75: high quality trend, momentum strategies outperform. 40–75: medium quality, be selective. < 40: poor health, avoid trend-following, focus on defensive.",
          timeframe: "Daily",
          thresholds: [{ label: "Healthy (trend quality)", value: "> 65" }, { label: "Mixed", value: "40–65" }, { label: "Deteriorating", value: "< 40" }],
        },
      },
    ];

    return NextResponse.json(signals, { status: 200 });
  } catch (error) {
    console.error("[GET /api/signals]", error);
    return NextResponse.json({ error: "Failed to compute signals" }, { status: 500 });
  }
}
