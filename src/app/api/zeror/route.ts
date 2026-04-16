// GET /api/zeror
// N-year trailing return for Nifty indices.
// "Zero-return" signal: when an index has delivered ≈0% over a multi-year window it often marks
// a significant entry opportunity (or continued malaise). Returns all 4 indices × 4 windows in
// one call so the frontend can toggle without extra round-trips.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ZeroRBar {
  date:   string;
  retNY:  number;   // trailing N-year return in %
}

export interface OHLCBar {
  date:  string;
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export interface ZeroREvent {
  date:       string;
  retNY:      number;
  indexClose: number;
  window:     number;  // years
  zoneLabel:  string;
  zoneType:   "belowZero";
  ret3m:      number | null;
  ret6m:      number | null;
  ret12m:     number | null;
  ret18m:     number | null;
  maxDrawdown: number | null;
}

export interface ZeroRStats {
  totalEvents:  number;
  winRate3m:    number; avgRet3m:  number;
  winRate6m:    number; avgRet6m:  number;
  winRate12m:   number; avgRet12m: number;
  winRate18m:   number; avgRet18m: number;
  avgMaxDrawdown: number;
}

export interface ZeroRWindowData {
  bars:          ZeroRBar[];
  currentRetNY:  number;
  extremeEvents: ZeroREvent[];
  zoneStats: {
    belowZero: ZeroRStats | null;
  };
}

export interface ZeroRIndexData {
  label:       string;
  priceBars:   OHLCBar[];
  currentDate:  string;
  currentClose: number;
  windows: {
    1: ZeroRWindowData;
    2: ZeroRWindowData;
    3: ZeroRWindowData;
    4: ZeroRWindowData;
  };
}

export interface ZeroRResponse {
  hasData: boolean;
  indices: {
    NIFTY50:       ZeroRIndexData;
    NIFTY100:      ZeroRIndexData;
    NIFTY500:      ZeroRIndexData;
    NIFTY_SMALLCAP: ZeroRIndexData;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INDEX_META: Record<string, string> = {
  NIFTY50:        "Nifty 50",
  NIFTY100:       "Nifty 100",
  NIFTY500:       "Nifty 500",
  NIFTY_SMALLCAP: "Nifty SmallCap 100",
};

const WINDOWS = [1, 2, 3, 4] as const;

const ZONE_CONFIGS: { type: ZeroREvent["zoneType"]; label: string }[] = [
  { type: "belowZero", label: "≤ 0% (Zero or Negative Return)" },
];

// cooldown between events: 180 calendar days (prevents clustering in a long flat period)
const COOLDOWN_DAYS = 180;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildStats(events: ZeroREvent[]): ZeroRStats | null {
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
    totalEvents:   events.length,
    winRate3m:     wr(events.map((e) => e.ret3m)),   avgRet3m:  avg(events.map((e) => e.ret3m)),
    winRate6m:     wr(events.map((e) => e.ret6m)),   avgRet6m:  avg(events.map((e) => e.ret6m)),
    winRate12m:    wr(events.map((e) => e.ret12m)),  avgRet12m: avg(events.map((e) => e.ret12m)),
    winRate18m:    wr(events.map((e) => e.ret18m)),  avgRet18m: avg(events.map((e) => e.ret18m)),
    avgMaxDrawdown: avg(events.map((e) => e.maxDrawdown)),
  };
}

// Nearest trading day within ±15 cal days of target (searches outward from target)
function nearestClose(dateMap: Map<string, number>, targetMs: number): number | null {
  for (let offset = 0; offset <= 15; offset++) {
    for (const sign of [1, -1]) {
      const d = new Date(targetMs + sign * offset * 86_400_000).toISOString().slice(0, 10);
      if (dateMap.has(d)) return dateMap.get(d)!;
    }
  }
  return null;
}

function fwdRet(entryClose: number, fwdClose: number | null): number | null {
  if (fwdClose === null) return null;
  return parseFloat(((fwdClose - entryClose) / entryClose * 100).toFixed(2));
}

// ─── Per-index computation ────────────────────────────────────────────────────

function computeIndex(
  ticker: string,
  priceBars: OHLCBar[],
): ZeroRIndexData {
  const dateMap = new Map<string, number>(priceBars.map((b) => [b.date, b.close]));
  const dates   = priceBars.map((b) => b.date);

  const last  = priceBars.at(-1);
  const currentDate  = last?.date ?? "";
  const currentClose = last?.close ?? 0;

  // Build per-window data
  const windowsResult = {} as ZeroRIndexData["windows"];

  for (const W of WINDOWS) {
    const lookbackMs = W * 365 * 86_400_000;

    // ── Compute trailing return bar series ──
    const bars: ZeroRBar[] = [];
    for (const bar of priceBars) {
      const ms    = new Date(bar.date).getTime();
      const pastC = nearestClose(dateMap, ms - lookbackMs);
      if (pastC === null || pastC === 0) continue;
      bars.push({
        date:  bar.date,
        retNY: parseFloat(((bar.close - pastC) / pastC * 100).toFixed(2)),
      });
    }

    const barMap = new Map<string, number>(bars.map((b) => [b.date, b.retNY]));

    // ── Event detection (per zone, with cooldown) ──
    const allEvents: ZeroREvent[] = [];

    for (const cfg of ZONE_CONFIGS) {
      let lastEventMs = -Infinity;

      for (const bar of bars) {
        const inZone = bar.retNY <= 0;
        if (!inZone) continue;

        const barMs = new Date(bar.date).getTime();
        if (barMs - lastEventMs < COOLDOWN_DAYS * 86_400_000) continue;

        // Check it just entered the zone (previous bar outside) — or is initial entry
        const prevIdx = dates.indexOf(bar.date) - 1;
        if (prevIdx >= 0) {
          const prevRet = barMap.get(dates[prevIdx]);
          if (prevRet !== undefined && prevRet <= 0) continue; // already was in zone
        }

        lastEventMs = barMs;

        const entryClose = currentClose > 0
          ? (priceBars.find((p) => p.date === bar.date)?.close ?? 0)
          : 0;
        if (!entryClose) continue;

        const fwd = (calDays: number) => nearestClose(dateMap, barMs + calDays * 86_400_000);
        const ret = (calDays: number) => fwdRet(entryClose, fwd(calDays));

        // Max drawdown over next 18 months
        let maxDd: number | null = null;
        for (let d = 1; d <= 548; d += 3) {
          const c = nearestClose(dateMap, barMs + d * 86_400_000);
          if (c === null) continue;
          const dd = (c - entryClose) / entryClose * 100;
          if (maxDd === null || dd < maxDd) maxDd = dd;
        }

        allEvents.push({
          date:        bar.date,
          retNY:       bar.retNY,
          indexClose:  entryClose,
          window:      W,
          zoneLabel:   cfg.label,
          zoneType:    cfg.type,
          ret3m:       ret(91),
          ret6m:       ret(182),
          ret12m:      ret(365),
          ret18m:      ret(548),
          maxDrawdown: maxDd !== null ? parseFloat(maxDd.toFixed(2)) : null,
        });
      }
    }

    allEvents.sort((a, b) => a.date.localeCompare(b.date));

    const byZone = (t: ZeroREvent["zoneType"]) => allEvents.filter((e) => e.zoneType === t);

    const currentRetNY = bars.at(-1)?.retNY ?? 0;

    windowsResult[W] = {
      bars,
      currentRetNY,
      extremeEvents: allEvents,
      zoneStats: {
        belowZero: buildStats(byZone("belowZero")),
      },
    };
  }

  return {
    label:        INDEX_META[ticker] ?? ticker,
    priceBars,
    currentDate,
    currentClose,
    windows: windowsResult,
  };
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // Fetch all 4 indices in parallel
    const tickers = Object.keys(INDEX_META);
    const assetResults = await Promise.all(
      tickers.map((ticker) =>
        prisma.asset.findUnique({
          where:   { ticker },
          include: {
            priceData: {
              where:   { timestamp: { gte: new Date("2005-01-01") } },
              orderBy: { timestamp: "asc" },
              select:  { timestamp: true, open: true, high: true, low: true, close: true },
            },
          },
        })
      )
    );

    // Check we have at least Nifty50 data
    const nifty50Idx = tickers.indexOf("NIFTY50");
    if (!assetResults[nifty50Idx] || assetResults[nifty50Idx]!.priceData.length < 200) {
      return NextResponse.json({ hasData: false } satisfies Partial<ZeroRResponse>);
    }

    const indicesResult = {} as ZeroRResponse["indices"];

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i] as keyof ZeroRResponse["indices"];
      const asset  = assetResults[i];
      if (!asset || asset.priceData.length < 50) {
        // Provide empty placeholder so the key still exists
        indicesResult[ticker] = {
          label:        INDEX_META[ticker],
          priceBars:    [],
          currentDate:  "",
          currentClose: 0,
          windows: { 1: { bars: [], currentRetNY: 0, extremeEvents: [], zoneStats: { belowZero: null } },
                     2: { bars: [], currentRetNY: 0, extremeEvents: [], zoneStats: { belowZero: null } },
                     3: { bars: [], currentRetNY: 0, extremeEvents: [], zoneStats: { belowZero: null } },
                     4: { bars: [], currentRetNY: 0, extremeEvents: [], zoneStats: { belowZero: null } } },
        };
        continue;
      }

      const priceBars: OHLCBar[] = asset.priceData.map((p) => ({
        date:  p.timestamp.toISOString().slice(0, 10),
        open:  p.open,
        high:  p.high,
        low:   p.low,
        close: p.close,
      }));

      indicesResult[ticker] = computeIndex(ticker, priceBars);
    }

    return NextResponse.json({
      hasData: true,
      indices: indicesResult,
    } satisfies ZeroRResponse);

  } catch (err) {
    console.error("[GET /api/zeror]", err);
    return NextResponse.json({ error: "ZeroR engine failed" }, { status: 500 });
  }
}
