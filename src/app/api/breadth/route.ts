// GET /api/breadth
// Nifty 100 Market Breadth — Advance / Decline Ratio
// Daily:   per-day A/D ratio → zones <0.05 | 0.05-0.1 | 7-10 | >10
// Weekly:  Σadvances / Σdeclines per ISO week → zones <0.3 | 0.3-0.5 | 1.8-2.5 | >2.5

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
  zoneType:       "bear005" | "bear01" | "bull7" | "bull10";
  ret15d:         number | null;
  ret1m:          number | null;
  ret2m:          number | null;
  ret3m:          number | null;
  ret6m:          number | null;
  maxDrawdown:    number | null;
}

export interface AdZoneStats {
  totalEvents:    number;
  winRate15d:     number; avgRet15d: number;
  winRate1m:      number; avgRet1m:  number;
  winRate2m:      number; avgRet2m:  number;
  winRate3m:      number; avgRet3m:  number;
  winRate6m:      number; avgRet6m:  number;
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
  zoneType:      "bear03" | "bear05" | "bull18" | "bull25";
  ret15d:        number | null;   // ~15 trading days (≈21 cal days)
  ret1m:         number | null;   // 1 month  (30 cal days)
  ret2m:         number | null;   // 2 months (60 cal days)
  ret3m:         number | null;   // 3 months (91 cal days)
  ret6m:         number | null;   // 6 months (182 cal days)
  maxDrawdown:   number | null;
}

export interface AdWeeklyStats {
  totalEvents:    number;
  winRate15d:     number; avgRet15d: number;
  winRate1m:      number; avgRet1m:  number;
  winRate2m:      number; avgRet2m:  number;
  winRate3m:      number; avgRet3m:  number;
  winRate6m:      number; avgRet6m:  number;
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
  nifty100Bars:        Nifty100Bar[];     // daily OHLC for daily chart
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
    bear005: AdZoneStats | null;
    bear01:  AdZoneStats | null;
    bull7:   AdZoneStats | null;
    bull10:  AdZoneStats | null;
  };
  // ── Weekly view ──
  weeklyBars:          AdWeeklyBar[];
  weeklyNifty100Bars:  Nifty100Bar[];    // weekly OHLC for weekly chart
  weeklyEvents:        AdWeeklyEvent[];
  weeklyZoneStats: {
    bear03: AdWeeklyStats | null;
    bear05: AdWeeklyStats | null;
    bull18: AdWeeklyStats | null;
    bull25: AdWeeklyStats | null;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sma(arr: number[], end: number, period: number): number {
  if (end < period - 1) return 0;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) s += arr[i];
  return parseFloat((s / period).toFixed(3));
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
    winRate15d:     wr(events.map((e) => e.ret15d)),  avgRet15d: avg(events.map((e) => e.ret15d)),
    winRate1m:      wr(events.map((e) => e.ret1m)),   avgRet1m:  avg(events.map((e) => e.ret1m)),
    winRate2m:      wr(events.map((e) => e.ret2m)),   avgRet2m:  avg(events.map((e) => e.ret2m)),
    winRate3m:      wr(events.map((e) => e.ret3m)),   avgRet3m:  avg(events.map((e) => e.ret3m)),
    winRate6m:      wr(events.map((e) => e.ret6m)),   avgRet6m:  avg(events.map((e) => e.ret6m)),
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
    winRate1m:      wr(events.map((e) => e.ret1m)),   avgRet1m:  avg(events.map((e) => e.ret1m)),
    winRate2m:      wr(events.map((e) => e.ret2m)),   avgRet2m:  avg(events.map((e) => e.ret2m)),
    winRate3m:      wr(events.map((e) => e.ret3m)),   avgRet3m:  avg(events.map((e) => e.ret3m)),
    winRate6m:      wr(events.map((e) => e.ret6m)),   avgRet6m:  avg(events.map((e) => e.ret6m)),
    avgMaxDrawdown: avg(events.map((e) => e.maxDrawdown)),
  };
}

function getBreadthStatus(ratio: number): BreadthStatus {
  if (ratio > 2.5)  return "Strong Bull";
  if (ratio > 1.8)  return "Bull";
  if (ratio >= 0.5) return "Neutral";
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

    // 2. NIFTY100 index daily prices
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

    // 4. Forward return helper — calendar-day offset with ±7 day trading-day scan
    const fwdCloseDaily = (dateStr: string, calDays: number): number | null => {
      const baseMs = new Date(dateStr + "T00:00:00Z").getTime();
      for (let offset = 0; offset <= 7; offset++) {
        const key = new Date(baseMs + (calDays + offset) * 86400000).toISOString().slice(0, 10);
        const c   = niftyMap.get(key);
        if (c !== undefined) return c;
      }
      return null;
    };

    // 5. Daily zone detection: 5-day cooldown per zone
    // bear005: <0.05 | bear01: 0.05-0.1 | bull7: 7-10 | bull10: >10
    const ZONE_CONFIGS: { type: AdZoneEvent["zoneType"]; label: string; enter: (r: number) => boolean }[] = [
      { type: "bear005", label: "Bear (< 0.05)",   enter: (r) => r < 0.05              },
      { type: "bear01",  label: "Bear (0.05–0.1)", enter: (r) => r >= 0.05 && r < 0.1 },
      { type: "bull7",   label: "Bull (7–10)",     enter: (r) => r >= 7.0 && r < 10.0 },
      { type: "bull10",  label: "Bull (> 10)",     enter: (r) => r >= 10.0             },
    ];

    const extremeEvents: AdZoneEvent[] = [];

    for (const cfg of ZONE_CONFIGS) {
      let cooldown = 0;
      let inZone   = false;

      for (const db of allBars) {
        const inNow = cfg.enter(db.adRatio);
        if (cooldown > 0) { cooldown--; inZone = inNow; continue; }
        if (!inNow)       { inZone = false; continue; }
        if (inZone)       continue;

        inZone   = true;
        cooldown = 5;

        const entryClose = niftyMap.get(db.date) ?? 0;
        if (!entryClose) continue;

        const ret = (c: number | null) =>
          c !== null ? parseFloat(((c - entryClose) / entryClose * 100).toFixed(2)) : null;

        // Max drawdown over 3M (91 cal days)
        let maxDd: number | null = null;
        const baseMs = new Date(db.date + "T00:00:00Z").getTime();
        for (let d = 1; d <= 91; d++) {
          const c = niftyMap.get(new Date(baseMs + d * 86400000).toISOString().slice(0, 10));
          if (c === undefined) continue;
          const dd = (c - entryClose) / entryClose * 100;
          if (maxDd === null || dd < maxDd) maxDd = dd;
        }

        extremeEvents.push({
          date:          db.date,
          adRatio:       db.adRatio,
          nifty100Close: entryClose,
          zoneLabel:     cfg.label,
          zoneType:      cfg.type,
          ret15d:        ret(fwdCloseDaily(db.date, 21)),
          ret1m:         ret(fwdCloseDaily(db.date, 30)),
          ret2m:         ret(fwdCloseDaily(db.date, 60)),
          ret3m:         ret(fwdCloseDaily(db.date, 91)),
          ret6m:         ret(fwdCloseDaily(db.date, 182)),
          maxDrawdown:   maxDd !== null ? parseFloat(maxDd.toFixed(2)) : null,
        });
      }
    }

    extremeEvents.sort((a, b) => a.date.localeCompare(b.date));

    const byType   = (t: AdZoneEvent["zoneType"]) => extremeEvents.filter((e) => e.zoneType === t);
    const zoneStats = {
      bear005: buildZoneStats(byType("bear005")),
      bear01:  buildZoneStats(byType("bear01")),
      bull7:   buildZoneStats(byType("bull7")),
      bull10:  buildZoneStats(byType("bull10")),
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

    // Weekly zone detection: <0.3 | 0.3-0.5 | 1.8-2.5 | >2.5 — cooldown 2 weeks
    const WEEKLY_ZONES: { type: AdWeeklyEvent["zoneType"]; label: string; enter: (r: number) => boolean }[] = [
      { type: "bear03", label: "Bear (< 0.3)",     enter: (r) => r < 0.3              },
      { type: "bear05", label: "Bear (0.3 – 0.5)", enter: (r) => r >= 0.3 && r < 0.5 },
      { type: "bull18", label: "Bull (1.8 – 2.5)", enter: (r) => r >= 1.8 && r < 2.5 },
      { type: "bull25", label: "Bull (> 2.5)",     enter: (r) => r >= 2.5             },
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
          ret6m:         ret(fwdCloseDaily(wb.date, 182)),
          maxDrawdown:   maxDd !== null ? parseFloat(maxDd.toFixed(2)) : null,
        });
      }
    }

    weeklyEvents.sort((a, b) => a.date.localeCompare(b.date));

    const weeklyZoneStats = {
      bear03: buildWeeklyZoneStats(weeklyEvents.filter((e) => e.zoneType === "bear03")),
      bear05: buildWeeklyZoneStats(weeklyEvents.filter((e) => e.zoneType === "bear05")),
      bull18: buildWeeklyZoneStats(weeklyEvents.filter((e) => e.zoneType === "bull18")),
      bull25: buildWeeklyZoneStats(weeklyEvents.filter((e) => e.zoneType === "bull25")),
    };

    // 7. Current stats
    const last        = allBars.at(-1)!;
    const prev20      = allBars.length >= 21 ? allBars[allBars.length - 21] : allBars[0];
    const adLineTrend = last.adLine - prev20.adLine;

    const allRatios      = allBars.map((b) => b.adRatio);
    const sortedRatios   = [...allRatios].sort((a, b) => a - b);
    const percentileRank = Math.round(
      (sortedRatios.findIndex((v) => v >= last.adRatio) / sortedRatios.length) * 100
    );

    const last252  = allRatios.slice(-252);
    const w52High  = parseFloat(Math.max(...last252).toFixed(2));
    const w52Low   = parseFloat(Math.min(...last252).toFixed(2));

    const breadthStatus = getBreadthStatus(last.adRatio);
    const breadthTrend: BreadthResponse["breadthTrend"] =
      last.adRatio > last.adRatio20d + 0.05 ? "Improving" :
      last.adRatio < last.adRatio20d - 0.05 ? "Deteriorating" :
      "Stable";

    return NextResponse.json({
      hasData:             true,
      bars:                allBars,
      nifty100Bars:        niftyBarsRaw,
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
