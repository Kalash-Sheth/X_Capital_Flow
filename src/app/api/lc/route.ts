// GET /api/lc
// % of Nifty 500 stocks hitting Lower Circuit (approximation) × Nifty 500 index OHLC.
//
// LC approximation:
//   (close - prev_close) / prev_close  ≤  -0.09   (dropped ≥ 9%)
//   Most Nifty 500 mid/small caps have 10% lower circuit limits — a ≥9% drop
//   is the closest proxy for a stock being locked at its lower circuit.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LcBar {
  date:     string;
  lcCount:  number;
  total:    number;
  pctLc:    number;   // lcCount / total * 100
}

export interface LcEvent {
  date:          string;
  pctLc:         number;
  nifty500Close: number;
  zoneLabel:     string;
  zoneType:      "extremePanic25" | "extremePanic10" | "extremePanic5" | "extremePanic";
  ret7d:         number | null;
  ret30d:        number | null;
  ret3m:         number | null;
  ret6m:         number | null;
  ret12m:        number | null;
  maxDrawdown:   number | null;
}

export interface LcStats {
  totalEvents:    number;
  winRate7d:      number; avgRet7d:   number;
  winRate30d:     number; avgRet30d:  number;
  winRate3m:      number; avgRet3m:   number;
  winRate6m:      number; avgRet6m:   number;
  winRate12m:     number; avgRet12m:  number;
  avgMaxDrawdown: number;
}

export interface Nifty500DailyBar {
  date:  string;
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export type LcStatus = "Extreme Panic" | "High Stress" | "Elevated" | "Normal";

export interface LcResponse {
  hasData:        boolean;
  bars:           LcBar[];
  nifty500Bars:   Nifty500DailyBar[];
  currentDate:    string;
  currentPctLc:   number;
  currentLcCount: number;
  currentTotal:   number;
  lcStatus:       LcStatus;
  extremeEvents:  LcEvent[];
  zoneStats: {
    extremePanic25: LcStats | null;
    extremePanic10: LcStats | null;
    extremePanic5:  LcStats | null;
    extremePanic:   LcStats | null;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────


function buildLcStats(events: LcEvent[]): LcStats | null {
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
    winRate7d:      wr(events.map((e) => e.ret7d)),   avgRet7d:   avg(events.map((e) => e.ret7d)),
    winRate30d:     wr(events.map((e) => e.ret30d)),  avgRet30d:  avg(events.map((e) => e.ret30d)),
    winRate3m:      wr(events.map((e) => e.ret3m)),   avgRet3m:   avg(events.map((e) => e.ret3m)),
    winRate6m:      wr(events.map((e) => e.ret6m)),   avgRet6m:   avg(events.map((e) => e.ret6m)),
    winRate12m:     wr(events.map((e) => e.ret12m)),  avgRet12m:  avg(events.map((e) => e.ret12m)),
    avgMaxDrawdown: avg(events.map((e) => e.maxDrawdown)),
  };
}

function getLcStatus(pct: number): LcStatus {
  if (pct >= 2.5) return "Extreme Panic";
  if (pct > 0)    return "Elevated";
  return "Normal";
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // 1. Compute daily % of Nifty 500 stocks hitting lower circuit approximation.
    //    LC criteria: daily return ≤ -9%  (proxy for 10% lower circuit — most common
    //    circuit limit for Nifty 500 mid/small caps). No close-near-low filter needed.
    const rows = await prisma.$queryRaw<
      { date: Date; lc_count: bigint; total: bigint }[]
    >`
      WITH lagged AS (
        SELECT
          "stockId",
          date,
          close,
          LAG(close) OVER (PARTITION BY "stockId" ORDER BY date) AS prev_close
        FROM "Nifty500Price"
      ),
      flags AS (
        SELECT
          date,
          CASE
            WHEN prev_close IS NOT NULL
              AND close > 0
              AND prev_close > 0
              AND (close - prev_close) / prev_close <= -0.09
            THEN 1 ELSE 0
          END AS is_lc,
          CASE WHEN prev_close IS NOT NULL THEN 1 ELSE 0 END AS counted
        FROM lagged
      )
      SELECT
        date,
        SUM(is_lc)::bigint   AS lc_count,
        SUM(counted)::bigint AS total
      FROM flags
      WHERE date >= '2010-01-01'
      GROUP BY date
      HAVING SUM(counted) >= 250
      ORDER BY date
    `;

    if (!rows || rows.length < 10) {
      return NextResponse.json({ hasData: false } satisfies Partial<LcResponse>);
    }

    // 2. Build daily bar array
    const allBars: LcBar[] = rows.map((r) => ({
      date:    r.date.toISOString().slice(0, 10),
      lcCount: Number(r.lc_count),
      total:   Number(r.total),
      pctLc:   parseFloat((Number(r.lc_count) / Number(r.total) * 100).toFixed(2)),
    }));

    // 3. Nifty 500 index prices for chart + forward return lookups
    const niftyAsset = await prisma.asset.findUnique({
      where:   { ticker: "NIFTY500" },
      include: { priceData: { orderBy: { timestamp: "asc" }, select: { timestamp: true, open: true, high: true, low: true, close: true } } },
    });

    const niftyBarsRaw = (niftyAsset?.priceData ?? []).map((p) => ({
      date: p.timestamp.toISOString().slice(0, 10),
      open: p.open, high: p.high, low: p.low, close: p.close,
    }));

    const niftyDailyMap    = new Map<string, number>(niftyBarsRaw.map((b) => [b.date, b.close]));

    // Nearest trading day within ±7 cal days
    const fwdClose = (fromDate: string, calDays: number): number | null => {
      const target = new Date(new Date(fromDate).getTime() + calDays * 86_400_000).toISOString().slice(0, 10);
      for (let offset = 0; offset <= 7; offset++) {
        for (const sign of [1, -1]) {
          const d = new Date(new Date(target).getTime() + sign * offset * 86_400_000).toISOString().slice(0, 10);
          if (niftyDailyMap.has(d)) return niftyDailyMap.get(d)!;
        }
      }
      return null;
    };

    // 4. Zone event detection on daily bars (cooldown = 5 trading days)
    const ZONE_CONFIGS: { type: LcEvent["zoneType"]; label: string; enter: (p: number) => boolean }[] = [
      { type: "extremePanic25", label: "Extreme Panic (≥ 25%)",    enter: (p) => p >= 25              },
      { type: "extremePanic10", label: "Extreme Panic (10%–25%)",  enter: (p) => p >= 10 && p < 25  },
      { type: "extremePanic5",  label: "Extreme Panic (5%–10%)",   enter: (p) => p >= 5  && p < 10  },
      { type: "extremePanic",   label: "Extreme Panic (2.5%–5%)",  enter: (p) => p >= 2.5 && p < 5  },
    ];

    const extremeEvents: LcEvent[] = [];

    for (const cfg of ZONE_CONFIGS) {
      let cooldown = 0;
      let inZone   = false;

      for (const bar of allBars) {
        const inNow = cfg.enter(bar.pctLc);

        if (cooldown > 0) { cooldown--; inZone = inNow; continue; }
        if (!inNow)       { inZone = false; continue; }
        if (inZone)       continue;

        inZone   = true;
        cooldown = 5;  // ~1 week cooldown

        const entryClose = niftyDailyMap.get(bar.date) ?? 0;
        if (!entryClose) continue;

        const ret = (c: number | null) =>
          c !== null ? parseFloat(((c - entryClose) / entryClose * 100).toFixed(2)) : null;

        // Max drawdown over next 12 months (~365 cal days, sampled daily)
        let maxDd: number | null = null;
        for (let d = 1; d <= 365; d++) {
          const c = fwdClose(bar.date, d);
          if (c === null) continue;
          const dd = (c - entryClose) / entryClose * 100;
          if (maxDd === null || dd < maxDd) maxDd = dd;
        }

        extremeEvents.push({
          date:          bar.date,
          pctLc:         bar.pctLc,
          nifty500Close: entryClose,
          zoneLabel:     cfg.label,
          zoneType:      cfg.type,
          ret7d:         ret(fwdClose(bar.date, 7)),
          ret30d:        ret(fwdClose(bar.date, 30)),
          ret3m:         ret(fwdClose(bar.date, 91)),
          ret6m:         ret(fwdClose(bar.date, 182)),
          ret12m:        ret(fwdClose(bar.date, 365)),
          maxDrawdown:   maxDd !== null ? parseFloat(maxDd.toFixed(2)) : null,
        });
      }
    }

    extremeEvents.sort((a, b) => a.date.localeCompare(b.date));

    // 5. Zone stats
    const byType   = (t: LcEvent["zoneType"]) => extremeEvents.filter((e) => e.zoneType === t);
    const zoneStats = {
      extremePanic25: buildLcStats(byType("extremePanic25")),
      extremePanic10: buildLcStats(byType("extremePanic10")),
      extremePanic5:  buildLcStats(byType("extremePanic5")),
      extremePanic:   buildLcStats(byType("extremePanic")),
    };

    // 6. Current values
    const last     = allBars.at(-1)!;
    const lcStatus = getLcStatus(last.pctLc);

    return NextResponse.json({
      hasData:        true,
      bars:           allBars,
      nifty500Bars:   niftyBarsRaw,
      currentDate:    last.date,
      currentPctLc:   last.pctLc,
      currentLcCount: last.lcCount,
      currentTotal:   last.total,
      lcStatus,
      extremeEvents,
      zoneStats,
    } satisfies LcResponse);

  } catch (err) {
    console.error("[GET /api/lc]", err);
    return NextResponse.json({ error: "LC engine failed" }, { status: 500 });
  }
}
