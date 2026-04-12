// GET /api/prices/live
// Returns live asset prices from NeonDB.
// Auto-triggers background ingest when data is stale (>15 min):
//   NSE indices  → Dhan API (real OHLCV + volume)
//   Other assets → Yahoo Finance (commodities, FX, fixed income)
// Client polls every 3 min via SWR — data is always ≤15 min old during market hours.

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { prisma } from "@/lib/prisma";

// ─── In-memory ingest guard (per-process) ────────────────────────────────────
// Prevents concurrent ingest calls if multiple requests arrive simultaneously.
let ingestInProgress = false;
let lastIngestTriggeredAt = 0;
const STALE_MS       = 15 * 60 * 1000;  // 15 minutes — trigger auto-ingest
const COOLDOWN_MS    = 2  * 60 * 1000;  // 2-minute cooldown between auto-ingests

function triggerBackgroundIngest() {
  const now = Date.now();
  if (ingestInProgress || now - lastIngestTriggeredAt < COOLDOWN_MS) return;

  ingestInProgress        = true;
  lastIngestTriggeredAt   = now;

  const script = path.join(process.cwd(), "scripts", "fetch_prices.py");
  const child  = spawn("python3", [script, "--live"], {
    detached: true,
    stdio:    "ignore",
    env:      { ...process.env },
  });
  child.unref(); // don't block Node process

  child.on("close", (code) => {
    ingestInProgress = false;
    console.log(`[AutoIngest] Completed with code ${code}`);
  });
  child.on("error", (err) => {
    ingestInProgress = false;
    console.error("[AutoIngest] Error:", err.message);
  });

  console.log(`[AutoIngest] Triggered background ingest (PID ${child.pid})`);
}

export const dynamic = "force-dynamic";

const ASSET_META: Record<string, { name: string; currency: string; assetClass: string; flag: string }> = {
  // ── Broad indices ────────────────────────────────────────────────────────
  NIFTY50:      { name: "Nifty 50",             currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  SENSEX:       { name: "BSE Sensex",            currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  SPX:          { name: "S&P 500",               currency: "USD", assetClass: "Equity Index",  flag: "🇺🇸" },
  // ── NSE Sector indices ───────────────────────────────────────────────────
  NIFTY_BANK:   { name: "Nifty Bank",            currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  NIFTY_IT:     { name: "Nifty IT",              currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  NIFTY_PHARMA: { name: "Nifty Pharma",          currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  NIFTY_FMCG:   { name: "Nifty FMCG",           currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  NIFTY_AUTO:   { name: "Nifty Auto",            currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  NIFTY_INFRA:  { name: "Nifty Infrastructure",  currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  NIFTY_REALTY: { name: "Nifty Realty",          currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  NIFTY_METAL:  { name: "Nifty Metal",           currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  NIFTY_ENERGY: { name: "Nifty Energy",          currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  NIFTY_MEDIA:  { name: "Nifty Media",           currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  SMALLCAP:     { name: "Nifty Smallcap 100",    currency: "INR", assetClass: "Equity Index",  flag: "🇮🇳" },
  // ── Commodities ──────────────────────────────────────────────────────────
  GOLD:         { name: "Gold Futures",           currency: "USD", assetClass: "Commodity",     flag: "🥇" },
  SILVER:       { name: "Silver Futures",         currency: "USD", assetClass: "Commodity",     flag: "⚪" },
  COPPER:       { name: "Copper Futures",         currency: "USD", assetClass: "Commodity",     flag: "🔶" },
  CRUDE_OIL:    { name: "WTI Crude Oil",          currency: "USD", assetClass: "Commodity",     flag: "🛢️" },
  // ── Currencies ───────────────────────────────────────────────────────────
  DXY:          { name: "US Dollar Index",        currency: "USD", assetClass: "Currency",      flag: "💵" },
  USDINR:       { name: "USD / INR",              currency: "INR", assetClass: "Currency",      flag: "💱" },
  // ── Fixed Income ─────────────────────────────────────────────────────────
  US10Y:        { name: "US 10-Year Yield",       currency: "USD", assetClass: "Fixed Income",  flag: "📊" },
  US2Y:         { name: "US 2-Year Yield",        currency: "USD", assetClass: "Fixed Income",  flag: "📈" },
};

export async function GET() {
  try {
    // Fetch all assets with their latest two PriceData rows (for 1D change)
    const assets = await prisma.asset.findMany({
      where: { isActive: true },
      include: {
        priceData: {
          orderBy: { timestamp: "desc" },
          take: 30, // enough for sparkline + 1M change
        },
      },
      orderBy: { ticker: "asc" },
    });

    if (!assets.length) {
      return NextResponse.json({ error: "No assets found. Run ingestion first." }, { status: 404 });
    }

    const result = assets.map((asset) => {
      const meta = ASSET_META[asset.ticker] ?? {
        name: asset.name,
        currency: asset.currency,
        assetClass: asset.assetClass,
        flag: "📌",
      };

      // Sorted descending: rows[0] = newest, rows[1] = prev day
      // Drop ALL weekend-date rows. NSE/BSE/NYSE never trade on Sat/Sun, so any
      // row whose timestamp falls on a weekend is a ghost left by the old
      // fetch_prices.py bug (live snapshot stored at today-midnight even when
      // markets were closed → Sunday row = Friday's price → change1D = 0%).
      const rows = asset.priceData.filter((r) => {
        const dow = r.timestamp.getUTCDay(); // 0=Sun, 6=Sat
        return dow !== 0 && dow !== 6;
      });

      // Also deduplicate by calendar date: keep only the first (newest) row per date.
      // This handles same-day duplicate when both dhan_history + dhan_live
      // rows exist for the same date (both have same close → would show 0% change).
      const seen = new Set<string>();
      const dedupedRows = rows.filter((r) => {
        const d = r.timestamp.toISOString().slice(0, 10);
        if (seen.has(d)) return false;
        seen.add(d);
        return true;
      });

      const latest = dedupedRows[0];
      const prev   = dedupedRows[1];

      const price    = latest?.close ?? 0;
      const change1D = latest && prev
        ? ((latest.close - prev.close) / prev.close) * 100
        : 0;

      // 1-month change: ~20 trading days back
      const monthRow = dedupedRows[19] ?? dedupedRows[dedupedRows.length - 1];
      const change1M = latest && monthRow
        ? ((latest.close - monthRow.close) / monthRow.close) * 100
        : 0;

      // Sparkline: last 30 closes in chronological order
      const sparkline = [...dedupedRows].reverse().map((r) => r.close);

      return {
        symbol:     asset.ticker,
        name:       meta.name,
        assetClass: meta.assetClass,
        currency:   meta.currency,
        flag:       meta.flag,
        price:      Math.round(price * 100) / 100,
        change1D:   Math.round(change1D * 100) / 100,
        change1M:   Math.round(change1M * 100) / 100,
        sparkline,
        lastUpdated: latest?.createdAt?.toISOString() ?? null,
      };
    });

    // ── Freshness check + auto-ingest ──────────────────────────────────────
    const newestTs  = result.reduce((max, a) => {
      const t = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    const ageMs     = newestTs ? Date.now() - newestTs : Infinity;
    const ageHours  = ageMs / 3_600_000;
    const ageMin    = Math.round(ageMs / 60_000);
    const isStale   = ageMs > STALE_MS;   // > 15 min

    // Fire background ingest if stale — response still returns immediately
    if (isStale) triggerBackgroundIngest();

    // Seconds until next auto-refresh (max 15 min from last ingest)
    const nextRefreshIn = isStale
      ? 0
      : Math.round((STALE_MS - ageMs) / 1000);

    return NextResponse.json({
      assets: result,
      meta: {
        count:         result.length,
        lastUpdated:   newestTs ? new Date(newestTs).toISOString() : null,
        ageMin,
        ageHours:      Math.round(ageHours * 10) / 10,
        isStale,
        nextRefreshIn, // seconds
        ingestInProgress,
      },
    });
  } catch (error) {
    console.error("[GET /api/prices/live]", error);
    return NextResponse.json({ error: "Failed to fetch live prices" }, { status: 500 });
  }
}
