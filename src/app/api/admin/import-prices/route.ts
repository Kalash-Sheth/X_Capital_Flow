// POST /api/admin/import-prices
// Bulk-import historical OHLCV price data from CSV into the database.
//
// Auth:    x-admin-secret header must match ADMIN_SECRET env var
// Body:    JSON { ticker: string, csv: string }
// Tickers: NIFTY50 | NIFTY500 | NIFTY_SMALLCAP (or any asset ticker)
//
// Supported CSV formats (auto-detected):
//   NSE Index:  Date,Open,High,Low,Close
//   NSE Full:   Date,Open,High,Low,Close,Shares Traded,Turnover
//   Minimal:    Date,Close
//   ISO dates:  YYYY-MM-DD
//   NSE dates:  DD-Mon-YYYY  (e.g. 01-Jan-2000)
//   Slash dates: DD/MM/YYYY
//
// Returns: { added, updated, skipped, errors[] }

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ─── Ticker → Asset metadata ──────────────────────────────────────────────────

const TICKER_META: Record<string, { name: string; assetClass: "EQUITY"; currency: string }> = {
  NIFTY50:        { name: "Nifty 50",            assetClass: "EQUITY", currency: "INR" },
  NIFTY100:       { name: "Nifty 100",           assetClass: "EQUITY", currency: "INR" },
  NIFTY500:       { name: "Nifty 500",           assetClass: "EQUITY", currency: "INR" },
  NIFTY_SMALLCAP: { name: "Nifty SmallCap 100",  assetClass: "EQUITY", currency: "INR" },
  INDIAVIX:       { name: "India VIX",            assetClass: "EQUITY", currency: "INR" },
};

// ─── Date parsing ─────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3,  may: 4,  jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseDate(raw: string): Date | null {
  const s = raw.trim().replace(/"/g, "");
  if (!s) return null;

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T00:00:00.000Z");
    return isNaN(d.getTime()) ? null : d;
  }

  // DD-Mon-YYYY  e.g. 01-Jan-2000
  const nseMatch = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (nseMatch) {
    const [, dd, mon, yyyy] = nseMatch;
    const m = MONTH_MAP[mon.toLowerCase()];
    if (m === undefined) return null;
    const d = new Date(Date.UTC(parseInt(yyyy), m, parseInt(dd)));
    return isNaN(d.getTime()) ? null : d;
  }

  // DD-MM-YYYY  e.g. 21-02-2024  (Investing.com / your format)
  const ddmmyyyy = s.match(/^(\d{1,2})-(\d{2})-(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    const d = new Date(Date.UTC(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd)));
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, dd, mm, yyyy] = slashMatch;
    const d = new Date(Date.UTC(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd)));
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

// ─── CSV / TSV parser ─────────────────────────────────────────────────────────

// RFC 4180-compliant line parser — handles quoted fields with internal commas/quotes
function parseCsvLine(line: string, sep: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Handle escaped quote ("")
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === sep && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  // Strip UTF-8 BOM if present
  const cleaned = csv.replace(/^\uFEFF/, "").replace(/^ï»¿/, "");
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim());
  // Auto-detect separator: tab-separated if first line contains a tab
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const headers = parseCsvLine(lines[0], sep).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((l) => parseCsvLine(l, sep));
  return { headers, rows };
}

// Parse volume values like "1.23M", "456K", "1,234,567"
function parseVolume(raw: string): number | null {
  if (!raw || raw === "-" || raw === "") return null;
  const s = raw.replace(/,/g, "").trim();
  const m = s.match(/^([\d.]+)([KkMmBb]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] ?? 1;
  return n * mult;
}

function resolveCol(headers: string[], ...candidates: string[]): number {
  for (const c of candidates) {
    const i = headers.findIndex((h) => h.replace(/[^a-z0-9]/g, "").includes(c.toLowerCase().replace(/[^a-z0-9]/g, "")));
    if (i !== -1) return i;
  }
  return -1;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Auth check
  const secret = req.headers.get("x-admin-secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { ticker?: string; csv?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { ticker, csv } = body;
  if (!ticker || !csv) {
    return NextResponse.json({ error: "ticker and csv are required" }, { status: 400 });
  }

  const upperTicker = ticker.toUpperCase();

  // Parse CSV
  const { headers, rows } = parseCsv(csv);

  // Detect columns — "price" = close (Investing.com format), "vol." also matched
  const dateCol   = resolveCol(headers, "date");
  const closeCol  = resolveCol(headers, "price", "close");
  const openCol   = resolveCol(headers, "open");
  const highCol   = resolveCol(headers, "high");
  const lowCol    = resolveCol(headers, "low");
  const volumeCol = resolveCol(headers, "vol", "shares traded", "volume", "qty");

  if (dateCol === -1)  return NextResponse.json({ error: `No 'date' column found. Headers: ${headers.join(", ")}` }, { status: 400 });
  if (closeCol === -1) return NextResponse.json({ error: `No 'price'/'close' column found. Headers: ${headers.join(", ")}` }, { status: 400 });

  // Upsert the Asset row
  const meta = TICKER_META[upperTicker] ?? { name: upperTicker, assetClass: "EQUITY" as const, currency: "INR" };
  const asset = await prisma.asset.upsert({
    where:  { ticker: upperTicker },
    create: { ticker: upperTicker, name: meta.name, assetClass: meta.assetClass, currency: meta.currency },
    update: {},
  });

  // Process rows
  let added = 0, updated = 0, skipped = 0;
  const errors: string[] = [];

  const BATCH = 50;  // 50 ops per transaction = 1 connection, safe for pooler
  const validRows: Array<{
    assetId:   string;
    timestamp: Date;
    open:      number;
    high:      number;
    low:       number;
    close:     number;
    volume:    number | null;
    source:    string;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 2) continue;

    const rawDate  = row[dateCol]  ?? "";
    const rawClose = row[closeCol] ?? "";

    const timestamp = parseDate(rawDate);
    if (!timestamp) { errors.push(`Row ${i + 2}: cannot parse date "${rawDate}"`); skipped++; continue; }

    const close = parseFloat(rawClose.replace(/,/g, ""));
    if (isNaN(close) || close <= 0) { errors.push(`Row ${i + 2}: invalid close "${rawClose}"`); skipped++; continue; }

    const open   = openCol   !== -1 ? parseFloat((row[openCol]  ?? "").replace(/,/g, "")) : close;
    const high   = highCol   !== -1 ? parseFloat((row[highCol]  ?? "").replace(/,/g, "")) : close;
    const low    = lowCol    !== -1 ? parseFloat((row[lowCol]   ?? "").replace(/,/g, "")) : close;
    const volume = volumeCol !== -1 ? parseVolume(row[volumeCol] ?? "") : null;

    validRows.push({
      assetId: asset.id,
      timestamp,
      open:   isNaN(open)   ? close : open,
      high:   isNaN(high)   ? close : high,
      low:    isNaN(low)    ? close : low,
      close,
      volume: volume !== null && !isNaN(volume) ? volume : null,
      source: "csv-import",
    });
  }

  // Batch upsert — one $transaction per batch = one connection, avoids pooler limit
  for (let i = 0; i < validRows.length; i += BATCH) {
    const batch = validRows.slice(i, i + BATCH);
    try {
      await prisma.$transaction(
        batch.map((r) =>
          prisma.priceData.upsert({
            where:  { assetId_timestamp: { assetId: r.assetId, timestamp: r.timestamp } },
            create: r,
            update: { open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, source: r.source },
          })
        )
      );
      added += batch.length;
    } catch (err: unknown) {
      // If transaction fails, fall back to one-by-one so partial success is preserved
      for (const r of batch) {
        try {
          await prisma.priceData.upsert({
            where:  { assetId_timestamp: { assetId: r.assetId, timestamp: r.timestamp } },
            create: r,
            update: { open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, source: r.source },
          });
          added++;
        } catch (e: unknown) {
          errors.push(e instanceof Error ? e.message.split("\n")[0] : "DB error");
          skipped++;
        }
      }
    }
  }

  return NextResponse.json({
    ticker: upperTicker,
    assetId: asset.id,
    totalRows: rows.length,
    added,
    updated,
    skipped,
    errors: errors.slice(0, 20), // cap error list
  });
}
