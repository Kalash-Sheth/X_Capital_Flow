// GET /api/rsi
// Nifty RSI Extremes Intelligence Engine
// Monthly RSI(14) · Extreme event detection · Forward return analysis

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
  startDate:    string;   // first month RSI crossed above 80
  endDate:      string;   // last month RSI was above 80
  peakRsi:      number;
  peakDate:     string;
  duration:     number;   // months above 80
  kind:         "sustained" | "brief";   // sustained = 2+ months, brief = 1 month
  niftyAtStart: number;
  ret1m:        number | null;
  ret3m:        number | null;
  ret6m:        number | null;
  maxDrawdown:  number | null;  // worst close in next 6 months vs entry
}

export interface RsiOutcomeSummary {
  totalEvents:   number;
  avgRet1m:      number;  avgRet3m:      number;  avgRet6m:      number;
  winRate1m:     number;  winRate3m:     number;  winRate6m:     number;
  avgMaxDrawdown: number;
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
  niftyBars:     RsiMonthlyBar[];
  rsiBars:       RsiBar[];
  extremeEvents: RsiExtremeEvent[];
  summary:       RsiOutcomeSummary | null;
  zone:          RsiZone;
  signal:        RsiSignal;
  currentRsi:    number;
  prevRsi:       number;
  change:        number;
  hasData:       boolean;
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

function getSignal(rsi: number, prev: number, summary: RsiOutcomeSummary | null): RsiSignal {
  const trend = rsi > prev ? "rising" : rsi < prev ? "falling" : "flat";

  if (rsi >= 85) return {
    label: "Extreme Overbought",
    bias: "Strong Bearish", confidence: 82,
    signal: "Avoid fresh buying · Consider partial profit booking",
    rationale: `RSI at ${rsi.toFixed(1)} — deep in extreme territory. ${
      summary ? `Historically, 6M avg return after such events is ${summary.avgRet6m > 0 ? "+" : ""}${summary.avgRet6m}% with ${summary.avgMaxDrawdown.toFixed(1)}% avg max drawdown.` : "Market severely overbought."
    }`,
  };

  if (rsi >= 80) return {
    label: "Overbought — Caution",
    bias: "Bearish", confidence: 72,
    signal: "Reduce aggression · Tighten stop-losses",
    rationale: `RSI crossed 80 threshold${trend === "rising" ? " and still rising" : trend === "falling" ? " and now pulling back" : ""}. ${
      summary ? `Past ${summary.totalEvents} events averaged ${summary.avgRet3m > 0 ? "+" : ""}${summary.avgRet3m}% over 3 months.` : "Elevated correction risk."
    }`,
  };

  if (rsi >= 75) return {
    label: "Near Extreme — Watch",
    bias: "Caution", confidence: 60,
    signal: "Monitor closely · Avoid chasing momentum",
    rationale: "RSI approaching 80 extreme zone. Momentum strong but historically corrections begin here. Wait for RSI to cross 80 or pull back below 70 before taking fresh positions.",
  };

  if (rsi >= 60) return {
    label: "Bullish Momentum",
    bias: "Neutral", confidence: 50,
    signal: "Trend intact · Hold existing positions",
    rationale: "RSI in upper-normal range. Healthy trend — not overextended yet. Follow the momentum with defined stop-losses.",
  };

  if (rsi <= 30) return {
    label: "Oversold — Opportunity",
    bias: "Bullish", confidence: 68,
    signal: "Watch for reversal · Accumulate on strength",
    rationale: "RSI in oversold territory. Historically, deep RSI readings below 30 on monthly chart mark generational buying opportunities in Nifty.",
  };

  return {
    label: "Neutral Range",
    bias: "Neutral", confidence: 45,
    signal: "No extreme signal · Wait for clear setup",
    rationale: "RSI in normal range. No extreme overbought or oversold conditions. Watch for trend confirmation before positioning.",
  };
}

// ─── Extreme event detection + outcome measurement ────────────────────────────

function detectExtremeEvents(
  monthlyBars: RsiMonthlyBar[],
  rsiValues: (number | null)[],
  threshold = 80,
  minDuration = 1,   // 1 = capture all touches; kind="brief"|"sustained" differentiates
): RsiExtremeEvent[] {
  const events: RsiExtremeEvent[] = [];
  let inEvent = false;
  let eventStart = -1;

  for (let i = 0; i < monthlyBars.length; i++) {
    const rsi = rsiValues[i];
    if (rsi === null) continue;

    if (!inEvent && rsi >= threshold) {
      inEvent = true;
      eventStart = i;
    } else if (inEvent && rsi < threshold) {
      // Event ended
      const duration = i - eventStart;
      if (duration >= minDuration) {
        events.push(buildEvent(monthlyBars, rsiValues, eventStart, i - 1));
      }
      inEvent = false;
    }
  }
  // Handle open event at end of data
  if (inEvent) {
    const duration = monthlyBars.length - eventStart;
    if (duration >= minDuration) {
      events.push(buildEvent(monthlyBars, rsiValues, eventStart, monthlyBars.length - 1));
    }
  }

  return events;
}

function buildEvent(
  bars: RsiMonthlyBar[],
  rsiValues: (number | null)[],
  startIdx: number,
  endIdx: number,
): RsiExtremeEvent {
  // Find peak RSI within event
  let peakRsi = 0, peakIdx = startIdx;
  for (let i = startIdx; i <= endIdx; i++) {
    const r = rsiValues[i];
    if (r !== null && r > peakRsi) { peakRsi = r; peakIdx = i; }
  }

  const entryClose = bars[startIdx].close;
  const duration   = endIdx - startIdx + 1;

  // Forward returns: 1M = endIdx+1, 3M = endIdx+3, 6M = endIdx+6
  const fwdClose = (offset: number): number | null => {
    const idx = endIdx + offset;
    return idx < bars.length ? bars[idx].close : null;
  };
  const ret = (c: number | null) =>
    c !== null ? parseFloat(((c - entryClose) / entryClose * 100).toFixed(2)) : null;

  const c1 = fwdClose(1); const c3 = fwdClose(3); const c6 = fwdClose(6);

  // Max drawdown in 6 months after event end
  let maxDrawdown: number | null = null;
  for (let d = 1; d <= 6; d++) {
    const c = fwdClose(d);
    if (c === null) break;
    const dd = (c - entryClose) / entryClose * 100;
    if (maxDrawdown === null || dd < maxDrawdown) maxDrawdown = dd;
  }

  return {
    startDate:    bars[startIdx].date,
    endDate:      bars[endIdx].date,
    peakRsi:      parseFloat(peakRsi.toFixed(2)),
    peakDate:     bars[peakIdx].date,
    duration,
    kind:         duration >= 2 ? "sustained" : "brief",
    niftyAtStart: parseFloat(entryClose.toFixed(2)),
    ret1m: ret(c1), ret3m: ret(c3), ret6m: ret(c6),
    maxDrawdown:  maxDrawdown !== null ? parseFloat(maxDrawdown.toFixed(2)) : null,
  };
}

function computeSummary(events: RsiExtremeEvent[]): RsiOutcomeSummary | null {
  if (events.length < 2) return null;

  const avg = (arr: (number | null)[]): number => {
    const valid = arr.filter((v): v is number => v !== null);
    return valid.length ? parseFloat((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(2)) : 0;
  };
  const winRate = (arr: (number | null)[]): number => {
    const valid = arr.filter((v): v is number => v !== null);
    return valid.length ? Math.round(valid.filter((v) => v > 0).length / valid.length * 100) : 0;
  };

  return {
    totalEvents:    events.length,
    avgRet1m:       avg(events.map((e) => e.ret1m)),
    avgRet3m:       avg(events.map((e) => e.ret3m)),
    avgRet6m:       avg(events.map((e) => e.ret6m)),
    winRate1m:      winRate(events.map((e) => e.ret1m)),
    winRate3m:      winRate(events.map((e) => e.ret3m)),
    winRate6m:      winRate(events.map((e) => e.ret6m)),
    avgMaxDrawdown: avg(events.map((e) => e.maxDrawdown)),
  };
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const niftyAsset = await prisma.asset.findUnique({
      where:   { ticker: "NIFTY50" },
      include: { priceData: { orderBy: { timestamp: "desc" }, take: 6000 } },
    });

    if (!niftyAsset || niftyAsset.priceData.length < 20) {
      return NextResponse.json({ hasData: false } satisfies Partial<RsiResponse>);
    }

    // Chronological daily bars
    const dailyBars = niftyAsset.priceData.slice().reverse().map((r) => ({
      date:  r.timestamp.toISOString().slice(0, 10),
      open:  r.open, high: r.high, low: r.low, close: r.close,
    }));

    const monthlyBars = toMonthly(dailyBars);
    if (monthlyBars.length < 20) return NextResponse.json({ hasData: false } satisfies Partial<RsiResponse>);

    const closes    = monthlyBars.map((b) => b.close);
    const rsiValues = computeRSI(closes, 14);

    // Build RsiBar array (skip nulls for chart)
    const rsiBars: RsiBar[] = [];
    for (let i = 0; i < monthlyBars.length; i++) {
      const r = rsiValues[i];
      if (r !== null) rsiBars.push({ date: monthlyBars[i].date, rsi: r });
    }

    const currentRsi = rsiBars.at(-1)?.rsi ?? 50;
    const prevRsi    = rsiBars.at(-2)?.rsi ?? currentRsi;
    const change     = parseFloat((currentRsi - prevRsi).toFixed(2));

    const extremeEvents = detectExtremeEvents(monthlyBars, rsiValues);
    const summary       = computeSummary(extremeEvents);
    const zone          = getZone(currentRsi);
    const signal        = getSignal(currentRsi, prevRsi, summary);

    return NextResponse.json({
      hasData: true,
      niftyBars:     monthlyBars,
      rsiBars,
      extremeEvents,
      summary,
      zone,
      signal,
      currentRsi:    parseFloat(currentRsi.toFixed(2)),
      prevRsi:       parseFloat(prevRsi.toFixed(2)),
      change,
    } satisfies RsiResponse);

  } catch (err) {
    console.error("[GET /api/rsi]", err);
    return NextResponse.json({ error: "RSI engine failed" }, { status: 500 });
  }
}
