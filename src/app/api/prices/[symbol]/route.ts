// GET /api/prices/[symbol]?days=365
// Returns real OHLCV history for a given symbol from NeonDB.
// Also returns change1D / prevClose computed server-side so the frontend shows
// the correct Friday change even when the script is run on Sunday.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ symbol: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { symbol: rawSymbol } = await context.params;
    const symbol = rawSymbol.toUpperCase();

    const searchParams = request.nextUrl.searchParams;
    // Allow up to 5 years (1825 trading days) of history
    const days = Math.min(1825, Math.max(1, parseInt(searchParams.get("days") ?? "365", 10) || 365));

    const asset = await prisma.asset.findUnique({
      where: { ticker: symbol },
      include: {
        priceData: {
          orderBy: { timestamp: "desc" },
          // Fetch one extra row so we can compute change1D for the newest bar
          take: days + 1,
        },
      },
    });

    if (!asset) {
      return NextResponse.json(
        { error: `Unknown symbol: ${symbol}` },
        { status: 404 }
      );
    }

    // 1. Drop ALL weekend-date rows — markets never trade on Sat/Sun so any
    //    weekend row is a ghost from the old live-snapshot bug.
    // 2. Deduplicate by calendar date, then sort chronological.
    const cleaned = [...asset.priceData].filter((r) => {
      const dow = r.timestamp.getUTCDay();
      return dow !== 0 && dow !== 6;
    });

    cleaned.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const seen = new Set<string>();
    const deduped = cleaned.filter((row) => {
      const d = row.timestamp.toISOString().slice(0, 10);
      if (seen.has(d)) return false;
      seen.add(d);
      return true;
    });

    // Trim to requested days after dedup
    const trimmed = deduped.slice(-days);

    const data = trimmed.map((row) => ({
      date:      row.timestamp.toISOString().slice(0, 10),
      open:      row.open,
      high:      row.high,
      low:       row.low,
      close:     row.close,
      volume:    row.volume,
      timestamp: row.timestamp.toISOString(),
    }));

    // Server-computed day change: compares last two distinct trading-day closes
    const lastClose = data.at(-1)?.close ?? 0;
    const prevClose = data.at(-2)?.close ?? lastClose;
    const change1D  = prevClose ? ((lastClose - prevClose) / prevClose) * 100 : 0;

    return NextResponse.json({
      symbol,
      name:       asset.name,
      currency:   asset.currency,
      assetClass: asset.assetClass,
      days:       data.length,
      lastClose,
      prevClose,
      change1D:   Math.round(change1D * 100) / 100,
      data,
    });
  } catch (error) {
    console.error("[GET /api/prices/[symbol]]", error);
    return NextResponse.json({ error: "Failed to fetch price data" }, { status: 500 });
  }
}
