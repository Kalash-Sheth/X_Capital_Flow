// GET /api/bb?index=nifty50|nifty500|smallcap100
// Monthly Bollinger Band (20, 2) Engine
// Thesis: Every lower-BB touch on monthly TF → market higher 18M+ later

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BbIndex = "nifty50" | "nifty500" | "smallcap100";

export interface BbMonthlyBar {
  date:  string;
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export interface BbBar {
  date:     string;
  close:    number;
  upper:    number;
  middle:   number;  // SMA(20)
  lower:    number;
  percentB: number;  // (close - lower) / (upper - lower); <0 = below lower BB
  bandwidth: number; // (upper - lower) / middle * 100
}

export interface BbTouchEvent {
  date:         string;   // month of touch
  close:        number;
  lower:        number;
  percentB:     number;
  devFromLower: number;   // % below lower BB (negative = deeper below)
  ret6m:        number | null;
  ret12m:       number | null;
  ret18m:       number | null;
  ret24m:       number | null;
  maxDrawdown:  number | null;  // worst close in next 18M vs entry
}

export interface BbSummary {
  totalEvents:  number;
  winRate6m:    number;  avgRet6m:   number;
  winRate12m:   number;  avgRet12m:  number;
  winRate18m:   number;  avgRet18m:  number;
  winRate24m:   number;  avgRet24m:  number;
  avgMaxDrawdown: number;
  thesisScore:  number;  // winRate18m as the headline stat
}

export interface BbResponse {
  hasData:       boolean;
  indexKey:      BbIndex;
  indexLabel:    string;
  niftyBars:     BbMonthlyBar[];
  bbBars:        BbBar[];
  touchEvents:   BbTouchEvent[];
  summary:       BbSummary;
  currentPercentB: number;
  currentClose:  number;
  currentLower:  number;
  currentUpper:  number;
  currentMiddle: number;
  isTouching:    boolean;   // percentB <= 0
  isNearLower:   boolean;   // percentB < 0.2
  lastTouchDate: string | null;
}

// ─── Index mapping ────────────────────────────────────────────────────────────

const INDEX_MAP: Record<BbIndex, { ticker: string; label: string }> = {
  nifty50:     { ticker: "NIFTY50",        label: "Nifty 50"           },
  nifty500:    { ticker: "NIFTY500",        label: "Nifty 500"          },
  smallcap100: { ticker: "NIFTY_SMALLCAP",  label: "Nifty SmallCap 100" },
};

// ─── Monthly aggregation ──────────────────────────────────────────────────────

function toMonthly(
  bars: { date: string; open: number; high: number; low: number; close: number }[],
): BbMonthlyBar[] {
  const groups = new Map<string, BbMonthlyBar>();
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

// ─── Bollinger Band computation ───────────────────────────────────────────────

function computeBB(closes: number[], period = 20, mult = 2): BbBar[] {
  const results: BbBar[] = [];
  // Need monthly bars to attach date — passed separately
  return results; // placeholder; real impl below uses index
}
void computeBB; // suppress unused warning

function computeBBBars(monthlyBars: BbMonthlyBar[], period = 20, mult = 2): BbBar[] {
  const closes  = monthlyBars.map((b) => b.close);
  const results: BbBar[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) continue;  // not enough history

    // SMA
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const sma = sum / period;

    // StdDev (population)
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - sma) ** 2;
    const std    = Math.sqrt(variance / period);

    const upper  = sma + mult * std;
    const lower  = sma - mult * std;
    const close  = closes[i];
    const band   = upper - lower;
    const pctB   = band > 0 ? (close - lower) / band : 0.5;
    const bw     = sma > 0 ? (band / sma) * 100 : 0;

    results.push({
      date:      monthlyBars[i].date,
      close:     parseFloat(close.toFixed(2)),
      upper:     parseFloat(upper.toFixed(2)),
      middle:    parseFloat(sma.toFixed(2)),
      lower:     parseFloat(lower.toFixed(2)),
      percentB:  parseFloat(pctB.toFixed(4)),
      bandwidth: parseFloat(bw.toFixed(2)),
    });
  }
  return results;
}

// ─── Touch event detection ────────────────────────────────────────────────────

function detectTouchEvents(monthlyBars: BbMonthlyBar[], bbBars: BbBar[]): BbTouchEvent[] {
  // Build a date→index map for monthly bars
  const dateToIdx = new Map<string, number>();
  monthlyBars.forEach((b, i) => dateToIdx.set(b.date, i));

  const events: BbTouchEvent[] = [];
  let cooldown = 0;  // avoid counting consecutive months as separate events

  for (let i = 0; i < bbBars.length; i++) {
    const b = bbBars[i];
    if (cooldown > 0) { cooldown--; continue; }
    if (b.percentB > 0) continue;  // not touching/below lower BB

    // Find the entry bar in monthlyBars
    const mIdx = dateToIdx.get(b.date);
    if (mIdx === undefined) continue;

    const entryClose = monthlyBars[mIdx].close;

    const fwdClose = (months: number): number | null => {
      const idx = mIdx + months;
      return idx < monthlyBars.length ? monthlyBars[idx].close : null;
    };
    const ret = (c: number | null) =>
      c !== null ? parseFloat(((c - entryClose) / entryClose * 100).toFixed(2)) : null;

    // Max drawdown over next 18 months
    let maxDd: number | null = null;
    for (let d = 1; d <= 18; d++) {
      const c = fwdClose(d);
      if (c === null) break;
      const dd = (c - entryClose) / entryClose * 100;
      if (maxDd === null || dd < maxDd) maxDd = dd;
    }

    events.push({
      date:         b.date,
      close:        entryClose,
      lower:        b.lower,
      percentB:     b.percentB,
      devFromLower: parseFloat(((entryClose - b.lower) / b.lower * 100).toFixed(2)),
      ret6m:        ret(fwdClose(6)),
      ret12m:       ret(fwdClose(12)),
      ret18m:       ret(fwdClose(18)),
      ret24m:       ret(fwdClose(24)),
      maxDrawdown:  maxDd !== null ? parseFloat(maxDd.toFixed(2)) : null,
    });

    cooldown = 2;  // skip next 2 months to avoid double-counting prolonged touches
  }
  return events;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function computeSummary(events: BbTouchEvent[]): BbSummary {
  const avg = (arr: (number | null)[]) => {
    const v = arr.filter((x): x is number => x !== null);
    return v.length ? parseFloat((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)) : 0;
  };
  const wr = (arr: (number | null)[]) => {
    const v = arr.filter((x): x is number => x !== null);
    return v.length ? Math.round(v.filter((x) => x > 0).length / v.length * 100) : 0;
  };
  const n = events.length;
  return {
    totalEvents:    n,
    winRate6m:      wr(events.map((e) => e.ret6m)),   avgRet6m:   avg(events.map((e) => e.ret6m)),
    winRate12m:     wr(events.map((e) => e.ret12m)),  avgRet12m:  avg(events.map((e) => e.ret12m)),
    winRate18m:     wr(events.map((e) => e.ret18m)),  avgRet18m:  avg(events.map((e) => e.ret18m)),
    winRate24m:     wr(events.map((e) => e.ret24m)),  avgRet24m:  avg(events.map((e) => e.ret24m)),
    avgMaxDrawdown: avg(events.map((e) => e.maxDrawdown)),
    thesisScore:    wr(events.map((e) => e.ret18m)),
  };
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const indexKey  = (searchParams.get("index") ?? "nifty50") as BbIndex;
  const cfg       = INDEX_MAP[indexKey] ?? INDEX_MAP.nifty50;

  try {
    const asset = await prisma.asset.findUnique({
      where:   { ticker: cfg.ticker },
      include: { priceData: { orderBy: { timestamp: "desc" }, take: 8000 } },
    });

    if (!asset || asset.priceData.length < 25) {
      return NextResponse.json({ hasData: false } satisfies Partial<BbResponse>);
    }

    const dailyBars = asset.priceData.slice().reverse().map((r) => ({
      date:  r.timestamp.toISOString().slice(0, 10),
      open:  r.open, high: r.high, low: r.low, close: r.close,
    }));

    const monthlyBars = toMonthly(dailyBars);
    if (monthlyBars.length < 22) {
      return NextResponse.json({ hasData: false } satisfies Partial<BbResponse>);
    }

    const bbBars      = computeBBBars(monthlyBars);
    const touchEvents = detectTouchEvents(monthlyBars, bbBars);
    const summary     = computeSummary(touchEvents);

    const latest  = bbBars.at(-1)!;
    const lastTouch = [...touchEvents].reverse().find((e) => e.percentB <= 0);

    return NextResponse.json({
      hasData:          true,
      indexKey,
      indexLabel:       cfg.label,
      niftyBars:        monthlyBars,
      bbBars,
      touchEvents,
      summary,
      currentPercentB:  latest.percentB,
      currentClose:     latest.close,
      currentLower:     latest.lower,
      currentUpper:     latest.upper,
      currentMiddle:    latest.middle,
      isTouching:       latest.percentB <= 0,
      isNearLower:      latest.percentB < 0.2,
      lastTouchDate:    lastTouch?.date ?? null,
    } satisfies BbResponse);

  } catch (err) {
    console.error("[GET /api/bb]", err);
    return NextResponse.json({ error: "BB engine failed" }, { status: 500 });
  }
}
