// GET /api/dma200
// % of Nifty 500 stocks trading above their 200-day SMA × Nifty 500 index OHLC.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Dma200Bar {
  date:     string;
  above:    number;
  total:    number;
  pctAbove: number;   // above / total * 100
}

export interface Dma200ZoneEvent {
  date:           string;
  pctAbove:       number;
  nifty500Close:  number;
  zoneLabel:      string;
  zoneType:       "strongBear" | "bear" | "bull" | "strongBull";
  ret1m:          number | null;
  ret3m:          number | null;
  ret6m:          number | null;
  ret12m:         number | null;
  ret18m:         number | null;
  maxDrawdown:    number | null;
}

export interface Dma200ZoneStats {
  totalEvents:    number;
  winRate1m:      number; avgRet1m:   number;
  winRate3m:      number; avgRet3m:   number;
  winRate6m:      number; avgRet6m:   number;
  winRate12m:     number; avgRet12m:  number;
  winRate18m:     number; avgRet18m:  number;
  avgMaxDrawdown: number;
}

export interface Nifty500MonthlyBar {
  date:  string;
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export type Dma200Status = "Strong Bull" | "Bull" | "Neutral" | "Bear" | "Strong Bear";

export interface Dma200Response {
  hasData:         boolean;
  bars:            Dma200Bar[];
  nifty500Bars:    Nifty500MonthlyBar[];
  currentDate:     string;
  currentPctAbove: number;
  currentAbove:    number;
  currentTotal:    number;
  dmaStatus:       Dma200Status;
  dmaTrend:        "Improving" | "Deteriorating" | "Stable";
  percentileRank:  number;
  extremeEvents:   Dma200ZoneEvent[];
  zoneStats: {
    strongBear: Dma200ZoneStats | null;
    bear:       Dma200ZoneStats | null;
    bull:       Dma200ZoneStats | null;
    strongBull: Dma200ZoneStats | null;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toMonthly(bars: { date: string; open: number; high: number; low: number; close: number }[]): Nifty500MonthlyBar[] {
  const groups = new Map<string, Nifty500MonthlyBar>();
  for (const b of bars) {
    const key = b.date.slice(0, 7) + "-01";
    const ex  = groups.get(key);
    if (!ex) groups.set(key, { ...b, date: key });
    else { ex.high = Math.max(ex.high, b.high); ex.low = Math.min(ex.low, b.low); ex.close = b.close; }
  }
  return Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function buildZoneStats(events: Dma200ZoneEvent[]): Dma200ZoneStats | null {
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
    winRate1m:      wr(events.map((e) => e.ret1m)),   avgRet1m:   avg(events.map((e) => e.ret1m)),
    winRate3m:      wr(events.map((e) => e.ret3m)),   avgRet3m:   avg(events.map((e) => e.ret3m)),
    winRate6m:      wr(events.map((e) => e.ret6m)),   avgRet6m:   avg(events.map((e) => e.ret6m)),
    winRate12m:     wr(events.map((e) => e.ret12m)),  avgRet12m:  avg(events.map((e) => e.ret12m)),
    winRate18m:     wr(events.map((e) => e.ret18m)),  avgRet18m:  avg(events.map((e) => e.ret18m)),
    avgMaxDrawdown: avg(events.map((e) => e.maxDrawdown)),
  };
}

function getDmaStatus(pct: number): Dma200Status {
  if (pct >= 80) return "Strong Bull";
  if (pct >= 60) return "Bull";
  if (pct >= 40) return "Neutral";
  if (pct >= 20) return "Bear";
  return "Strong Bear";
}

function addMonths(ym01: string, n: number): string {
  const y = parseInt(ym01.slice(0, 4), 10);
  const m = parseInt(ym01.slice(5, 7), 10) - 1;
  const d = new Date(y, m + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // 1. Compute daily % of Nifty 500 stocks above their 200-day SMA.
    //    No inner date filter so the window has full 200-bar history from the start of data.
    //    The cnt >= 200 guard ensures only stocks with a complete 200-day window are counted.
    //    Output is limited to the last 3800 calendar days in the outer WHERE.
    const rows = await prisma.$queryRaw<
      { date: Date; above: bigint; total: bigint }[]
    >`
      WITH sma AS (
        SELECT "stockId", date, close,
          AVG(close) OVER (
            PARTITION BY "stockId"
            ORDER BY date
            ROWS BETWEEN 199 PRECEDING AND CURRENT ROW
          ) AS sma200,
          COUNT(*) OVER (
            PARTITION BY "stockId"
            ORDER BY date
            ROWS BETWEEN 199 PRECEDING AND CURRENT ROW
          ) AS cnt
        FROM "Nifty500Price"
      ),
      daily AS (
        SELECT date,
          SUM(CASE WHEN cnt >= 200 AND close > sma200 THEN 1 ELSE 0 END)::bigint AS above,
          SUM(CASE WHEN cnt >= 200               THEN 1 ELSE 0 END)::bigint AS total
        FROM sma
        GROUP BY date
        HAVING SUM(CASE WHEN cnt >= 200 THEN 1 ELSE 0 END) >= 250
      )
      SELECT * FROM daily
      WHERE date >= '2010-01-01'
      ORDER BY date
    `;

    if (!rows || rows.length < 10) {
      return NextResponse.json({ hasData: false } satisfies Partial<Dma200Response>);
    }

    // 2. Build daily bar array
    const allBars: Dma200Bar[] = rows.map((r) => ({
      date:     r.date.toISOString().slice(0, 10),
      above:    Number(r.above),
      total:    Number(r.total),
      pctAbove: parseFloat((Number(r.above) / Number(r.total) * 100).toFixed(1)),
    }));

    // 3. Nifty 500 index prices (all history for forward-return look-up)
    const niftyAsset = await prisma.asset.findUnique({
      where:   { ticker: "NIFTY500" },
      include: { priceData: { orderBy: { timestamp: "asc" }, select: { timestamp: true, open: true, high: true, low: true, close: true } } },
    });

    const niftyBarsRaw = (niftyAsset?.priceData ?? []).map((p) => ({
      date: p.timestamp.toISOString().slice(0, 10),
      open: p.open, high: p.high, low: p.low, close: p.close,
    }));

    const monthlyNiftyBars = toMonthly(niftyBarsRaw);
    const niftyMonthlyMap  = new Map<string, number>(monthlyNiftyBars.map((b) => [b.date, b.close]));

    // Daily map + sorted date array for short-term forward returns
    const niftyDailyMap    = new Map<string, number>(niftyBarsRaw.map((b) => [b.date, b.close]));

    // Find closest trading day within ±7 days of target
    const fwdCloseDaily = (fromDate: string, calDays: number): number | null => {
      const from = new Date(fromDate).getTime();
      const target = new Date(from + calDays * 86_400_000).toISOString().slice(0, 10);
      for (let offset = 0; offset <= 7; offset++) {
        for (const sign of [1, -1]) {
          const d = new Date(new Date(target).getTime() + sign * offset * 86_400_000).toISOString().slice(0, 10);
          if (niftyDailyMap.has(d)) return niftyDailyMap.get(d)!;
        }
      }
      return null;
    };

    // 4. Aggregate daily → monthly: use end-of-month value (last trading day per month)
    //    Later dates overwrite earlier ones, so the final value = end-of-month reading.
    const monthAccum = new Map<string, number>();
    for (const b of allBars) {
      monthAccum.set(b.date.slice(0, 7) + "-01", b.pctAbove);
    }
    const monthlyBars = Array.from(monthAccum.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, pctAbove]) => ({ date, pctAbove }));

    // 5. Zone detection on monthly end-of-month readings (mutually exclusive zones)
    const ZONE_CONFIGS: { type: Dma200ZoneEvent["zoneType"]; label: string; enter: (p: number) => boolean }[] = [
      { type: "strongBear", label: "Strong Bear (< 20%)",  enter: (p) => p < 20              },
      { type: "bear",       label: "Bear (20% – 40%)",     enter: (p) => p >= 20 && p < 40   },
      { type: "bull",       label: "Bull (60% – 80%)",     enter: (p) => p > 60  && p <= 80  },
      { type: "strongBull", label: "Strong Bull (> 80%)",  enter: (p) => p > 80              },
    ];

    const extremeEvents: Dma200ZoneEvent[] = [];

    for (const cfg of ZONE_CONFIGS) {
      let cooldown = 0;
      let inZone   = false;

      for (let i = 0; i < monthlyBars.length; i++) {
        const mb    = monthlyBars[i];
        const inNow = cfg.enter(mb.pctAbove);

        if (cooldown > 0) { cooldown--; inZone = inNow; continue; }
        if (!inNow)       { inZone = false; continue; }
        if (inZone)       continue;

        inZone   = true;
        cooldown = 1;

        const entryClose = niftyMonthlyMap.get(mb.date) ?? 0;
        if (!entryClose) continue;

        // Calendar-accurate forward returns
        const fwdClose = (months: number): number | null =>
          niftyMonthlyMap.get(addMonths(mb.date, months)) ?? null;

        const ret = (c: number | null) =>
          c !== null ? parseFloat(((c - entryClose) / entryClose * 100).toFixed(2)) : null;

        // Max drawdown: scan all 18 calendar months, skip gaps
        let maxDd: number | null = null;
        for (let d = 1; d <= 18; d++) {
          const c = niftyMonthlyMap.get(addMonths(mb.date, d));
          if (c === undefined) continue;
          const dd = (c - entryClose) / entryClose * 100;
          if (maxDd === null || dd < maxDd) maxDd = dd;
        }

        extremeEvents.push({
          date:          mb.date,
          pctAbove:      mb.pctAbove,
          nifty500Close: entryClose,
          zoneLabel:     cfg.label,
          zoneType:      cfg.type,
          ret1m:         ret(fwdCloseDaily(mb.date, 30)),
          ret3m:         ret(fwdClose(3)),
          ret6m:         ret(fwdClose(6)),
          ret12m:        ret(fwdClose(12)),
          ret18m:        ret(fwdClose(18)),
          maxDrawdown:   maxDd !== null ? parseFloat(maxDd.toFixed(2)) : null,
        });
      }
    }

    extremeEvents.sort((a, b) => a.date.localeCompare(b.date));

    // 6. Zone stats
    const byType   = (t: Dma200ZoneEvent["zoneType"]) => extremeEvents.filter((e) => e.zoneType === t);
    const zoneStats = {
      strongBear: buildZoneStats(byType("strongBear")),
      bear:       buildZoneStats(byType("bear")),
      bull:       buildZoneStats(byType("bull")),
      strongBull: buildZoneStats(byType("strongBull")),
    };

    // 7. Current stats & percentile rank (monthly distribution)
    const last       = allBars.at(-1)!;
    const prev20     = allBars.length >= 21 ? allBars[allBars.length - 21] : allBars[0];
    const trendDelta = last.pctAbove - prev20.pctAbove;

    const monthlyPcts   = monthlyBars.map((m) => m.pctAbove);
    const sortedPcts    = [...monthlyPcts].sort((a, b) => a - b);
    const percentileRank = Math.round(
      (sortedPcts.findIndex((v) => v >= last.pctAbove) / sortedPcts.length) * 100
    );

    const dmaStatus = getDmaStatus(last.pctAbove);
    const dmaTrend: Dma200Response["dmaTrend"] =
      trendDelta > 2 ? "Improving" : trendDelta < -2 ? "Deteriorating" : "Stable";

    return NextResponse.json({
      hasData:         true,
      bars:            allBars,
      nifty500Bars:    monthlyNiftyBars,
      currentDate:     last.date,
      currentPctAbove: last.pctAbove,
      currentAbove:    last.above,
      currentTotal:    last.total,
      dmaStatus,
      dmaTrend,
      percentileRank,
      extremeEvents,
      zoneStats,
    } satisfies Dma200Response);

  } catch (err) {
    console.error("[GET /api/dma200]", err);
    return NextResponse.json({ error: "DMA200 engine failed" }, { status: 500 });
  }
}
