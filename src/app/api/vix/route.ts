// GET /api/vix
// India VIX Intelligence Engine
// Returns: current value, zone, signal, confidence, historical bars,
//          rejection points, and historical stats (avg return after VIX spike).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VixZone {
  label:  "Complacency" | "Normal" | "Rising Fear" | "High Fear" | "Panic Zone";
  color:  string;
  bgColor: string;
  textColor: string;
  band:   number;  // 0–4
}

export interface VixSignal {
  label:      string;
  bias:       "Bullish" | "Bearish" | "Neutral";
  confidence: number;
  rationale:  string;
}

export interface VixRejection {
  date: string;
  vix:  number;
}

export interface VixHistoricalStats {
  instances:       number;
  avgReturn30d:    number;
  winRate:         number;
  avgDaysToBottom: number;
  threshold:       number;
}

export interface VixBar {
  date:  string;
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export interface VixSpikeOutcome {
  date:       string;
  vix:        number;
  niftyEntry: number;
  ret5d:      number | null;
  ret10d:     number | null;
  ret20d:     number | null;
}

export interface VixOutcomeSummary {
  threshold:  number;
  count:      number;
  winRate5d:  number;  avgRet5d:  number;
  winRate10d: number;  avgRet10d: number;
  winRate20d: number;  avgRet20d: number;
}

export interface VixMonthlyOutcomeSummary {
  threshold:   number;
  zoneLabel:   string;
  count:       number;
  winRate1m:   number; avgRet1m:  number;
  winRate3m:   number; avgRet3m:  number;
  winRate6m:   number; avgRet6m:  number;
  winRate12m:  number; avgRet12m: number;
}

export interface VixDivergence {
  date:        string;
  type:        "hidden_strength" | "weak_rally";
  vixChange:   number;   // % change over 10-day window
  niftyChange: number;
}

export interface NiftyBottomZone {
  date:      string;   // date of Nifty trough after spike
  nifty:     number;
  spikeDate: string;
  vix:       number;
  daysAfter: number;
}

export interface VixContext {
  percentileRank: number;   // 0–100: % of all historical days VIX was below current
  regimeDays:     number;   // consecutive days in current zone
  ma20:           number;   // 20-day moving average of VIX close
  momentum5d:     number;   // % change vs 5 bars ago
  momentum20d:    number;   // % change vs 20 bars ago
  aboveMa20:      boolean;  // is current VIX above its 20d MA?
}

export interface VixResponse {
  current:          number;
  prev:             number;
  change1d:         number;
  trend:            "rising" | "falling" | "flat";
  zone:             VixZone;
  signal:           VixSignal;
  rejections:       VixRejection[];
  historicalStats:  VixHistoricalStats | null;
  bars:             VixBar[];
  niftyBars:        VixBar[];
  spikeOutcomes:    VixSpikeOutcome[];
  outcomeSummary:   VixOutcomeSummary | null;
  divergences:             VixDivergence[];
  niftyBottomZones:        NiftyBottomZone[];
  context:                 VixContext;
  monthlyOutcomeSummaries: VixMonthlyOutcomeSummary[];
  hasData:                 boolean;
}

// ─── Zone classification ──────────────────────────────────────────────────────

function getZone(vix: number): VixZone {
  if (vix < 12) return {
    label: "Complacency", band: 0,
    color: "#22c55e", bgColor: "rgba(34,197,94,0.12)", textColor: "#15803d",
  };
  if (vix < 20) return {
    label: "Normal", band: 1,
    color: "#3b82f6", bgColor: "rgba(59,130,246,0.12)", textColor: "#1d4ed8",
  };
  if (vix < 25) return {
    label: "Rising Fear", band: 2,
    color: "#f59e0b", bgColor: "rgba(245,158,11,0.12)", textColor: "#b45309",
  };
  if (vix < 30) return {
    label: "High Fear", band: 3,
    color: "#f97316", bgColor: "rgba(249,115,22,0.12)", textColor: "#c2410c",
  };
  return {
    label: "Panic Zone", band: 4,
    color: "#ef4444", bgColor: "rgba(239,68,68,0.12)", textColor: "#b91c1c",
  };
}

// ─── Signal engine ────────────────────────────────────────────────────────────

function getSignal(vix: number, trend: "rising" | "falling" | "flat"): VixSignal {
  if (vix > 30) return {
    label: "Contrarian Bullish", bias: "Bullish", confidence: 78,
    rationale: "VIX in panic zone — historically marks market capitulation. Every prior spike above 30 preceded a significant rally within weeks.",
  };
  if (vix > 25) {
    const conf = trend === "falling" ? 68 : 58;
    return {
      label: trend === "falling" ? "Fear Peak Forming" : "Fear Elevated",
      bias: "Bullish", confidence: conf,
      rationale: trend === "falling"
        ? "VIX > 25 and falling — peak fear may be in. Institutional buying typically accelerates as VIX rolls over."
        : "VIX in high-fear zone. Watch for reversal — rising VIX hasn't peaked yet.",
    };
  }
  if (vix < 12) return {
    label: "Complacency Warning", bias: "Bearish", confidence: 64,
    rationale: "Extremely low VIX signals market complacency. Low fear = low hedging = vulnerability to sudden sharp selloffs.",
  };
  if (vix < 14 && trend === "rising") return {
    label: "Fear Awakening", bias: "Bearish", confidence: 55,
    rationale: "VIX rising from complacency — early warning of potential volatility expansion.",
  };
  if (trend === "rising") return {
    label: "Volatility Expanding", bias: "Bearish", confidence: 52,
    rationale: "Rising VIX indicates growing institutional hedging. Caution warranted.",
  };
  if (trend === "falling") return {
    label: "Fear Receding", bias: "Bullish", confidence: 54,
    rationale: "Declining VIX shows fear unwinding — market stabilising, risk appetite returning.",
  };
  return {
    label: "Neutral", bias: "Neutral", confidence: 50,
    rationale: "VIX in normal range with stable trend — no extreme signal.",
  };
}

// ─── Rejection detection ──────────────────────────────────────────────────────
// A rejection = VIX touched > threshold AND reversed (local high with subsequent decline)

function detectRejections(bars: VixBar[], threshold = 28): VixRejection[] {
  const result: VixRejection[] = [];
  let lastRejIdx = -20;

  for (let i = 3; i < bars.length - 3; i++) {
    const b = bars[i];
    if (b.close < threshold) continue;

    // Must be a local high among neighbors
    const isLocalHigh =
      b.close >= bars[i - 1].close &&
      b.close >= bars[i - 2].close &&
      b.close >= bars[i + 1].close;

    // Next 2 bars must decline
    const declined = bars[i + 1].close < b.close && bars[i + 2].close < bars[i + 1].close;

    if (isLocalHigh && declined && i - lastRejIdx > 10) {
      result.push({ date: b.date, vix: parseFloat(b.close.toFixed(2)) });
      lastRejIdx = i;
    }
  }

  return result.slice(-12); // last 12 rejections
}

// ─── Historical stats: NIFTY50 returns after VIX spike ───────────────────────

function computeHistoricalStats(
  vixBars: VixBar[],
  niftyBars: VixBar[],
  threshold = 28,
): VixHistoricalStats | null {
  const niftyMap = new Map(niftyBars.map((b) => [b.date, b.close]));

  // Find spike onset dates: first bar > threshold after being below threshold-3 for 5+ bars
  const spikeDates: { date: string; idx: number }[] = [];
  let cooldown = 0;

  for (let i = 5; i < vixBars.length - 35; i++) {
    if (cooldown > 0) { cooldown--; continue; }
    if (vixBars[i].close > threshold && vixBars[i - 1].close <= threshold) {
      spikeDates.push({ date: vixBars[i].date, idx: i });
      cooldown = 20; // don't double-count spikes within 20 bars
    }
  }

  const returns:      number[] = [];
  const daysToBottom: number[] = [];

  for (const { date, idx } of spikeDates) {
    const niftyEntry = niftyMap.get(date);
    if (!niftyEntry) continue;

    // Find forward 30D NIFTY return
    const futureBar = vixBars[idx + 30];
    if (!futureBar) continue;
    const niftyFuture = niftyMap.get(futureBar.date);
    if (!niftyFuture) continue;
    returns.push(((niftyFuture - niftyEntry) / niftyEntry) * 100);

    // Find trough date after spike (min NIFTY close in next 30 bars)
    let minClose = niftyEntry;
    let minDay   = 0;
    for (let d = 1; d <= 30 && idx + d < vixBars.length; d++) {
      const nd = niftyMap.get(vixBars[idx + d].date);
      if (nd && nd < minClose) { minClose = nd; minDay = d; }
    }
    if (minDay > 0) daysToBottom.push(minDay);
  }

  if (returns.length < 2) return null;

  const avgReturn  = returns.reduce((a, b) => a + b, 0) / returns.length;
  const wins       = returns.filter((r) => r > 0).length;
  const avgDays    = daysToBottom.length
    ? Math.round(daysToBottom.reduce((a, b) => a + b, 0) / daysToBottom.length)
    : 15;

  return {
    instances:       returns.length,
    avgReturn30d:    parseFloat(avgReturn.toFixed(1)),
    winRate:         Math.round((wins / returns.length) * 100),
    avgDaysToBottom: avgDays,
    threshold,
  };
}

// ─── Yahoo Finance gap-fill ───────────────────────────────────────────────────
// Awaited (with 5s timeout) before the DB query so the first call after a gap
// already returns fresh data. Module-level cooldown prevents hammering Yahoo
// on every SWR poll (default: every 5 min).

let lastGapFillAt = 0; // unix ms
let gapFillPromise: Promise<void> | null = null; // deduplicate concurrent calls

// India VIX launched Nov 2007; NIFTY data available from Jan 2000
const VIX_ALL_TIME_START   = new Date("2007-11-01");
const NIFTY_ALL_TIME_START = new Date("2000-01-01");
// Threshold below which we do a full historical backfill
const VIX_MIN_ROWS   = 3800;
const NIFTY_MIN_ROWS = 5000;

async function gapFillVix(): Promise<void> {
  const now = Date.now();
  if (now - lastGapFillAt < 60 * 60 * 1000) return; // cooldown: 1 hour

  try {
    // Check row counts + latest dates in parallel
    const [vixCount, niftyCount, vixLatest, niftyLatest] = await Promise.all([
      prisma.priceData.count({ where: { asset: { ticker: "INDIAVIX" } } }),
      prisma.priceData.count({ where: { asset: { ticker: "NIFTY50"  } } }),
      prisma.priceData.findFirst({
        where:   { asset: { ticker: "INDIAVIX" } },
        orderBy: { timestamp: "desc" },
        select:  { timestamp: true },
      }),
      prisma.priceData.findFirst({
        where:   { asset: { ticker: "NIFTY50" } },
        orderBy: { timestamp: "desc" },
        select:  { timestamp: true },
      }),
    ]);

    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);

    // Determine fetch-from date: use all-time start if we have fewer rows than expected
    const fetchFrom = (
      count: number, minRows: number,
      latest: { timestamp: Date } | null,
      allTimeStart: Date,
    ): Date | null => {
      if (count < minRows) return allTimeStart;                          // full backfill
      if (!latest) return allTimeStart;
      const diffDays = (todayUtc.getTime() - latest.timestamp.getTime()) / 86_400_000;
      return diffDays >= 1 ? latest.timestamp : null;                   // gap-fill forward
    };

    const vixFrom   = fetchFrom(vixCount,   VIX_MIN_ROWS,   vixLatest,   VIX_ALL_TIME_START);
    const niftyFrom = fetchFrom(niftyCount, NIFTY_MIN_ROWS, niftyLatest, NIFTY_ALL_TIME_START);

    const tickersToFill: { ticker: string; yf: string; fromDate: Date }[] = [];
    if (vixFrom)   tickersToFill.push({ ticker: "INDIAVIX", yf: "%5EINDIAVIX", fromDate: vixFrom });
    if (niftyFrom) tickersToFill.push({ ticker: "NIFTY50",  yf: "%5ENSEI",     fromDate: niftyFrom });

    if (tickersToFill.length === 0) {
      lastGapFillAt = now;
      return;
    }

    // Upsert asset rows so gap-fill works even after a DB reset
    const ASSET_META: Record<string, { name: string; sector: string }> = {
      INDIAVIX: { name: "India VIX",  sector: "Volatility"   },
      NIFTY50:  { name: "Nifty 50",   sector: "Broad Market" },
    };
    for (const { ticker } of tickersToFill) {
      const meta = ASSET_META[ticker];
      if (!meta) continue;
      await prisma.asset.upsert({
        where:  { ticker },
        update: {},
        create: { ticker, name: meta.name, assetClass: "EQUITY", sector: meta.sector, region: "India", currency: "INR" },
      });
    }

    const assets = await prisma.asset.findMany({
      where: { ticker: { in: tickersToFill.map((t) => t.ticker) } },
      select: { id: true, ticker: true },
    });
    const assetIdMap = Object.fromEntries(assets.map((a) => [a.ticker, a.id]));

    for (const { ticker, yf, fromDate } of tickersToFill) {
      const assetId = assetIdMap[ticker];
      if (!assetId) continue;

      // Fetch from Yahoo Finance v8 chart API
      const period1 = Math.floor(fromDate.getTime() / 1000);
      const period2 = Math.floor(todayUtc.getTime() / 1000) + 86400;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yf}?interval=1d&period1=${period1}&period2=${period2}`;

      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal:  AbortSignal.timeout(10_000),
      });
      if (!resp.ok) continue;

      const json = await resp.json() as {
        chart: { result: Array<{
          timestamp: number[];
          indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> };
        }> | null };
      };

      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const { timestamp, indicators } = result;
      const q = indicators.quote[0];
      const lastKnown = fromDate.toISOString().slice(0, 10);

      const rows: {
        assetId: string; timestamp: Date;
        open: number; high: number; low: number; close: number; volume: number; source: string;
      }[] = [];

      for (let i = 0; i < timestamp.length; i++) {
        if (q.close[i] == null) continue;
        const barDate = new Date(timestamp[i] * 1000);
        barDate.setUTCHours(0, 0, 0, 0);
        const dateStr = barDate.toISOString().slice(0, 10);
        if (dateStr <= lastKnown) continue; // skip rows we already have

        rows.push({
          assetId,
          timestamp: barDate,
          open:   q.open[i]   ?? q.close[i],
          high:   q.high[i]   ?? q.close[i],
          low:    q.low[i]    ?? q.close[i],
          close:  q.close[i],
          volume: q.volume[i] ?? 0,
          source: "yfinance_gapfill",
        });
      }

      if (rows.length > 0) {
        // createMany lets Prisma generate the cuid() id — raw SQL can't do that
        await prisma.priceData.createMany({ data: rows, skipDuplicates: true });

        console.log(`[vix/gap-fill] ${ticker}: +${rows.length} bars upserted (up to ${rows.at(-1)!.timestamp.toISOString().slice(0, 10)})`);
      }
    }

    lastGapFillAt = now;
  } catch (err) {
    console.warn("[vix/gap-fill] failed silently:", err);
  }
}


// ─── Quant engine ─────────────────────────────────────────────────────────────

function computeSpikeOutcomes(vixBars: VixBar[], niftyBars: VixBar[], threshold = 28): VixSpikeOutcome[] {
  const niftyMap = new Map(niftyBars.map((b) => [b.date, b.close]));
  const outcomes: VixSpikeOutcome[] = [];
  let cooldown = 0;

  for (let i = 1; i < vixBars.length - 21; i++) {
    if (cooldown > 0) { cooldown--; continue; }
    if (vixBars[i].close > threshold && vixBars[i - 1].close <= threshold) {
      const date        = vixBars[i].date;
      const niftyEntry  = niftyMap.get(date);
      if (!niftyEntry) continue;

      const fwd = (d: number) => niftyMap.get(vixBars[i + d]?.date) ?? null;
      const n5  = fwd(5); const n10 = fwd(10); const n20 = fwd(20);
      const ret = (n: number | null) =>
        n ? parseFloat(((n - niftyEntry) / niftyEntry * 100).toFixed(2)) : null;

      outcomes.push({ date, vix: parseFloat(vixBars[i].close.toFixed(2)),
        niftyEntry: parseFloat(niftyEntry.toFixed(2)),
        ret5d: ret(n5), ret10d: ret(n10), ret20d: ret(n20) });
      cooldown = 15;
    }
  }
  return outcomes;
}

function computeOutcomeSummary(outcomes: VixSpikeOutcome[], threshold: number): VixOutcomeSummary | null {
  if (outcomes.length < 2) return null;
  const calc = (key: "ret5d" | "ret10d" | "ret20d") => {
    const v = outcomes.filter((o) => o[key] !== null);
    if (!v.length) return { winRate: 0, avgRet: 0 };
    return {
      winRate: Math.round(v.filter((o) => o[key]! > 0).length / v.length * 100),
      avgRet:  parseFloat((v.reduce((s, o) => s + o[key]!, 0) / v.length).toFixed(2)),
    };
  };
  const s5 = calc("ret5d"); const s10 = calc("ret10d"); const s20 = calc("ret20d");
  return { threshold, count: outcomes.length,
    winRate5d: s5.winRate,   avgRet5d: s5.avgRet,
    winRate10d: s10.winRate, avgRet10d: s10.avgRet,
    winRate20d: s20.winRate, avgRet20d: s20.avgRet };
}

function detectDivergences(vixBars: VixBar[], niftyBars: VixBar[], window = 10): VixDivergence[] {
  const niftyMap = new Map(niftyBars.map((b) => [b.date, b.close]));
  const raw: VixDivergence[] = [];

  for (let i = window; i < vixBars.length; i++) {
    const vp = vixBars[i - window].close; const vc = vixBars[i].close;
    const np = niftyMap.get(vixBars[i - window].date);
    const nc = niftyMap.get(vixBars[i].date);
    if (!np || !nc) continue;
    const vChg = (vc - vp) / vp; const nChg = (nc - np) / np;

    if (vChg > 0.20 && nChg > -0.01)
      raw.push({ date: vixBars[i].date, type: "hidden_strength",
        vixChange: parseFloat((vChg * 100).toFixed(1)), niftyChange: parseFloat((nChg * 100).toFixed(1)) });
    else if (vChg < -0.20 && nChg < 0.01)
      raw.push({ date: vixBars[i].date, type: "weak_rally",
        vixChange: parseFloat((vChg * 100).toFixed(1)), niftyChange: parseFloat((nChg * 100).toFixed(1)) });
  }

  // Cluster dedup: keep strongest per 20-day window
  const result: VixDivergence[] = [];
  for (const d of raw) {
    const last = result.at(-1);
    if (!last) { result.push(d); continue; }
    const diff = (new Date(d.date).getTime() - new Date(last.date).getTime()) / 86_400_000;
    if (diff > 20) result.push(d);
    else if (Math.abs(d.vixChange) > Math.abs(last.vixChange)) result[result.length - 1] = d;
  }
  return result.slice(-20);
}

function computeContext(vixBars: VixBar[], current: number, currentZone: VixZone): VixContext {
  const closes = vixBars.map((b) => b.close);

  // Percentile: % of days where VIX was at or below current
  const percentileRank = Math.round((closes.filter((v) => v <= current).length / closes.length) * 100);

  // Consecutive days in current zone
  let regimeDays = 0;
  for (let i = vixBars.length - 1; i >= 0; i--) {
    if (getZone(vixBars[i].close).label === currentZone.label) regimeDays++;
    else break;
  }

  // 20-day MA
  const last20 = vixBars.slice(-20);
  const ma20   = parseFloat((last20.reduce((s, b) => s + b.close, 0) / last20.length).toFixed(2));

  // Momentum
  const v5ago  = vixBars.at(-6)?.close  ?? current;
  const v20ago = vixBars.at(-21)?.close ?? current;

  return {
    percentileRank,
    regimeDays,
    ma20,
    aboveMa20:   current > ma20,
    momentum5d:  parseFloat(((current - v5ago)  / (v5ago  || 1) * 100).toFixed(1)),
    momentum20d: parseFloat(((current - v20ago) / (v20ago || 1) * 100).toFixed(1)),
  };
}

function computeNiftyBottomZones(
  vixBars: VixBar[], niftyBars: VixBar[], spikeOutcomes: VixSpikeOutcome[]
): NiftyBottomZone[] {
  const niftyMap  = new Map(niftyBars.map((b) => [b.date, b.close]));
  const vixIdxMap = new Map(vixBars.map((b, i) => [b.date, i]));

  return spikeOutcomes.flatMap((spike) => {
    const si = vixIdxMap.get(spike.date);
    if (si === undefined) return [];
    let minClose = spike.niftyEntry; let minDate = spike.date; let daysAfter = 0;
    for (let j = 1; j <= 30 && si + j < vixBars.length; j++) {
      const n = niftyMap.get(vixBars[si + j].date);
      if (n && n < minClose) { minClose = n; minDate = vixBars[si + j].date; daysAfter = j; }
    }
    return [{ date: minDate, nifty: parseFloat(minClose.toFixed(2)),
      spikeDate: spike.date, vix: spike.vix, daysAfter }];
  });
}

// ─── Monthly bar aggregation ──────────────────────────────────────────────────

function toMonthlyBars(bars: VixBar[]): VixBar[] {
  const groups = new Map<string, VixBar>();
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

// ─── Monthly spike outcome computation ───────────────────────────────────────

function computeMonthlyOutcomeSummary(
  vixMonthly: VixBar[], niftyMonthly: VixBar[], threshold: number,
): VixMonthlyOutcomeSummary | null {
  const niftyIdxMap = new Map(niftyMonthly.map((b, i) => [b.date, i]));
  const rets: { ret1m: number|null; ret3m: number|null; ret6m: number|null; ret12m: number|null }[] = [];
  let cooldown = 0;

  for (let i = 0; i < vixMonthly.length - 13; i++) {
    if (cooldown > 0) { cooldown--; continue; }
    if (vixMonthly[i].close < threshold) continue;

    const nIdx = niftyIdxMap.get(vixMonthly[i].date);
    if (nIdx === undefined) continue;

    const entry = niftyMonthly[nIdx].close;
    const fwd = (m: number) => nIdx + m < niftyMonthly.length ? niftyMonthly[nIdx + m].close : null;
    const ret = (c: number | null) =>
      c !== null ? parseFloat(((c - entry) / entry * 100).toFixed(2)) : null;

    rets.push({ ret1m: ret(fwd(1)), ret3m: ret(fwd(3)), ret6m: ret(fwd(6)), ret12m: ret(fwd(12)) });
    cooldown = 2;
  }

  if (rets.length < 2) return null;

  const calc = (vals: (number | null)[]) => {
    const v = vals.filter((x): x is number => x !== null);
    return v.length
      ? { winRate: Math.round(v.filter((x) => x > 0).length / v.length * 100),
          avgRet:  parseFloat((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)) }
      : { winRate: 0, avgRet: 0 };
  };

  const s1 = calc(rets.map((r) => r.ret1m));
  const s3 = calc(rets.map((r) => r.ret3m));
  const s6 = calc(rets.map((r) => r.ret6m));
  const s12 = calc(rets.map((r) => r.ret12m));

  return {
    threshold,
    zoneLabel: threshold >= 28 ? "Panic Zone" : threshold >= 25 ? "High Fear" : "Fear Zone",
    count: rets.length,
    winRate1m:  s1.winRate,  avgRet1m:  s1.avgRet,
    winRate3m:  s3.winRate,  avgRet3m:  s3.avgRet,
    winRate6m:  s6.winRate,  avgRet6m:  s6.avgRet,
    winRate12m: s12.winRate, avgRet12m: s12.avgRet,
  };
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET() {
  // Await gap-fill (max 5 s) so the first call after a gap returns fresh data.
  // Concurrent requests share the same in-flight promise to avoid duplicate fetches.
  try {
    if (!gapFillPromise) {
      gapFillPromise = gapFillVix().finally(() => { gapFillPromise = null; });
    }
    await Promise.race([gapFillPromise, new Promise<void>((r) => setTimeout(r, 5000))]);
  } catch { /* gap-fill errors are non-fatal */ }

  try {
    const [vixAsset, niftyAsset] = await Promise.all([
      prisma.asset.findUnique({
        where:   { ticker: "INDIAVIX" },
        // DESC + take 6000 → covers all-time data (~4500 bars since 2007); reverse below for chronological order
        include: { priceData: { orderBy: { timestamp: "desc" }, take: 6000 } },
      }),
      prisma.asset.findUnique({
        where:   { ticker: "NIFTY50" },
        include: { priceData: { orderBy: { timestamp: "desc" }, take: 6000 } },
      }),
    ]);

    // VIX data not in DB yet
    if (!vixAsset || vixAsset.priceData.length < 5) {
      return NextResponse.json({
        hasData: false, current: 0, prev: 0, change1d: 0, trend: "flat",
        zone: getZone(0), signal: getSignal(0, "flat"),
        rejections: [], historicalStats: null, bars: [],
        niftyBars: [], spikeOutcomes: [], outcomeSummary: null,
        divergences: [], niftyBottomZones: [], monthlyOutcomeSummaries: [],
        context: { percentileRank: 0, regimeDays: 0, ma20: 0, aboveMa20: false, momentum5d: 0, momentum20d: 0 },
      } satisfies VixResponse);
    }

    // Reverse to chronological order (oldest → newest)
    const vixBars: VixBar[] = vixAsset.priceData.slice().reverse().map((r) => ({
      date:  r.timestamp.toISOString().slice(0, 10),
      open:  r.open,
      high:  r.high,
      low:   r.low,
      close: r.close,
    }));

    const niftyBars: VixBar[] = (niftyAsset?.priceData ?? []).slice().reverse().map((r) => ({
      date:  r.timestamp.toISOString().slice(0, 10),
      open:  r.open,
      high:  r.high,
      low:   r.low,
      close: r.close,
    }));

    const current = vixBars.at(-1)!.close;
    const prev    = vixBars.at(-2)?.close ?? current;
    const change1d = ((current - prev) / (prev || 1)) * 100;

    // Trend: compare latest vs 5 bars ago
    const v5ago = vixBars.at(-6)?.close ?? current;
    const trend: "rising" | "falling" | "flat" =
      current > v5ago * 1.02 ? "rising" :
      current < v5ago * 0.98 ? "falling" : "flat";

    const zone             = getZone(current);
    const signal           = getSignal(current, trend);
    const rejections       = detectRejections(vixBars, 28);
    const historicalStats  = computeHistoricalStats(vixBars, niftyBars, 28);
    const spikeOutcomes    = computeSpikeOutcomes(vixBars, niftyBars, 28);
    const outcomeSummary   = computeOutcomeSummary(spikeOutcomes, 28);
    const divergences      = detectDivergences(vixBars, niftyBars);
    const niftyBottomZones = computeNiftyBottomZones(vixBars, niftyBars, spikeOutcomes);
    const context          = computeContext(vixBars, current, zone);

    const vixMonthly   = toMonthlyBars(vixBars);
    const niftyMonthly = toMonthlyBars(niftyBars);
    const monthlyOutcomeSummaries = ([20, 25, 28] as const)
      .map((t) => computeMonthlyOutcomeSummary(vixMonthly, niftyMonthly, t))
      .filter((s): s is VixMonthlyOutcomeSummary => s !== null);

    return NextResponse.json({
      hasData:  true,
      current:  parseFloat(current.toFixed(2)),
      prev:     parseFloat(prev.toFixed(2)),
      change1d: parseFloat(change1d.toFixed(2)),
      trend,
      zone,
      signal,
      rejections,
      historicalStats,
      bars:             vixBars,
      niftyBars,
      spikeOutcomes,
      outcomeSummary,
      divergences,
      niftyBottomZones,
      context,
      monthlyOutcomeSummaries,
    } satisfies VixResponse);

  } catch (err) {
    console.error("[GET /api/vix]", err);
    return NextResponse.json({ error: "Failed to compute VIX intelligence" }, { status: 500 });
  }
}
