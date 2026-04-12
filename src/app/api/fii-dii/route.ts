// GET /api/fii-dii
// Returns FII/DII institutional equity cash-market flows from NeonDB.
// Data is written by: python3 scripts/fetch_prices.py --fii
// Stored as Indicator rows (FII_NET_CRORE, DII_NET_CRORE, etc.) under NIFTY50.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export interface FiiDiiDay {
  date:        string;   // YYYY-MM-DD
  fiiNet:      number;   // ₹ Crores, negative = net selling
  fiiBuy:      number;
  fiiSell:     number;
  diiNet:      number;
  diiBuy:      number;
  diiSell:     number;
  combined:    number;   // fiiNet + diiNet
}

export interface FiiDiiResponse {
  days:           FiiDiiDay[];
  cumFii20D:      number;   // cumulative FII net over last 20 trading days
  cumDii20D:      number;
  avgDailyFii5D:  number;   // avg daily FII net last 5 days
  avgDailyDii5D:  number;
  fiTrend:        "Buying" | "Selling" | "Mixed";
  diiTrend:       "Buying" | "Selling" | "Mixed";
  lastDate:       string | null;
  hasData:        boolean;
}

export async function GET() {
  try {
    const nifty = await prisma.asset.findUnique({
      where: { ticker: "NIFTY50" },
      include: {
        indicators: {
          where: {
            name: {
              in: [
                "FII_NET_CRORE", "FII_BUY_CRORE", "FII_SELL_CRORE",
                "DII_NET_CRORE", "DII_BUY_CRORE", "DII_SELL_CRORE",
              ],
            },
          },
          orderBy: { timestamp: "desc" },
          take: 200,  // ~30 trading days × 6 indicator types
        },
      },
    });

    if (!nifty?.indicators.length) {
      return NextResponse.json({
        days: [], cumFii20D: 0, cumDii20D: 0,
        avgDailyFii5D: 0, avgDailyDii5D: 0,
        fiTrend: "Mixed", diiTrend: "Mixed",
        lastDate: null, hasData: false,
      } satisfies FiiDiiResponse);
    }

    // Group indicators by date
    const byDate: Record<string, Record<string, number>> = {};
    for (const ind of nifty.indicators) {
      const d = ind.timestamp.toISOString().slice(0, 10);
      if (!byDate[d]) byDate[d] = {};
      byDate[d][ind.name] = ind.value;
    }

    // Build sorted day array (most recent last)
    const days: FiiDiiDay[] = Object.entries(byDate)
      .map(([date, vals]) => ({
        date,
        fiiNet:   vals["FII_NET_CRORE"]  ?? 0,
        fiiBuy:   vals["FII_BUY_CRORE"]  ?? 0,
        fiiSell:  vals["FII_SELL_CRORE"] ?? 0,
        diiNet:   vals["DII_NET_CRORE"]  ?? 0,
        diiBuy:   vals["DII_BUY_CRORE"]  ?? 0,
        diiSell:  vals["DII_SELL_CRORE"] ?? 0,
        combined: (vals["FII_NET_CRORE"] ?? 0) + (vals["DII_NET_CRORE"] ?? 0),
      }))
      .filter(d => d.fiiNet !== 0 || d.diiNet !== 0)  // skip empty days
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!days.length) {
      return NextResponse.json({
        days: [], cumFii20D: 0, cumDii20D: 0,
        avgDailyFii5D: 0, avgDailyDii5D: 0,
        fiTrend: "Mixed", diiTrend: "Mixed",
        lastDate: null, hasData: false,
      } satisfies FiiDiiResponse);
    }

    const last20 = days.slice(-20);
    const last5  = days.slice(-5);

    const cumFii20D     = parseFloat(last20.reduce((s, d) => s + d.fiiNet, 0).toFixed(2));
    const cumDii20D     = parseFloat(last20.reduce((s, d) => s + d.diiNet, 0).toFixed(2));
    const avgDailyFii5D = parseFloat((last5.reduce((s, d) => s + d.fiiNet, 0) / (last5.length || 1)).toFixed(2));
    const avgDailyDii5D = parseFloat((last5.reduce((s, d) => s + d.diiNet, 0) / (last5.length || 1)).toFixed(2));

    const fiTrend: FiiDiiResponse["fiTrend"] =
      avgDailyFii5D > 500  ? "Buying"  :
      avgDailyFii5D < -500 ? "Selling" : "Mixed";

    const diiTrend: FiiDiiResponse["diiTrend"] =
      avgDailyDii5D > 500  ? "Buying"  :
      avgDailyDii5D < -500 ? "Selling" : "Mixed";

    return NextResponse.json({
      days,
      cumFii20D,
      cumDii20D,
      avgDailyFii5D,
      avgDailyDii5D,
      fiTrend,
      diiTrend,
      lastDate: days[days.length - 1]?.date ?? null,
      hasData: true,
    } satisfies FiiDiiResponse);
  } catch (err) {
    console.error("[GET /api/fii-dii]", err);
    return NextResponse.json({ error: "Failed to fetch FII/DII data" }, { status: 500 });
  }
}
