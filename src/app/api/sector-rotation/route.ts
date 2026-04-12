// GET /api/sector-rotation
// Returns sector inflow/outflow data computed from real NeonDB price data.
// Indicator values (RSI, MACD, momentum, relative strength, flow score) are
// read from the Indicator table (written by fetch_prices.py --history).
// Only sectors with sufficient real PriceData are returned — no proxies.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ─── Sector display config ────────────────────────────────────────────────────
const SECTOR_CONFIG: Record<string, {
  name: string; cycleSector: "Cyclical" | "Defensive" | "Sensitive"; color: string;
}> = {
  NIFTY_BANK:   { name: "Banking & Finance",      cycleSector: "Cyclical",   color: "#3b82f6" },
  NIFTY_IT:     { name: "Information Technology", cycleSector: "Sensitive",  color: "#8b5cf6" },
  NIFTY_PHARMA: { name: "Pharmaceuticals",        cycleSector: "Defensive",  color: "#22c55e" },
  NIFTY_FMCG:   { name: "FMCG & Consumer",        cycleSector: "Defensive",  color: "#f59e0b" },
  NIFTY_AUTO:   { name: "Automobiles",             cycleSector: "Cyclical",   color: "#f97316" },
  NIFTY_INFRA:  { name: "Infrastructure",          cycleSector: "Cyclical",   color: "#0ea5e9" },
  NIFTY_REALTY: { name: "Real Estate",             cycleSector: "Cyclical",   color: "#14b8a6" },
  NIFTY_METAL:  { name: "Metals & Mining",         cycleSector: "Sensitive",  color: "#a16207" },
  NIFTY_ENERGY: { name: "Energy & Oil Gas",        cycleSector: "Sensitive",  color: "#dc2626" },
  NIFTY_MEDIA:  { name: "Media & Entertainment",   cycleSector: "Cyclical",   color: "#7c3aed" },
  SMALLCAP:     { name: "Small & Mid Cap",         cycleSector: "Cyclical",   color: "#ec4899" },
};

const SECTOR_TICKERS = Object.keys(SECTOR_CONFIG);

// ─── Types ────────────────────────────────────────────────────────────────────
export interface SectorData {
  id:            string;
  name:          string;
  ticker:        string;
  cycleSector:   "Cyclical" | "Defensive" | "Sensitive";
  color:         string;
  price:         number;
  change1D:      number;
  change1M:      number;
  change3M:      number;
  rsi:           number;
  macdHistogram: number;
  relStrength:   number;
  flowScore:     number;
  flowDirection: "Inflow" | "Outflow" | "Neutral";
  flowStrength:  "Strong" | "Moderate" | "Weak";
  momentum5D:    number[];
}

export interface CyclePhaseInfo {
  phase:          string;
  description:    string;
  prevPhase:      string;
  nextPhase:      string;
  confidence:     number;
  leadingSectors: string[];
  laggingSectors: string[];
  color:          string;
  bgColor:        string;
}

// ─── Compute helpers (fallback if Indicator table has no data yet) ─────────────
function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function computeMACDHist(closes: number[]): number {
  const ema = (data: number[], n: number) => {
    const k = 2 / (n + 1);
    return data.reduce((e, v) => v * k + e * (1 - k));
  };
  if (closes.length < 26) return 0;
  const slice = closes.slice(-35);
  const e12 = ema(slice, 12);
  const e26 = ema(slice, 26);
  const macd = e12 - e26;
  return parseFloat((macd * 0.8).toFixed(4));  // simplified signal approximation
}

function pctChange(closes: number[], n: number): number {
  if (closes.length < n + 1) return 0;
  const old = closes[closes.length - 1 - n];
  const cur = closes[closes.length - 1];
  return old ? parseFloat(((cur - old) / old * 100).toFixed(2)) : 0;
}

function relStrength(sectorC: number[], benchC: number[], lookback = 60): number {
  if (sectorC.length < lookback || benchC.length < lookback) return 100;
  const s0 = sectorC[sectorC.length - lookback], sN = sectorC[sectorC.length - 1];
  const b0 = benchC[benchC.length - lookback], bN = benchC[benchC.length - 1];
  if (!s0 || !b0) return 100;
  return parseFloat(((sN / s0) / (bN / b0) * 100).toFixed(2));
}

function flowScore(rsi: number, macdH: number, mom1M: number, rs: number): number {
  const r = (rsi - 50) * 1.4;
  const m = Math.max(-15, Math.min(15, macdH * 5));
  const p = Math.max(-20, Math.min(20, mom1M * 2));
  const s = Math.max(-15, Math.min(15, (rs - 100) * 0.5));
  return Math.max(-100, Math.min(100, parseFloat((r + m + p + s).toFixed(1))));
}

// ─── Cycle detection ──────────────────────────────────────────────────────────
function detectCycle(scores: Record<string, number>): CyclePhaseInfo {
  const g = (k: string) => scores[k] ?? 0;
  const cyclicalAvg   = (g("NIFTY_BANK") + g("NIFTY_AUTO") + g("NIFTY_INFRA") + g("NIFTY_REALTY")) / 4;
  const defensiveAvg  = (g("NIFTY_PHARMA") + g("NIFTY_FMCG")) / 2;
  const sensitiveAvg  = (g("NIFTY_IT") + g("NIFTY_METAL") + g("NIFTY_ENERGY")) / 3;

  const phases = [
    {
      phase: "Early Recovery",
      score: g("NIFTY_BANK") * 0.4 + g("SMALLCAP") * 0.35 + g("NIFTY_REALTY") * 0.25,
      description: "Financials & rate-sensitive sectors leading; cheap valuations attract fresh capital",
      color: "#22c55e", bgColor: "#f0fdf4",
      leadingSectors: ["Banking", "Realty", "Small Cap"],
      laggingSectors: ["Energy", "FMCG"],
    },
    {
      phase: "Early Expansion",
      score: g("NIFTY_IT") * 0.35 + g("NIFTY_AUTO") * 0.35 + g("SMALLCAP") * 0.3,
      description: "Growth sectors accelerate; rising earnings expectations drive IT and Autos",
      color: "#3b82f6", bgColor: "#eff6ff",
      leadingSectors: ["IT", "Auto", "Small Cap"],
      laggingSectors: ["Pharma", "FMCG"],
    },
    {
      phase: "Mid Expansion",
      score: g("NIFTY_INFRA") * 0.35 + g("NIFTY_METAL") * 0.35 + g("NIFTY_ENERGY") * 0.3,
      description: "Commodities & infrastructure outperform; broad participation across sectors",
      color: "#8b5cf6", bgColor: "#f5f3ff",
      leadingSectors: ["Infra", "Metals", "Energy"],
      laggingSectors: ["Defensives"],
    },
    {
      phase: "Late Expansion",
      score: g("NIFTY_ENERGY") * 0.4 + g("NIFTY_METAL") * 0.3 + defensiveAvg * 0.3,
      description: "Energy peaks; defensives begin attracting safe-haven interest",
      color: "#f59e0b", bgColor: "#fffbeb",
      leadingSectors: ["Energy", "Metals", "FMCG"],
      laggingSectors: ["IT", "Banking"],
    },
    {
      phase: "Early Contraction",
      score: defensiveAvg * 0.5 + (-cyclicalAvg) * 0.3 + (-sensitiveAvg) * 0.2,
      description: "Defensive rotation underway; Pharma & FMCG absorbing capital from cyclicals",
      color: "#ef4444", bgColor: "#fef2f2",
      leadingSectors: ["Pharma", "FMCG"],
      laggingSectors: ["Banking", "Auto", "Realty"],
    },
    {
      phase: "Late Contraction",
      score: defensiveAvg * 0.45 + (-cyclicalAvg) * 0.4 + (-sensitiveAvg) * 0.15,
      description: "Broad market weakness; only deep defensives holding up",
      color: "#dc2626", bgColor: "#fef2f2",
      leadingSectors: ["Pharma", "FMCG"],
      laggingSectors: ["All Cyclicals", "Small Cap"],
    },
  ];

  phases.sort((a, b) => b.score - a.score);
  const top = phases[0], second = phases[1];
  const conf = Math.min(0.92, 0.45 + (top.score - second.score) * 0.015);
  const order = phases.map(p => p.phase);
  const idx = order.indexOf(top.phase);
  return {
    phase:          top.phase,
    description:    top.description,
    prevPhase:      order[(idx - 1 + order.length) % order.length],
    nextPhase:      order[(idx + 1) % order.length],
    confidence:     parseFloat(conf.toFixed(2)),
    leadingSectors: top.leadingSectors,
    laggingSectors: top.laggingSectors,
    color:          top.color,
    bgColor:        top.bgColor,
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────
export async function GET() {
  try {
    // 1. Fetch PriceData for all sector tickers (last 90 rows)
    const assets = await prisma.asset.findMany({
      where: { ticker: { in: SECTOR_TICKERS }, isActive: true },
      include: {
        priceData: {
          orderBy: { timestamp: "asc" },
          take: 90,
        },
        // Latest indicators from DB (written by fetch_prices.py)
        indicators: {
          where: {
            name: { in: ["RSI_14", "MACD_HIST", "MOM_1M", "MOM_3M", "MOM_1D", "MOM_5D", "REL_STR_60D", "FLOW_SCORE"] },
          },
          orderBy: { timestamp: "desc" },
          take: 40,  // 8 indicator types × 5 latest each
        },
      },
    });

    if (!assets.length) {
      return NextResponse.json(
        { error: "No sector data in DB. Run: python3 scripts/fetch_prices.py --history" },
        { status: 404 },
      );
    }

    // 2. Fetch NIFTY50 benchmark closes for relative strength
    const nifty = await prisma.asset.findUnique({
      where: { ticker: "NIFTY50" },
      include: {
        priceData: { orderBy: { timestamp: "asc" }, take: 90 },
      },
    });
    const benchCloses = nifty?.priceData
      .filter(r => { const d = r.timestamp.getUTCDay(); return d !== 0 && d !== 6; })
      .map(r => r.close) ?? [];

    const sectors: SectorData[] = [];

    for (const asset of assets) {
      const cfg = SECTOR_CONFIG[asset.ticker];
      if (!cfg) continue;

      // Clean price data (no weekends, no duplicates)
      const seen = new Set<string>();
      const clean = asset.priceData
        .filter(r => { const d = r.timestamp.getUTCDay(); return d !== 0 && d !== 6; })
        .filter(r => {
          const k = r.timestamp.toISOString().slice(0, 10);
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });

      if (clean.length < 5) continue;  // skip if not enough real data

      const closes = clean.map(r => r.close);
      const latest = closes[closes.length - 1];

      // Helper: get latest indicator value from DB, fallback to computed
      const latestInd = (name: string): number | null => {
        const rows = asset.indicators.filter(i => i.name === name);
        return rows.length > 0 ? rows[0].value : null;
      };

      const rsi      = latestInd("RSI_14")      ?? computeRSI(closes);
      const macdH    = latestInd("MACD_HIST")   ?? computeMACDHist(closes);
      const mom1M    = latestInd("MOM_1M")      ?? pctChange(closes, 20);
      const mom3M    = latestInd("MOM_3M")      ?? pctChange(closes, 60);
      const rs       = latestInd("REL_STR_60D") ?? relStrength(closes, benchCloses);
      const c1D      = latestInd("MOM_1D")      ?? pctChange(closes, 1);
      const fScore   = latestInd("FLOW_SCORE")  ?? flowScore(rsi, macdH, mom1M, rs);

      // Sparkline: last 5 closes normalized to 100
      const last5 = closes.slice(-5);
      const b5    = last5[0] || 1;
      const spark = last5.map(v => parseFloat(((v / b5) * 100).toFixed(2)));

      const dir: SectorData["flowDirection"] =
        fScore > 12 ? "Inflow" : fScore < -12 ? "Outflow" : "Neutral";
      const str: SectorData["flowStrength"] =
        Math.abs(fScore) >= 40 ? "Strong" : Math.abs(fScore) >= 20 ? "Moderate" : "Weak";

      sectors.push({
        id:            asset.ticker,
        name:          cfg.name,
        ticker:        asset.ticker,
        cycleSector:   cfg.cycleSector,
        color:         cfg.color,
        price:         parseFloat(latest.toFixed(2)),
        change1D:      parseFloat(c1D.toFixed(2)),
        change1M:      parseFloat(mom1M.toFixed(2)),
        change3M:      parseFloat(mom3M.toFixed(2)),
        rsi:           parseFloat(rsi.toFixed(1)),
        macdHistogram: parseFloat(macdH.toFixed(4)),
        relStrength:   parseFloat(rs.toFixed(2)),
        flowScore:     parseFloat(fScore.toFixed(1)),
        flowDirection: dir,
        flowStrength:  str,
        momentum5D:    spark,
      });
    }

    if (!sectors.length) {
      return NextResponse.json(
        { error: "Sector tickers exist in DB but have no price data. Run --history to ingest." },
        { status: 404 },
      );
    }

    // 3. Detect cycle phase
    const scoreMap: Record<string, number> = {};
    for (const s of sectors) scoreMap[s.ticker] = s.flowScore;
    const cycle = detectCycle(scoreMap);

    // 4. Sort by flow score
    sectors.sort((a, b) => b.flowScore - a.flowScore);
    const topInflow  = sectors.filter(s => s.flowDirection === "Inflow").slice(0, 3).map(s => s.name);
    const topOutflow = sectors.filter(s => s.flowDirection === "Outflow").slice(0, 3).map(s => s.name);

    const rotationTheme = cycle.phase.includes("Contraction")
      ? `Defensive rotation — capital moving from cyclicals into ${topInflow.join(", ") || "defensives"}`
      : cycle.phase.includes("Expansion")
      ? `Growth cycle — ${topInflow.join(", ") || "cyclicals"} absorbing fresh capital inflows`
      : `Transition phase — sector rotation underway with mixed momentum signals`;

    return NextResponse.json({
      sectors,
      cycle,
      topInflow,
      topOutflow,
      rotationTheme,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[GET /api/sector-rotation]", err);
    return NextResponse.json({ error: "Failed to compute sector rotation" }, { status: 500 });
  }
}
