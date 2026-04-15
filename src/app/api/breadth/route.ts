// GET /api/breadth
// Nifty 100 Market Breadth — Advance / Decline Ratio
// Monthly:  Σadvances / Σdeclines per calendar month   → zones <0.8 | 1.3-1.5 | >1.5
// Weekly:   Σadvances / Σdeclines per ISO week         → zones <0.5 | >1.8

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdBar {
  date:       string;
  advances:   number;
  declines:   number;
  unchanged:  number;
  total:      number;
  adRatio:    number;   // advances / max(declines,1)
  netAD:      number;
  adLine:     number;   // cumulative netAD
  adRatio20d: number;   // 20-day SMA of adRatio
}

export interface AdZoneEvent {
  date:           string;
  adRatio:        number;
  nifty100Close:  number;
  zoneLabel:      string;
  zoneType:       "bear" | "bull" | "strongBull";
  ret3m:          number | null;
  ret6m:          number | null;
  ret12m:         number | null;
  ret18m:         number | null;
  maxDrawdown:    number | null;
}

export interface AdZoneStats {
  totalEvents:    number;
  winRate3m:      number; avgRet3m:   number;
  winRate6m:      number; avgRet6m:   number;
  winRate12m:     number; avgRet12m:  number;
  winRate18m:     number; avgRet18m:  number;
  avgMaxDrawdown: number;
}

export interface AdWeeklyBar {
  date:  string;   // Monday of the week (ISO key)
  ratio: number;   // Σadvances / Σdeclines for the week
}

export interface AdWeeklyEvent {
  date:          string;
  adRatio:       number;
  nifty100Close: number;
  zoneLabel:     string;
  zoneType:      "bear" | "bull";
  ret15d:        number | null;   // ~15 trading days (≈21 cal days)
  ret1m:         number | null;   // 1 month  (30 cal days)
  ret2m:         number | null;   // 2 months (60 cal days)
  ret3m:         number | null;   // 3 months (91 cal days)
  maxDrawdown:   number | null;
}

export interface AdWeeklyStats {
  totalEvents:    number;
  winRate15d:     number; avgRet15d: number;
  winRate2m:      number; avgRet2m:  number;
  winRate1m:      number; avgRet1m:  number;
  winRate3m:      number; avgRet3m:  number;
  avgMaxDrawdown: number;
}

export interface Nifty100Bar {
  date:  string;
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export type BreadthStatus = "Strong Bull" | "Bull" | "Neutral" | "Bear";

export interface BreadthResponse {
  hasData:             boolean;
  bars:                AdBar[];
  nifty100Bars:        Nifty100Bar[];     // monthly OHLC for monthly chart
  currentDate:         string;
  currentAdvances:     number;
  currentDeclines:     number;
  currentUnchanged:    number;
  currentTotal:        number;
  currentRatio:        number;
  adLine:              number;
  ratio20d:            number;
  adLineTrend:         number;
  breadthStatus:       BreadthStatus;
  breadthTrend:        "Improving" | "Deteriorating" | "Stable";
  percentileRank:      number;
  weekHigh52Ratio:     number;
  weekLow52Ratio:      number;
  extremeEvents:       AdZoneEvent[];
  zoneStats: {
    bear:       AdZoneStats | null;
    bull:       AdZoneStats | null;
    strongBull: AdZoneStats | null;
  };
  // ── Weekly view ──
  weeklyBars:          AdWeeklyBar[];
  weeklyNifty100Bars:  Nifty100Bar[];    // weekly OHLC for weekly chart
  weeklyEvents:        AdWeeklyEvent[];
  weeklyZoneStats: {
    bear: AdWeeklyStats | null;
    bull: AdWeeklyStats | null;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sma(arr: number[], end: number, period: number): number {
  if (end < period - 1) return 0;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) s += arr[i];
  return parseFloat((s / period).toFixed(3));
}

function toMonthly(bars: { date: string; open: number; high: number; low: number; close: number }[]): Nifty100Bar[] {
  const groups = new Map<string, Nifty100Bar>();
  for (const b of bars) {
    const key = b.date.slice(0, 7) + "-01";
    const ex  = groups.get(key);
    if (!ex) groups.set(key, { ...b, date: key });
    else { ex.high = Math.max(ex.high, b.high); ex.low = Math.min(ex.low, b.low); ex.close = b.close; }
  }
  return Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function toWeekly(bars: { date: string; open: number; high: number; low: number; close: number }[]): Nifty100Bar[] {
  const groups = new Map<string, Nifty100Bar>();
  for (const b of bars) {
    const d     = new Date(b.date + "T00:00:00Z");
    const day   = d.getUTCDay();
    const toMon = day === 0 ? 6 : day - 1;
    const key   = new Date(d.getTime() - toMon * 86400000).toISOString().slice(0, 10);
    const ex    = groups.get(key);
    if (!ex) groups.set(key, { ...b, date: key });
    else { ex.high = Math.max(ex.high, b.high); ex.low = Math.min(ex.low, b.low); ex.close = b.close; }
  }
  return Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function buildZoneStats(events: AdZoneEvent[]): AdZoneStats | null {
  if (!events.length) return null;
  const avg = (arr: (number | null)[]) => {
    const v = arr.filter((x): x is number => x !== null);
    return v.length ? parseFloat((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)) : 0;
  };
  const wr = (arr: (number | null)[]) => {
    const v = arr.filter((x): x is number => x !== null);
    return v.length ? Math.round(v.filter((x) => x > 0).length / v.length * 100) : 0;
  };
  return {
    totalEvents:    events.length,
    winRate3m:      wr(events.map((e) => e.ret3m)),   avgRet3m:   avg(events.map((e) => e.ret3m)),
    winRate6m:      wr(events.map((e) => e.ret6m)),   avgRet6m:   avg(events.map((e) => e.ret6m)),
    winRate12m:     wr(events.map((e) => e.ret12m)),  avgRet12m:  avg(events.map((e) => e.ret12m)),
    winRate18m:     wr(events.map((e) => e.ret18m)),  avgRet18m:  avg(events.map((e) => e.ret18m)),
    avgMaxDrawdown: avg(events.map((e) => e.maxDrawdown)),
  };
}

function buildWeeklyZoneStats(events: AdWeeklyEvent[]): AdWeeklyStats | null {
  if (!events.length) return null;
  const avg = (arr: (number | null)[]) => {
    const v = arr.filter((x): x is number => x !== null);
    return v.length ? parseFloat((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)) : 0;
  };
  const wr = (arr: (number | null)[]) => {
    const v = arr.filter((x): x is number => x !== null);
    return v.length ? Math.round(v.filter((x) => x > 0).length / v.length * 100) : 0;
  };
  return {
    totalEvents:    events.length,
    winRate15d:     wr(events.map((e) => e.ret15d)),  avgRet15d: avg(events.map((e) => e.ret15d)),
    winRate2m:      wr(events.map((e) => e.ret2m)),   avgRet2m:  avg(events.map((e) => e.ret2m)),
    winRate1m:      wr(events.map((e) => e.ret1m)),   avgRet1m:  avg(events.map((e) => e.ret1m)),
    winRate3m:      wr(events.map((e) => e.ret3m)),   avgRet3m:  avg(events.map((e) => e.ret3m)),
    avgMaxDrawdown: avg(events.map((e) => e.maxDrawdown)),
  };
}

function getBreadthStatus(ratio: number): BreadthStatus {
  if (ratio > 1.5)  return "Strong Bull";
  if (ratio > 1.3)  return "Bull";
  if (ratio >= 0.8) return "Neutral";
  return "Bear";
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // 1. Daily A/D counts from Nifty100Price
    const adRows = await prisma.$queryRaw<
      { date: Date; advances: bigint; declines: bigint; unchanged: bigint; total: bigint }[]
    >`
      WITH prev_close AS (
        SELECT "stockId", date, close,
               LAG(close) OVER (PARTITION BY "stockId" ORDER BY date) AS prev
        FROM "Nifty100Price"
        WHERE date >= '2010-01-01'
      ),
      daily AS (
        SELECT date,
          SUM(CASE WHEN close > prev THEN 1 ELSE 0 END)::bigint AS advances,
          SUM(CASE WHEN close < prev THEN 1 ELSE 0 END)::bigint AS declines,
          SUM(CASE WHEN close = prev THEN 1 ELSE 0 END)::bigint AS unchanged,
          COUNT(*)::bigint AS total
        FROM prev_close WHERE prev IS NOT NULL
        GROUP BY date
      )
      SELECT * FROM daily WHERE total >= 50 ORDER BY date
    `;

    if (!adRows || adRows.length < 10) {
      return NextResponse.json({ hasData: false } satisfies Partial<BreadthResponse>);
    }

    // 2. NIFTY100 index daily prices — daily map for weekly fwd returns + OHLC for charts
    const niftyAsset = await prisma.asset.findUnique({
      where:   { ticker: "NIFTY100" },
      include: { priceData: { orderBy: { timestamp: "asc" }, select: { timestamp: true, open: true, high: true, low: true, close: true } } },
    });

    const niftyMap = new Map<string, number>();
    const niftyBarsRaw: { date: string; open: number; high: number; low: number; close: number }[] = [];
    for (const p of niftyAsset?.priceData ?? []) {
      const d = p.timestamp.toISOString().slice(0, 10);
      niftyMap.set(d, p.close);
      niftyBarsRaw.push({ date: d, open: p.open, high: p.high, low: p.low, close: p.close });
    }

    // 3. Build daily bar array
    const ratios: number[] = adRows.map((r) =>
      parseFloat((Number(r.advances) / Math.max(Number(r.declines), 1)).toFixed(3))
    );

    let cumulative = 0;
    const adLines = adRows.map((r) => { cumulative += Number(r.advances) - Number(r.declines); return cumulative; });

    const allBars: AdBar[] = adRows.map((r, i) => ({
      date:       r.date.toISOString().slice(0, 10),
      advances:   Number(r.advances),
      declines:   Number(r.declines),
      unchanged:  Number(r.unchanged),
      total:      Number(r.total),
      adRatio:    ratios[i],
      netAD:      Number(r.advances) - Number(r.declines),
      adLine:     adLines[i],
      adRatio20d: sma(ratios, i, 20),
    }));

    // 4. Monthly aggregation: Σadvances / Σdeclines per calendar month
    const monthlyNiftyBars = toMonthly(niftyBarsRaw);
    const niftyMonthlyMap  = new Map<string, number>(monthlyNiftyBars.map((b) => [b.date, b.close]));

    type MonthlyADBar = { date: string; ratio: number };
    const monthAccum = new Map<string, { advances: number; declines: number }>();
    for (const b of allBars) {
      const key = b.date.slice(0, 7) + "-01";
      const m   = monthAccum.get(key);
      if (m) { m.advances += b.advances; m.declines += b.declines; }
      else   monthAccum.set(key, { advances: b.advances, declines: b.declines });
    }
    const monthlyBars: MonthlyADBar[] = Array.from(monthAccum.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { advances, declines }]) => ({
        date,
        ratio: parseFloat((advances / Math.max(declines, 1)).toFixed(3)),
      }));

    const addMonths = (ym01: string, n: number): string => {
      const y = parseInt(ym01.slice(0, 4), 10);
      const m = parseInt(ym01.slice(5, 7), 10) - 1;
      const d = new Date(y, m + n, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    };

    // 5. Monthly zone detection: Bear <0.8 | Bull 1.3-1.5 | Strong Bull >1.5
    const ZONE_CONFIGS: { type: AdZoneEvent["zoneType"]; label: string; enter: (r: number) => boolean }[] = [
      { type: "bear",       label: "Bear (< 0.8)",        enter: (r) => r < 0.8              },
      { type: "bull",       label: "Bull (1.3 – 1.5)",    enter: (r) => r > 1.3 && r <= 1.5  },
      { type: "strongBull", label: "Strong Bull (> 1.5)", enter: (r) => r > 1.5              },
    ];

    const extremeEvents: AdZoneEvent[] = [];

    for (const cfg of ZONE_CONFIGS) {
      let cooldown = 0;
      let inZone   = false;

      for (const mb of monthlyBars) {
        const inNow = cfg.enter(mb.ratio);
        if (cooldown > 0) { cooldown--; inZone = inNow; continue; }
        if (!inNow)       { inZone = false; continue; }
        if (inZone)       continue;

        inZone   = true;
        cooldown = 1;

        const entryClose = niftyMonthlyMap.get(mb.date) ?? 0;
        if (!entryClose) continue;

        const fwdClose = (months: number): number | null =>
          niftyMonthlyMap.get(addMonths(mb.date, months)) ?? null;
        const ret = (c: number | null) =>
          c !== null ? parseFloat(((c - entryClose) / entryClose * 100).toFixed(2)) : null;

        let maxDd: number | null = null;
        for (let d = 1; d <= 18; d++) {
          const c = niftyMonthlyMap.get(addMonths(mb.date, d));
          if (c === undefined) continue;
          const dd = (c - entryClose) / entryClose * 100;
          if (maxDd === null || dd < maxDd) maxDd = dd;
        }

        extremeEvents.push({
          date:          mb.date,
          adRatio:       mb.ratio,
          nifty100Close: entryClose,
          zoneLabel:     cfg.label,
          zoneType:      cfg.type,
          ret3m:         ret(fwdClose(3)),
          ret6m:         ret(fwdClose(6)),
          ret12m:        ret(fwdClose(12)),
          ret18m:        ret(fwdClose(18)),
          maxDrawdown:   maxDd !== null ? parseFloat(maxDd.toFixed(2)) : null,
        });
      }
    }

    extremeEvents.sort((a, b) => a.date.localeCompare(b.date));

    const byType   = (t: AdZoneEvent["zoneType"]) => extremeEvents.filter((e) => e.zoneType === t);
    const zoneStats = {
      bear:       buildZoneStats(byType("bear")),
      bull:       buildZoneStats(byType("bull")),
      strongBull: buildZoneStats(byType("strongBull")),
    };

    // 6. Weekly aggregation: Σadvances / Σdeclines per ISO week (Monday key)
    const weekAdAccum = new Map<string, { advances: number; declines: number }>();
    for (const b of allBars) {
      const d      = new Date(b.date + "T00:00:00Z");
      const day    = d.getUTCDay();
      const toMon  = day === 0 ? 6 : day - 1;
      const monKey = new Date(d.getTime() - toMon * 86400000).toISOString().slice(0, 10);
      const w = weekAdAccum.get(monKey);
      if (w) { w.advances += b.advances; w.declines += b.declines; }
      else weekAdAccum.set(monKey, { advances: b.advances, declines: b.declines });
    }
    const weeklyBars: AdWeeklyBar[] = Array.from(weekAdAccum.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { advances, declines }]) => ({
        date,
        ratio: parseFloat((advances / Math.max(declines, 1)).toFixed(3)),
      }));

    const weeklyNifty100Bars = toWeekly(niftyBarsRaw);

    // Forward return helper — calendar-day offset with ±7 day trading-day scan
    const fwdCloseDaily = (dateStr: string, calDays: number): number | null => {
      const baseMs = new Date(dateStr + "T00:00:00Z").getTime();
      for (let offset = 0; offset <= 7; offset++) {
        const key = new Date(baseMs + (calDays + offset) * 86400000).toISOString().slice(0, 10);
        const c   = niftyMap.get(key);
        if (c !== undefined) return c;
      }
      return null;
    };

    // Weekly zone detection: Bear <0.5 | Bull >1.8 — cooldown 2 weeks
    const WEEKLY_ZONES = [
      { type: "bear" as const, label: "Bear (< 0.5)", enter: (r: number) => r < 0.5 },
      { type: "bull" as const, label: "Bull (> 1.8)", enter: (r: number) => r > 1.8 },
    ];

    const weeklyEvents: AdWeeklyEvent[] = [];

    for (const cfg of WEEKLY_ZONES) {
      let cooldown = 0;
      let inZone   = false;

      for (const wb of weeklyBars) {
        const inNow = cfg.enter(wb.ratio);
        if (cooldown > 0) { cooldown--; inZone = inNow; continue; }
        if (!inNow)       { inZone = false; continue; }
        if (inZone)       continue;

        inZone   = true;
        cooldown = 2;

        const entryClose = niftyMap.get(wb.date) ?? 0;
        if (!entryClose) continue;

        const ret = (c: number | null) =>
          c !== null ? parseFloat(((c - entryClose) / entryClose * 100).toFixed(2)) : null;

        // Max drawdown over 6M (182 cal days)
        let maxDd: number | null = null;
        const baseMs = new Date(wb.date + "T00:00:00Z").getTime();
        for (let d = 1; d <= 182; d++) {
          const c = niftyMap.get(new Date(baseMs + d * 86400000).toISOString().slice(0, 10));
          if (c === undefined) continue;
          const dd = (c - entryClose) / entryClose * 100;
          if (maxDd === null || dd < maxDd) maxDd = dd;
        }

        weeklyEvents.push({
          date:          wb.date,
          adRatio:       wb.ratio,
          nifty100Close: entryClose,
          zoneLabel:     cfg.label,
          zoneType:      cfg.type,
          ret15d:        ret(fwdCloseDaily(wb.date, 21)),
          ret1m:         ret(fwdCloseDaily(wb.date, 30)),
          ret2m:         ret(fwdCloseDaily(wb.date, 60)),
          ret3m:         ret(fwdCloseDaily(wb.date, 91)),
          maxDrawdown:   maxDd !== null ? parseFloat(maxDd.toFixed(2)) : null,
        });
      }
    }

    weeklyEvents.sort((a, b) => a.date.localeCompare(b.date));

    const weeklyZoneStats = {
      bear: buildWeeklyZoneStats(weeklyEvents.filter((e) => e.zoneType === "bear")),
      bull: buildWeeklyZoneStats(weeklyEvents.filter((e) => e.zoneType === "bull")),
    };

    // 7. Current stats
    const last        = allBars.at(-1)!;
    const prev20      = allBars.length >= 21 ? allBars[allBars.length - 21] : allBars[0];
    const adLineTrend = last.adLine - prev20.adLine;

    const monthlyRatios  = monthlyBars.map((m) => m.ratio);
    const sortedMonthly  = [...monthlyRatios].sort((a, b) => a - b);
    const percentileRank = Math.round(
      (sortedMonthly.findIndex((v) => v >= last.adRatio) / sortedMonthly.length) * 100
    );

    const last12m  = monthlyRatios.slice(-12);
    const w52High  = parseFloat(Math.max(...last12m).toFixed(2));
    const w52Low   = parseFloat(Math.min(...last12m).toFixed(2));

    const breadthStatus = getBreadthStatus(last.adRatio);
    const breadthTrend: BreadthResponse["breadthTrend"] =
      last.adRatio > last.adRatio20d + 0.05 ? "Improving" :
      last.adRatio < last.adRatio20d - 0.05 ? "Deteriorating" :
      "Stable";

    return NextResponse.json({
      hasData:             true,
      bars:                allBars,
      nifty100Bars:        monthlyNiftyBars,
      currentDate:         last.date,
      currentAdvances:     last.advances,
      currentDeclines:     last.declines,
      currentUnchanged:    last.unchanged,
      currentTotal:        last.total,
      currentRatio:        last.adRatio,
      adLine:              last.adLine,
      ratio20d:            last.adRatio20d,
      adLineTrend:         parseFloat(adLineTrend.toFixed(0)),
      breadthStatus,
      breadthTrend,
      percentileRank,
      weekHigh52Ratio:     w52High,
      weekLow52Ratio:      w52Low,
      extremeEvents,
      zoneStats,
      weeklyBars,
      weeklyNifty100Bars,
      weeklyEvents,
      weeklyZoneStats,
    } satisfies BreadthResponse);

  } catch (err) {
    console.error("[GET /api/breadth]", err);
    return NextResponse.json({ error: "Breadth engine failed" }, { status: 500 });
  }
}
