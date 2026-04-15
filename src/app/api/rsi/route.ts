// GET /api/rsi
// Nifty RSI Extremes Intelligence Engine
// Monthly RSI(14) · Multi-index · Multi-threshold · Forward return analysis

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getDhanToken } from "@/lib/dhan-auth";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RsiMonthlyBar {
  date:  string;   // YYYY-MM-01
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export interface RsiBar {
  date: string;   // YYYY-MM-01
  rsi:  number;   // 0–100
}

export interface RsiExtremeEvent {
  startDate:    string;
  endDate:      string;
  peakRsi:      number;
  peakDate:     string;
  duration:     number;   // months in zone
  kind:         "sustained" | "brief";
  type:         "overbought" | "oversold";
  niftyAtStart: number;   // price when zone entered (display)
  niftyAtExit:  number;   // price when zone exited (return baseline)
  ret3m:        number | null;
  ret6m:        number | null;
  ret12m:       number | null;
  ret18m:       number | null;
  maxDrawdown:  number | null;
}

export interface RsiThresholdStats {
  totalEvents:    number;
  avgRet3m:       number;  avgRet6m:       number;
  avgRet12m:      number;  avgRet18m:      number;
  winRate3m:      number;  winRate6m:      number;
  winRate12m:     number;  winRate18m:     number;
  avgMaxDrawdown: number;
}

export interface RsiOutcomeSummary {
  ob80: RsiThresholdStats | null;  // RSI > 80
  ob70: RsiThresholdStats | null;  // RSI > 70
  os35: RsiThresholdStats | null;  // RSI < 35
  os50: RsiThresholdStats | null;  // RSI < 50
}

export interface RsiZone {
  label:   "Extreme" | "Elevated" | "Normal" | "Oversold" | "Extreme Oversold";
  color:   string;
  bgColor: string;
  value:   number;
}

export interface RsiSignal {
  label:      string;
  bias:       "Strong Bearish" | "Bearish" | "Caution" | "Neutral" | "Bullish";
  confidence: number;
  signal:     string;
  rationale:  string;
}

export interface RsiResponse {
  niftyBars:      RsiMonthlyBar[];
  rsiBars:        RsiBar[];
  extremeEvents:  RsiExtremeEvent[];   // primary: >80 and <30 for chart markers
  summary:        RsiOutcomeSummary;
  zone:           RsiZone;
  signal:         RsiSignal;
  currentRsi:     number;
  prevRsi:        number;
  change:         number;
  indexLabel:     string;
  hasData:        boolean;
}

// ─── Index config ─────────────────────────────────────────────────────────────

export type RsiIndex = "nifty50" | "nifty500" | "smallcap100";

interface IndexConfig {
  ticker:       string;
  label:        string;
  yf:           string | null;
  dhan:         { securityId: string; exchangeSegment: string } | null;
  allTimeStart: Date;
  minRows:      number;
}

const INDEX_CONFIG: Record<RsiIndex, IndexConfig> = {
  nifty50: {
    ticker: "NIFTY50", label: "Nifty 50",
    yf: "%5ENSEI", dhan: null,
    allTimeStart: new Date("2000-01-01"), minRows: 5000,
  },
  nifty500: {
    ticker: "NIFTY500", label: "Nifty 500",
    yf: "%5ECRSLDX", dhan: null,
    allTimeStart: new Date("2005-09-01"), minRows: 3000,
  },
  smallcap100: {
    ticker: "NIFTY_SMALLCAP", label: "Nifty SmallCap 100",
    yf: null, dhan: { securityId: "3", exchangeSegment: "IDX_I" },
    // Dhan only has SmallCap data from 2019. Pre-2019 history must come from CSV import.
    allTimeStart: new Date("2019-01-13"), minRows: 1500,
  },
};

// ─── Gap-fill helpers ─────────────────────────────────────────────────────────

const gapFillCooldown = new Map<string, number>();
const gapFillPromises = new Map<string, Promise<void>>();

async function gapFillViaYahoo(cfg: IndexConfig, assetId: string, fromDate: Date): Promise<number> {
  const todayUtc = new Date(); todayUtc.setUTCHours(0, 0, 0, 0);
  const period1  = Math.floor(fromDate.getTime() / 1000);
  const period2  = Math.floor(todayUtc.getTime() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${cfg.yf}?interval=1d&period1=${period1}&period2=${period2}`;

  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) return 0;

  const json = await resp.json() as {
    chart: { result: Array<{
      timestamp: number[];
      indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> };
    }> | null };
  };
  const result = json?.chart?.result?.[0];
  if (!result) return 0;

  const { timestamp, indicators } = result;
  const q         = indicators.quote[0];
  const lastKnown = fromDate.toISOString().slice(0, 10);
  const rows: { assetId: string; timestamp: Date; open: number; high: number; low: number; close: number; volume: number; source: string }[] = [];

  for (let i = 0; i < timestamp.length; i++) {
    if (q.close[i] == null) continue;
    const barDate = new Date(timestamp[i] * 1000);
    barDate.setUTCHours(0, 0, 0, 0);
    if (barDate.toISOString().slice(0, 10) <= lastKnown) continue;
    rows.push({
      assetId, timestamp: barDate,
      open: q.open[i] ?? q.close[i], high: q.high[i] ?? q.close[i],
      low:  q.low[i]  ?? q.close[i], close: q.close[i],
      volume: q.volume[i] ?? 0, source: "yfinance_gapfill",
    });
  }
  if (rows.length > 0) await prisma.priceData.createMany({ data: rows, skipDuplicates: true });
  return rows.length;
}

async function gapFillViaDhan(cfg: IndexConfig, assetId: string, fromDate: Date): Promise<number> {
  const dhanToken = await getDhanToken();
  if (!dhanToken || !cfg.dhan) return 0;

  const todayUtc   = new Date(); todayUtc.setUTCHours(0, 0, 0, 0);
  const CHUNK_MS   = 365 * 86_400_000;
  let   chunkEnd   = new Date(todayUtc);
  let   chunkStart = new Date(Math.max(fromDate.getTime(), chunkEnd.getTime() - CHUNK_MS));
  let   total      = 0;

  while (chunkStart >= fromDate) {
    const body = {
      securityId:      cfg.dhan.securityId,
      exchangeSegment: cfg.dhan.exchangeSegment,
      instrument:      "INDEX",
      expiryCode:      0,
      fromDate:        chunkStart.toISOString().slice(0, 10),
      toDate:          chunkEnd.toISOString().slice(0, 10),
    };
    const resp = await fetch("https://api.dhan.co/v2/charts/historical", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "access-token": dhanToken },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10_000),
    });
    if (!resp.ok) break;

    const json = await resp.json() as {
      open?: number[]; high?: number[]; low?: number[]; close?: number[];
      volume?: number[]; timestamp?: number[];
    };
    if (!json.close?.length || !json.timestamp?.length) break;

    const lastKnown = fromDate.toISOString().slice(0, 10);
    const rows: { assetId: string; timestamp: Date; open: number; high: number; low: number; close: number; volume: number; source: string }[] = [];
    for (let i = 0; i < json.timestamp.length; i++) {
      if (json.close[i] == null) continue;
      const barDate = new Date(json.timestamp[i] * 1000);
      barDate.setUTCHours(0, 0, 0, 0);
      if (barDate.toISOString().slice(0, 10) <= lastKnown) continue;
      rows.push({
        assetId, timestamp: barDate,
        open:   json.open?.[i]   ?? json.close[i],
        high:   json.high?.[i]   ?? json.close[i],
        low:    json.low?.[i]    ?? json.close[i],
        close:  json.close[i],
        volume: json.volume?.[i] ?? 0,
        source: "dhan_gapfill",
      });
    }
    if (rows.length > 0) { await prisma.priceData.createMany({ data: rows, skipDuplicates: true }); total += rows.length; }

    chunkEnd   = new Date(chunkStart.getTime() - 86_400_000);
    chunkStart = new Date(Math.max(fromDate.getTime(), chunkEnd.getTime() - CHUNK_MS));
    if (chunkEnd < fromDate) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return total;
}

async function gapFillIndex(cfg: IndexConfig): Promise<void> {
  const now = Date.now();
  if ((now - (gapFillCooldown.get(cfg.ticker) ?? 0)) < 60 * 60 * 1000) return;

  try {
    const [rowCount, latest] = await Promise.all([
      prisma.priceData.count({ where: { asset: { ticker: cfg.ticker } } }),
      prisma.priceData.findFirst({
        where: { asset: { ticker: cfg.ticker } },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
    ]);

    const todayUtc = new Date(); todayUtc.setUTCHours(0, 0, 0, 0);
    let fromDate: Date | null = null;
    if (rowCount < cfg.minRows) {
      fromDate = cfg.allTimeStart;
    } else if (latest) {
      const diffDays = (todayUtc.getTime() - latest.timestamp.getTime()) / 86_400_000;
      if (diffDays >= 1) fromDate = latest.timestamp;
    }
    if (!fromDate) { gapFillCooldown.set(cfg.ticker, now); return; }

    const asset = await prisma.asset.upsert({
      where:  { ticker: cfg.ticker },
      update: {},
      create: { ticker: cfg.ticker, name: cfg.label, assetClass: "EQUITY", currency: "INR" },
      select: { id: true },
    });

    let added = 0;
    if (cfg.yf)   added = await gapFillViaYahoo(cfg, asset.id, fromDate);
    else if (cfg.dhan) added = await gapFillViaDhan(cfg, asset.id, fromDate);

    if (added > 0) console.log(`[rsi/gap-fill] ${cfg.ticker}: +${added} bars`);
    gapFillCooldown.set(cfg.ticker, now);
  } catch (err) {
    console.warn(`[rsi/gap-fill] ${cfg.ticker} failed:`, err);
  }
}

// ─── Monthly aggregation ──────────────────────────────────────────────────────

function toMonthly(
  bars: { date: string; open: number; high: number; low: number; close: number }[],
): RsiMonthlyBar[] {
  const groups = new Map<string, RsiMonthlyBar>();
  for (const b of bars) {
    const key = b.date.slice(0, 7) + "-01";
    const ex  = groups.get(key);
    if (!ex) {
      groups.set(key, { date: key, open: b.open, high: b.high, low: b.low, close: b.close });
    } else {
      ex.high  = Math.max(ex.high, b.high);
      ex.low   = Math.min(ex.low,  b.low);
      ex.close = b.close;
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── RSI(14) — Wilder smoothing ───────────────────────────────────────────────

function computeRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  const rsiAt = (ag: number, al: number) =>
    al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));

  result[period] = rsiAt(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d    = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = rsiAt(avgGain, avgLoss);
  }

  return result;
}

// ─── Zone classification ──────────────────────────────────────────────────────

function getZone(rsi: number): RsiZone {
  if (rsi >= 80) return { label: "Extreme",         color: "#ef4444", bgColor: "rgba(239,68,68,0.10)",    value: rsi };
  if (rsi >= 70) return { label: "Elevated",        color: "#f97316", bgColor: "rgba(249,115,22,0.10)",   value: rsi };
  if (rsi >= 40) return { label: "Normal",           color: "#3b82f6", bgColor: "rgba(59,130,246,0.10)",   value: rsi };
  if (rsi >= 30) return { label: "Oversold",        color: "#f59e0b", bgColor: "rgba(245,158,11,0.10)",   value: rsi };
  return          { label: "Extreme Oversold",      color: "#10b981", bgColor: "rgba(16,185,129,0.10)",   value: rsi };
}

// ─── Signal engine ────────────────────────────────────────────────────────────

function getSignal(rsi: number, prev: number, summary: RsiOutcomeSummary): RsiSignal {
  const trend = rsi > prev ? "rising" : rsi < prev ? "falling" : "flat";
  const ob = summary.ob80;
  const os = summary.os35;

  if (rsi >= 85) return {
    label: "Extreme Overbought",
    bias: "Strong Bearish", confidence: 82,
    signal: "Avoid fresh buying · Consider partial profit booking",
    rationale: `RSI at ${rsi.toFixed(1)} — deep in extreme territory. ${
      ob ? `Historically, 6M avg return after such events is ${ob.avgRet6m > 0 ? "+" : ""}${ob.avgRet6m}% with ${ob.avgMaxDrawdown.toFixed(1)}% avg max drawdown.` : "Market severely overbought."
    }`,
  };

  if (rsi >= 80) return {
    label: "Overbought — Caution",
    bias: "Bearish", confidence: 72,
    signal: "Reduce aggression · Tighten stop-losses",
    rationale: `RSI crossed 80 threshold${trend === "rising" ? " and still rising" : trend === "falling" ? " and now pulling back" : ""}. ${
      ob ? `Past ${ob.totalEvents} events averaged ${ob.avgRet3m > 0 ? "+" : ""}${ob.avgRet3m}% over 3M.` : "Elevated correction risk."
    }`,
  };

  if (rsi >= 75) return {
    label: "Near Extreme — Watch",
    bias: "Caution", confidence: 60,
    signal: "Monitor closely · Avoid chasing momentum",
    rationale: "RSI approaching 80 extreme zone. Momentum strong but historically corrections begin here.",
  };

  if (rsi >= 60) return {
    label: "Bullish Momentum",
    bias: "Neutral", confidence: 50,
    signal: "Trend intact · Hold existing positions",
    rationale: "RSI in upper-normal range. Healthy trend — not overextended yet.",
  };

  if (rsi <= 30) return {
    label: "Oversold — Opportunity",
    bias: "Bullish", confidence: 68,
    signal: "Watch for reversal · Accumulate on strength",
    rationale: `RSI in oversold territory. ${
      os ? `Past ${os.totalEvents} oversold events averaged ${os.avgRet12m > 0 ? "+" : ""}${os.avgRet12m}% over 12M.` : "Historically marks generational buying zones."
    }`,
  };

  return {
    label: "Neutral Range",
    bias: "Neutral", confidence: 45,
    signal: "No extreme signal · Wait for clear setup",
    rationale: "RSI in normal range. No extreme conditions present.",
  };
}

// ─── Event building (anchor fix: returns from exit price) ─────────────────────

function buildEvent(
  bars:      RsiMonthlyBar[],
  rsiValues: (number | null)[],
  startIdx:  number,
  endIdx:    number,
  type:      "overbought" | "oversold",
): RsiExtremeEvent {
  let peakRsi = type === "overbought" ? -Infinity : Infinity;
  let peakIdx = startIdx;
  for (let i = startIdx; i <= endIdx; i++) {
    const r = rsiValues[i];
    if (r === null) continue;
    if (type === "overbought" ? r > peakRsi : r < peakRsi) { peakRsi = r; peakIdx = i; }
  }

  const niftyAtStart = bars[startIdx].close;   // entry price — display only
  const exitClose    = bars[endIdx].close;       // exit price — return baseline
  const duration     = endIdx - startIdx + 1;

  const fwdClose = (offset: number): number | null => {
    const idx = endIdx + offset;
    return idx < bars.length ? bars[idx].close : null;
  };
  // Anchor: after the zone was exited, what happened over 3/6/12/18 months?
  const ret = (c: number | null) =>
    c !== null ? parseFloat(((c - exitClose) / exitClose * 100).toFixed(2)) : null;

  let maxDrawdown: number | null = null;
  for (let d = 1; d <= 18; d++) {
    const c = fwdClose(d);
    if (c === null) break;
    const dd = (c - exitClose) / exitClose * 100;
    if (maxDrawdown === null || dd < maxDrawdown) maxDrawdown = dd;
  }

  return {
    startDate:    bars[startIdx].date,
    endDate:      bars[endIdx].date,
    peakRsi:      parseFloat(peakRsi.toFixed(2)),
    peakDate:     bars[peakIdx].date,
    duration,
    kind:         duration >= 2 ? "sustained" : "brief",
    type,
    niftyAtStart: parseFloat(niftyAtStart.toFixed(2)),
    niftyAtExit:  parseFloat(exitClose.toFixed(2)),
    ret3m:        ret(fwdClose(3)),
    ret6m:        ret(fwdClose(6)),
    ret12m:       ret(fwdClose(12)),
    ret18m:       ret(fwdClose(18)),
    maxDrawdown:  maxDrawdown !== null ? parseFloat(maxDrawdown.toFixed(2)) : null,
  };
}

// ─── Per-threshold stats builder ─────────────────────────────────────────────

function buildThresholdStats(
  monthlyBars: RsiMonthlyBar[],
  rsiValues:   (number | null)[],
  threshold:   number,
  type:        "overbought" | "oversold",
): RsiThresholdStats | null {
  const evts: RsiExtremeEvent[] = [];
  const inZone = (rsi: number) => type === "overbought" ? rsi >= threshold : rsi <= threshold;
  let inEvent = false, eventStart = -1;

  for (let i = 0; i < monthlyBars.length; i++) {
    const rsi = rsiValues[i];
    if (rsi === null) continue;
    if (!inEvent && inZone(rsi))       { inEvent = true; eventStart = i; }
    else if (inEvent && !inZone(rsi))  { evts.push(buildEvent(monthlyBars, rsiValues, eventStart, i - 1, type)); inEvent = false; }
  }
  if (inEvent) evts.push(buildEvent(monthlyBars, rsiValues, eventStart, monthlyBars.length - 1, type));

  if (evts.length < 1) return null;

  const avg = (arr: (number | null)[]) => {
    const v = arr.filter((x): x is number => x !== null);
    return v.length ? parseFloat((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)) : 0;
  };
  const wr = (arr: (number | null)[]) => {
    const v = arr.filter((x): x is number => x !== null);
    return v.length ? Math.round(v.filter((x) => x > 0).length / v.length * 100) : 0;
  };

  return {
    totalEvents:    evts.length,
    avgRet3m:       avg(evts.map((e) => e.ret3m)),
    avgRet6m:       avg(evts.map((e) => e.ret6m)),
    avgRet12m:      avg(evts.map((e) => e.ret12m)),
    avgRet18m:      avg(evts.map((e) => e.ret18m)),
    winRate3m:      wr(evts.map((e) => e.ret3m)),
    winRate6m:      wr(evts.map((e) => e.ret6m)),
    winRate12m:     wr(evts.map((e) => e.ret12m)),
    winRate18m:     wr(evts.map((e) => e.ret18m)),
    avgMaxDrawdown: avg(evts.map((e) => e.maxDrawdown)),
  };
}

function computeSummary(monthlyBars: RsiMonthlyBar[], rsiValues: (number | null)[]): RsiOutcomeSummary {
  return {
    ob80: buildThresholdStats(monthlyBars, rsiValues, 80, "overbought"),
    ob70: buildThresholdStats(monthlyBars, rsiValues, 70, "overbought"),
    os35: buildThresholdStats(monthlyBars, rsiValues, 35, "oversold"),
    os50: buildThresholdStats(monthlyBars, rsiValues, 50, "oversold"),
  };
}

// ─── Primary extreme events for chart markers (>80 overbought, <30 oversold) ──

function detectPrimaryEvents(
  monthlyBars: RsiMonthlyBar[],
  rsiValues:   (number | null)[],
): RsiExtremeEvent[] {
  const events: RsiExtremeEvent[] = [];

  const detect = (threshold: number, type: "overbought" | "oversold") => {
    const inZone = (rsi: number) => type === "overbought" ? rsi >= threshold : rsi <= threshold;
    let inEvent = false, eventStart = -1;
    for (let i = 0; i < monthlyBars.length; i++) {
      const rsi = rsiValues[i];
      if (rsi === null) continue;
      if (!inEvent && inZone(rsi))      { inEvent = true; eventStart = i; }
      else if (inEvent && !inZone(rsi)) { events.push(buildEvent(monthlyBars, rsiValues, eventStart, i - 1, type)); inEvent = false; }
    }
    if (inEvent) events.push(buildEvent(monthlyBars, rsiValues, eventStart, monthlyBars.length - 1, type));
  };

  detect(80, "overbought");
  detect(30, "oversold");

  return events.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const indexKey = (searchParams.get("index") ?? "nifty50") as RsiIndex;
  const cfg = INDEX_CONFIG[indexKey] ?? INDEX_CONFIG.nifty50;

  // Gap-fill in background (deduplicated, 1h cooldown)
  if (!gapFillPromises.has(cfg.ticker)) {
    const p = gapFillIndex(cfg).finally(() => gapFillPromises.delete(cfg.ticker));
    gapFillPromises.set(cfg.ticker, p);
  }
  try { await Promise.race([gapFillPromises.get(cfg.ticker)!, new Promise<void>((r) => setTimeout(r, 5000))]); }
  catch { /* non-fatal */ }

  try {
    const asset = await prisma.asset.findUnique({
      where:   { ticker: cfg.ticker },
      include: { priceData: { orderBy: { timestamp: "desc" }, take: 6000 } },
    });

    if (!asset || asset.priceData.length < 20) {
      return NextResponse.json({ hasData: false } satisfies Partial<RsiResponse>);
    }

    const dailyBars = asset.priceData.slice().reverse().map((r) => ({
      date:  r.timestamp.toISOString().slice(0, 10),
      open:  r.open, high: r.high, low: r.low, close: r.close,
    }));

    const monthlyBars = toMonthly(dailyBars);
    if (monthlyBars.length < 20) return NextResponse.json({ hasData: false } satisfies Partial<RsiResponse>);

    const closes    = monthlyBars.map((b) => b.close);
    const rsiValues = computeRSI(closes, 14);

    const rsiBars: RsiBar[] = [];
    for (let i = 0; i < monthlyBars.length; i++) {
      const r = rsiValues[i];
      if (r !== null) rsiBars.push({ date: monthlyBars[i].date, rsi: r });
    }

    const currentRsi = rsiBars.at(-1)?.rsi ?? 50;
    const prevRsi    = rsiBars.at(-2)?.rsi ?? currentRsi;
    const change     = parseFloat((currentRsi - prevRsi).toFixed(2));

    const extremeEvents = detectPrimaryEvents(monthlyBars, rsiValues);
    const summary       = computeSummary(monthlyBars, rsiValues);
    const zone          = getZone(currentRsi);
    const signal        = getSignal(currentRsi, prevRsi, summary);

    return NextResponse.json({
      hasData: true,
      niftyBars:  monthlyBars,
      rsiBars,
      extremeEvents,
      summary,
      zone,
      signal,
      currentRsi:  parseFloat(currentRsi.toFixed(2)),
      prevRsi:     parseFloat(prevRsi.toFixed(2)),
      change,
      indexLabel:  cfg.label,
    } satisfies RsiResponse);

  } catch (err) {
    console.error("[GET /api/rsi]", err);
    return NextResponse.json({ error: "RSI engine failed" }, { status: 500 });
  }
}
