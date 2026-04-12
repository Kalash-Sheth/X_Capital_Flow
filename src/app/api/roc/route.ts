// GET /api/roc
// Nifty 18-Month Rate of Change Intelligence Engine
// Monthly ROC(18) · Extreme zone detection · Forward return analysis

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getDhanToken } from "@/lib/dhan-auth";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RocMonthlyBar {
  date:  string;   // YYYY-MM-01
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export interface RocBar {
  date: string;   // YYYY-MM-01
  roc:  number;   // percent, e.g. 45.2 means +45.2% over 18 months
}

export interface RocExtremeEvent {
  startDate:    string;
  endDate:      string;
  peakRoc:      number;
  peakDate:     string;
  duration:     number;   // months in zone
  kind:         "sustained" | "brief";
  type:         "overbought" | "oversold";
  niftyAtStart: number;
  ret3m:        number | null;
  ret6m:        number | null;
  ret12m:       number | null;
  ret18m:       number | null;
  maxDrawdown:  number | null;  // worst close in next 18 months vs entry
}

export interface RocOutcomeSummary {
  overbought: {
    totalEvents:   number;
    avgRet3m:      number;  avgRet6m:      number;
    avgRet12m:     number;  avgRet18m:     number;
    winRate3m:     number;  winRate6m:     number;
    winRate12m:    number;  winRate18m:    number;
    avgMaxDrawdown: number;
  } | null;
  oversold: {
    totalEvents:   number;
    avgRet3m:      number;  avgRet6m:      number;
    avgRet12m:     number;  avgRet18m:     number;
    winRate3m:     number;  winRate6m:     number;
    winRate12m:    number;  winRate18m:    number;
    avgMaxDrawdown: number;
  } | null;
}

export interface RocZone {
  label:   "Extreme Bull" | "Strong Bull" | "Moderate" | "Weak / Negative" | "Extreme Bear";
  color:   string;
  bgColor: string;
  value:   number;
}

export interface RocSignal {
  label:      string;
  bias:       "Strong Bearish" | "Bearish" | "Caution" | "Neutral" | "Bullish" | "Strong Bullish";
  confidence: number;
  signal:     string;
  rationale:  string;
}

export interface RocResponse {
  niftyBars:       RocMonthlyBar[];
  rocBars:         RocBar[];
  extremeEvents:   RocExtremeEvent[];
  summary:         RocOutcomeSummary;
  zone:            RocZone;
  signal:          RocSignal;
  currentRoc:      number;
  prevRoc:         number;
  change:          number;
  percentileRank:  number;   // 0–100: where current ROC sits in history
  hasData:         boolean;
}

// ─── Monthly aggregation ──────────────────────────────────────────────────────

function toMonthly(
  bars: { date: string; open: number; high: number; low: number; close: number }[],
): RocMonthlyBar[] {
  const groups = new Map<string, RocMonthlyBar>();
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

// ─── ROC(18) computation ──────────────────────────────────────────────────────

function computeROC(closes: number[], period = 18): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const base = closes[i - period];
    if (base === 0) continue;
    result[i] = parseFloat(((closes[i] - base) / base * 100).toFixed(2));
  }
  return result;
}

// ─── Percentile rank ─────────────────────────────────────────────────────────

function percentileRank(values: number[], current: number): number {
  if (values.length === 0) return 50;
  const below = values.filter((v) => v < current).length;
  return Math.round((below / values.length) * 100);
}

// ─── Zone classification ──────────────────────────────────────────────────────

function getZone(roc: number): RocZone {
  if (roc >= 80)  return { label: "Extreme Bull",      color: "#ef4444", bgColor: "rgba(239,68,68,0.10)",    value: roc };
  if (roc >= 30)  return { label: "Strong Bull",       color: "#f97316", bgColor: "rgba(249,115,22,0.10)",   value: roc };
  if (roc >= 0)   return { label: "Moderate",          color: "#3b82f6", bgColor: "rgba(59,130,246,0.10)",   value: roc };
  if (roc >= -25) return { label: "Weak / Negative",   color: "#f59e0b", bgColor: "rgba(245,158,11,0.10)",   value: roc };
  return           { label: "Extreme Bear",            color: "#10b981", bgColor: "rgba(16,185,129,0.10)",   value: roc };
}

// ─── Signal engine ────────────────────────────────────────────────────────────

function getSignal(roc: number, prev: number, pct: number, summary: RocOutcomeSummary): RocSignal {
  const trend = roc > prev ? "rising" : roc < prev ? "falling" : "flat";
  const ob = summary.overbought;
  const os = summary.oversold;

  if (roc >= 100) return {
    label: "Euphoric Bull — Reversal Risk",
    bias: "Strong Bearish", confidence: 85,
    signal: "Avoid fresh longs · Book profits",
    rationale: `18M ROC at ${roc.toFixed(1)}% — highest decile of all readings. ${
      ob ? `Past ${ob.totalEvents} overbought events saw avg 18M forward return of ${ob.avgRet18m > 0 ? "+" : ""}${ob.avgRet18m}% with ${ob.avgMaxDrawdown.toFixed(1)}% avg drawdown.` : "Market pricing in maximum optimism."
    }`,
  };

  if (roc >= 80) return {
    label: "Extreme Overbought",
    bias: "Bearish", confidence: 75,
    signal: "Reduce exposure · Tighten stops",
    rationale: `18M ROC crossed 80% threshold${trend === "rising" ? " and still accelerating" : trend === "falling" ? " and now decelerating" : ""}. ${
      ob ? `${ob.totalEvents} historical overbought events averaged ${ob.avgRet12m > 0 ? "+" : ""}${ob.avgRet12m}% over 12M.` : "Elevated mean-reversion risk."
    } Percentile rank: ${pct}th.`,
  };

  if (roc >= 50) return {
    label: "Strong Bull Momentum",
    bias: "Caution", confidence: 60,
    signal: "Hold longs · Watch for deceleration",
    rationale: `18M ROC at ${roc.toFixed(1)}% — strong but not extreme. Watch if momentum starts decelerating toward 30% zone. Percentile: ${pct}th.`,
  };

  if (roc >= 0) return {
    label: "Positive Momentum",
    bias: "Neutral", confidence: 50,
    signal: "Trend intact · No extreme signal",
    rationale: `18M ROC at ${roc.toFixed(1)}% — positive but moderate. Market in healthy uptrend zone. No actionable extreme signal.`,
  };

  if (roc >= -25) return {
    label: "Weak / Negative Momentum",
    bias: "Caution", confidence: 55,
    signal: "Reduce risk · Watch for stabilisation",
    rationale: `18M ROC at ${roc.toFixed(1)}% — negative territory. Trend is down. Wait for ROC to base out and turn positive before adding exposure.`,
  };

  return {
    label: "Deep Bear — Potential Opportunity",
    bias: "Strong Bullish", confidence: 70,
    signal: "Watch for reversal · Accumulate on strength",
    rationale: `18M ROC at ${roc.toFixed(1)}% — extreme negative. ${
      os ? `Past ${os.totalEvents} oversold events averaged ${os.avgRet18m > 0 ? "+" : ""}${os.avgRet18m}% over the next 18M with ${os.winRate18m}% win rate.` : "Historically marks generational buying zones in Nifty."
    }`,
  };
}

// ─── Extreme event detection ──────────────────────────────────────────────────

function detectExtremeEvents(
  monthlyBars: RocMonthlyBar[],
  rocValues:   (number | null)[],
  obThreshold = 80,
  osThreshold = -25,
): RocExtremeEvent[] {
  const events: RocExtremeEvent[] = [];

  const detect = (threshold: number, type: "overbought" | "oversold") => {
    const above = (roc: number) => type === "overbought" ? roc >= threshold : roc <= threshold;
    let inEvent = false, eventStart = -1;

    for (let i = 0; i < monthlyBars.length; i++) {
      const roc = rocValues[i];
      if (roc === null) continue;
      if (!inEvent && above(roc))  { inEvent = true; eventStart = i; }
      else if (inEvent && !above(roc)) {
        events.push(buildEvent(monthlyBars, rocValues, eventStart, i - 1, type));
        inEvent = false;
      }
    }
    if (inEvent) events.push(buildEvent(monthlyBars, rocValues, eventStart, monthlyBars.length - 1, type));
  };

  detect(obThreshold, "overbought");
  detect(osThreshold, "oversold");

  return events.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function buildEvent(
  bars:      RocMonthlyBar[],
  rocValues: (number | null)[],
  startIdx:  number,
  endIdx:    number,
  type:      "overbought" | "oversold",
): RocExtremeEvent {
  let peakRoc = type === "overbought" ? -Infinity : Infinity;
  let peakIdx = startIdx;
  for (let i = startIdx; i <= endIdx; i++) {
    const r = rocValues[i];
    if (r === null) continue;
    if (type === "overbought" ? r > peakRoc : r < peakRoc) { peakRoc = r; peakIdx = i; }
  }

  const entryClose = bars[startIdx].close;
  const duration   = endIdx - startIdx + 1;

  const fwdClose = (offset: number): number | null => {
    const idx = endIdx + offset;
    return idx < bars.length ? bars[idx].close : null;
  };
  const ret = (c: number | null) =>
    c !== null ? parseFloat(((c - entryClose) / entryClose * 100).toFixed(2)) : null;

  const c3  = fwdClose(3);
  const c6  = fwdClose(6);
  const c12 = fwdClose(12);
  const c18 = fwdClose(18);

  let maxDrawdown: number | null = null;
  for (let d = 1; d <= 18; d++) {
    const c = fwdClose(d);
    if (c === null) break;
    const dd = (c - entryClose) / entryClose * 100;
    if (maxDrawdown === null || dd < maxDrawdown) maxDrawdown = dd;
  }

  return {
    startDate:    bars[startIdx].date,
    endDate:      bars[endIdx].date,
    peakRoc:      parseFloat(peakRoc.toFixed(2)),
    peakDate:     bars[peakIdx].date,
    duration,
    kind:         duration >= 2 ? "sustained" : "brief",
    type,
    niftyAtStart: parseFloat(entryClose.toFixed(2)),
    ret3m:  ret(c3),  ret6m:  ret(c6),
    ret12m: ret(c12), ret18m: ret(c18),
    maxDrawdown: maxDrawdown !== null ? parseFloat(maxDrawdown.toFixed(2)) : null,
  };
}

function computeSummary(events: RocExtremeEvent[]): RocOutcomeSummary {
  const avg = (arr: (number | null)[]): number => {
    const valid = arr.filter((v): v is number => v !== null);
    return valid.length ? parseFloat((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(2)) : 0;
  };
  const winRate = (arr: (number | null)[]): number => {
    const valid = arr.filter((v): v is number => v !== null);
    return valid.length ? Math.round(valid.filter((v) => v > 0).length / valid.length * 100) : 0;
  };
  const build = (evts: RocExtremeEvent[]) => {
    if (evts.length < 1) return null;
    return {
      totalEvents:    evts.length,
      avgRet3m:       avg(evts.map((e) => e.ret3m)),
      avgRet6m:       avg(evts.map((e) => e.ret6m)),
      avgRet12m:      avg(evts.map((e) => e.ret12m)),
      avgRet18m:      avg(evts.map((e) => e.ret18m)),
      winRate3m:      winRate(evts.map((e) => e.ret3m)),
      winRate6m:      winRate(evts.map((e) => e.ret6m)),
      winRate12m:     winRate(evts.map((e) => e.ret12m)),
      winRate18m:     winRate(evts.map((e) => e.ret18m)),
      avgMaxDrawdown: avg(evts.map((e) => e.maxDrawdown)),
    };
  };
  return {
    overbought: build(events.filter((e) => e.type === "overbought")),
    oversold:   build(events.filter((e) => e.type === "oversold")),
  };
}

// ─── Index config ─────────────────────────────────────────────────────────────

export type RocIndex = "nifty50" | "nifty500" | "smallcap100";

interface IndexConfig {
  ticker:       string;
  label:        string;
  // Yahoo Finance encoded symbol — null if not available on Yahoo
  yf:           string | null;
  // Dhan API config — null if not on Dhan
  dhan:         { securityId: string; exchangeSegment: string } | null;
  allTimeStart: Date;   // earliest date the source has data
  minRows:      number;
}

const INDEX_CONFIG: Record<RocIndex, IndexConfig> = {
  // Yahoo ^NSEI goes back to 2000; also on Dhan but Yahoo is richer history
  nifty50: {
    ticker: "NIFTY50", label: "Nifty 50",
    yf: "%5ENSEI", dhan: null,
    allTimeStart: new Date("2000-01-01"), minRows: 5000,
  },
  // ^CRSLDX is Yahoo's symbol for Nifty 500 — data from 2005-09-26
  nifty500: {
    ticker: "NIFTY500", label: "Nifty 500",
    yf: "%5ECRSLDX", dhan: null,
    allTimeStart: new Date("2005-09-01"), minRows: 3000,
  },
  // Yahoo ^CNXSC has no history; use Dhan (securityId 3 = Nifty SmallCap 250/100)
  // Dhan history confirmed available from 2019-01-13
  smallcap100: {
    ticker: "NIFTY_SMALLCAP", label: "Nifty SmallCap 100",
    yf: null, dhan: { securityId: "3", exchangeSegment: "IDX_I" },
    allTimeStart: new Date("2019-01-01"), minRows: 1500,
  },
};

// ─── Gap-fill helpers ─────────────────────────────────────────────────────────

const gapFillCooldown = new Map<string, number>();
const gapFillPromises = new Map<string, Promise<void>>();

/** Fetch from Yahoo Finance v8 chart API and upsert into DB */
async function gapFillViaYahoo(
  cfg: IndexConfig,
  assetId: string,
  fromDate: Date,
): Promise<number> {
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
  const q          = indicators.quote[0];
  const lastKnown  = fromDate.toISOString().slice(0, 10);

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

/** Fetch from Dhan historical API in 365-day chunks and upsert into DB */
async function gapFillViaDhan(
  cfg: IndexConfig,
  assetId: string,
  fromDate: Date,
): Promise<number> {
  const dhanToken = await getDhanToken();
  if (!dhanToken || !cfg.dhan) return 0;

  const todayUtc  = new Date(); todayUtc.setUTCHours(0, 0, 0, 0);
  const CHUNK_MS  = 365 * 86_400_000;
  let   chunkEnd  = new Date(todayUtc);
  let   chunkStart= new Date(Math.max(fromDate.getTime(), chunkEnd.getTime() - CHUNK_MS));
  let   total     = 0;

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
    if (rows.length > 0) {
      await prisma.priceData.createMany({ data: rows, skipDuplicates: true });
      total += rows.length;
    }

    chunkEnd   = new Date(chunkStart.getTime() - 86_400_000);
    chunkStart = new Date(Math.max(fromDate.getTime(), chunkEnd.getTime() - CHUNK_MS));
    if (chunkEnd < fromDate) break;

    await new Promise((r) => setTimeout(r, 400)); // rate-limit delay
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

    // Ensure asset row exists
    const asset = await prisma.asset.upsert({
      where:  { ticker: cfg.ticker },
      update: {},
      create: { ticker: cfg.ticker, name: cfg.label, assetClass: "EQUITY", currency: "INR" },
      select: { id: true },
    });

    let added = 0;
    if (cfg.yf) {
      added = await gapFillViaYahoo(cfg, asset.id, fromDate);
    } else if (cfg.dhan) {
      added = await gapFillViaDhan(cfg, asset.id, fromDate);
    }

    if (added > 0) console.log(`[roc/gap-fill] ${cfg.ticker}: +${added} bars`);
    gapFillCooldown.set(cfg.ticker, now);
  } catch (err) {
    console.warn(`[roc/gap-fill] ${cfg.ticker} failed:`, err);
  }
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const indexKey = (searchParams.get("index") ?? "nifty50") as RocIndex;
  const cfg = INDEX_CONFIG[indexKey] ?? INDEX_CONFIG.nifty50;

  // Gap-fill in background (deduplicated)
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
      return NextResponse.json({ hasData: false } satisfies Partial<RocResponse>);
    }

    const dailyBars = asset.priceData.slice().reverse().map((r) => ({
      date:  r.timestamp.toISOString().slice(0, 10),
      open:  r.open, high: r.high, low: r.low, close: r.close,
    }));

    const monthlyBars = toMonthly(dailyBars);
    if (monthlyBars.length < 25) return NextResponse.json({ hasData: false } satisfies Partial<RocResponse>);

    const closes    = monthlyBars.map((b) => b.close);
    const rocValues = computeROC(closes, 18);

    const rocBars: RocBar[] = [];
    for (let i = 0; i < monthlyBars.length; i++) {
      const r = rocValues[i];
      if (r !== null) rocBars.push({ date: monthlyBars[i].date, roc: r });
    }

    const currentRoc = rocBars.at(-1)?.roc ?? 0;
    const prevRoc    = rocBars.at(-2)?.roc ?? currentRoc;
    const change     = parseFloat((currentRoc - prevRoc).toFixed(2));

    const allRocValues  = rocBars.map((b) => b.roc);
    const pctRank       = percentileRank(allRocValues.slice(0, -1), currentRoc);

    const extremeEvents = detectExtremeEvents(monthlyBars, rocValues);
    const summary       = computeSummary(extremeEvents);
    const zone          = getZone(currentRoc);
    const signal        = getSignal(currentRoc, prevRoc, pctRank, summary);

    return NextResponse.json({
      hasData: true,
      niftyBars:      monthlyBars,
      rocBars,
      extremeEvents,
      summary,
      zone,
      signal,
      currentRoc:     parseFloat(currentRoc.toFixed(2)),
      prevRoc:        parseFloat(prevRoc.toFixed(2)),
      change,
      percentileRank: pctRank,
    } satisfies RocResponse);

  } catch (err) {
    console.error("[GET /api/roc]", err);
    return NextResponse.json({ error: "ROC engine failed" }, { status: 500 });
  }
}
