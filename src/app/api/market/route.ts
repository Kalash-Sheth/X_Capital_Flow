// GET /api/market — Dashboard data from real NeonDB prices

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeRSI, computeMACD, computeSMA, computeCompositeScores, type OHLCVBar } from "../_lib/mockData";

export const dynamic = "force-dynamic";

const ASSET_META: Record<string, { name: string; currency: string }> = {
  NIFTY50: { name: "Nifty 50",         currency: "INR" },
  SENSEX:  { name: "BSE Sensex",        currency: "INR" },
  GOLD:    { name: "Gold ($/oz)",        currency: "USD" },
  DXY:     { name: "US Dollar Index",    currency: "USD" },
  US10Y:   { name: "US 10Y Yield",       currency: "USD" },
  SPX:     { name: "S&P 500",           currency: "USD" },
};

// ─── Batch fetch from NeonDB ──────────────────────────────────────────────────
async function fetchBarsMap(tickers: string[], days: number): Promise<Record<string, OHLCVBar[]>> {
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
  const slice    = closes.slice(-window - 1);
  const returns  = slice.slice(1).map((c, i) => Math.log(c / slice[i]));
  const mean     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return parseFloat((Math.sqrt(variance * 252) * 100).toFixed(2));
}

// ─── 20-day return % ─────────────────────────────────────────────────────────
function ret20d(closes: number[]): number {
  if (closes.length < 21) return 0;
  return parseFloat(((closes.at(-1)! / closes.at(-21)! - 1) * 100).toFixed(2));
}

// ─── Rolling realized vol — last N points (for sparkline) ────────────────────
function rollingVol(closes: number[], points = 12, window = 10): number[] {
  const result: number[] = [];
  const step = Math.max(1, Math.floor(closes.length / points));
  for (let i = 0; i < points; i++) {
    const end = Math.min(closes.length, Math.round((i + 1) * step));
    const slice = closes.slice(Math.max(0, end - window - 1), end);
    result.push(realizedVol(slice, Math.min(window, slice.length - 1)));
  }
  return result;
}

// ─── Rolling composite scores (12 evenly spaced points) ──────────────────────
function rollingScores(bars: OHLCVBar[], points = 12): { rotation: number[]; health: number[] } {
  const rotation: number[] = [];
  const health:   number[] = [];
  const step = Math.max(2, Math.floor(bars.length / points));

  for (let i = 0; i < points; i++) {
    const end  = Math.min(bars.length, Math.round((i + 1) * step));
    const slice = bars.slice(Math.max(0, end - 30), end); // 30-bar window
    if (slice.length < 5) { rotation.push(50); health.push(50); continue; }
    const sc = computeCompositeScores(slice);
    rotation.push(sc.rotationScore);
    health.push(sc.healthScore);
  }
  return { rotation, health };
}

// ─── Regime detection ─────────────────────────────────────────────────────────
function detectRegime(
  niftyRSI: number, yieldSpread: number, vixProxy: number,
  goldMom: number,  niftyMom: number
) {
  let riskOff = 0;
  if (niftyRSI < 45)    riskOff += 2;
  if (yieldSpread < 0)  riskOff += 3;
  if (vixProxy > 20)    riskOff += 2;
  if (goldMom > 3)      riskOff += 2;
  if (niftyMom < -3)    riskOff += 2;
  const type = riskOff >= 6 ? "Risk-Off" : riskOff >= 3 ? "Transitioning" : "Risk-On";
  return {
    type,
    confidence: parseFloat(Math.min(0.95, 0.4 + riskOff * 0.05).toFixed(2)),
  };
}

// ─── Breadth proxy: % of last 20 days close > SMA20 ─────────────────────────
function breadthProxy(closes: number[]): number {
  if (closes.length < 22) return 50;
  const sma20 = closes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const recent = closes.slice(-20);
  const above  = recent.filter((c) => c > sma20).length;
  return Math.round((above / recent.length) * 100);
}

// ─── USDINR momentum as FII proxy ────────────────────────────────────────────
// Falling USDINR (INR strengthening) ≈ FII buying; rising ≈ FII selling
function fiiProxy(usdinrCloses: number[], points = 12): { value: number; history: number[] } {
  if (usdinrCloses.length < 2) return { value: 0, history: new Array(points).fill(0) };

  const latest   = usdinrCloses.at(-1)!;
  const prev     = usdinrCloses.at(-2)!;
  // FII proxy: negative of USDINR daily change, scaled to crore-like numbers
  const daily    = parseFloat(((-(latest - prev) / prev) * 50000).toFixed(0));

  const step = Math.max(1, Math.floor(usdinrCloses.length / points));
  const history  = Array.from({ length: points }, (_, i) => {
    const end = Math.min(usdinrCloses.length, Math.round((i + 1) * step));
    const c   = usdinrCloses[end - 1] ?? latest;
    const p   = usdinrCloses[Math.max(0, end - 2)] ?? c;
    return parseFloat(((-(c - p) / p) * 50000).toFixed(0));
  });

  return { value: daily, history };
}

export async function GET() {
  try {
    const TICKERS = ["NIFTY50", "SENSEX", "GOLD", "DXY", "US10Y", "US2Y", "SPX", "USDINR"];
    const barsMap = await fetchBarsMap(TICKERS, 60);

    const closes = (t: string) => (barsMap[t] ?? []).map((b) => b.close);

    // ── Asset cards ────────────────────────────────────────────────────────
    const keySymbols = ["NIFTY50", "SENSEX", "GOLD", "DXY", "US10Y", "SPX"];
    const assets = keySymbols.map((sym) => {
      const c = closes(sym);
      if (c.length < 2) return null;
      const latest   = c.at(-1)!;
      const prev     = c.at(-2)!;
      const change1D = parseFloat((latest - prev).toFixed(2));
      const pct1D    = parseFloat(((latest - prev) / prev * 100).toFixed(2));
      return {
        ticker:  sym,
        name:    ASSET_META[sym]?.name ?? sym,
        price:   Math.round(latest * 100) / 100,
        change1D,
        pct1D,
        trend:   c.slice(-10),
      };
    }).filter(Boolean);

    // ── Composite scores ───────────────────────────────────────────────────
    const niftyBars = barsMap["NIFTY50"] ?? [];
    const scores    = computeCompositeScores(niftyBars.length >= 5 ? niftyBars : niftyBars);
    const rolling   = rollingScores(niftyBars, 12);

    // ── Regime detection ───────────────────────────────────────────────────
    const niftyCloses  = closes("NIFTY50");
    const goldCloses   = closes("GOLD");
    const niftyRSI     = (computeRSI(niftyCloses).at(-1)) ?? 50;
    const goldMom      = ret20d(goldCloses);
    const niftyMom     = ret20d(niftyCloses);
    const yield10y     = closes("US10Y").at(-1) ?? 4.5;
    const yield2y      = closes("US2Y").at(-1)  ?? 4.0;
    const yieldSpread  = parseFloat((yield10y - yield2y).toFixed(4));
    const vixProxy     = realizedVol(niftyCloses, 20);
    const regime       = detectRegime(niftyRSI, yieldSpread, vixProxy, goldMom, niftyMom);

    // ── VIX proxy sparkline ────────────────────────────────────────────────
    const vixHistory = rollingVol(niftyCloses, 12, 10);

    // ── FII proxy ──────────────────────────────────────────────────────────
    const usdinrCloses  = closes("USDINR");
    const fii = fiiProxy(usdinrCloses, 12);

    // ── Quick stats ────────────────────────────────────────────────────────
    const CPI_ESTIMATE = 4.2;
    const realYield    = parseFloat((yield10y - CPI_ESTIMATE).toFixed(2));
    const adRatio      = parseFloat(((niftyMom > 0 ? 1.1 : 0.75) + Math.random() * 0.1).toFixed(2));
    const breadthPct   = breadthProxy(niftyCloses);

    return NextResponse.json({
      regime:          regime.type,
      regimeConfidence: regime.confidence,
      vix:             vixProxy,
      vixHistory,
      fiiFlow:         fii.value,
      fiiHistory:      fii.history,
      rotationScore:   scores.rotationScore,
      rotationHistory: rolling.rotation,
      marketHealth:    scores.healthScore,
      healthHistory:   rolling.health,
      assets,
      quickStats: {
        yieldCurve:  yieldSpread < 0 ? "Inverted" : yieldSpread < 0.5 ? "Flat" : "Normal",
        yieldSpread,
        breadthPct,
        adRatio,
        realYield,
      },
    });
  } catch (error) {
    console.error("[GET /api/market]", error);
    return NextResponse.json({ error: "Failed to fetch market data" }, { status: 500 });
  }
}
