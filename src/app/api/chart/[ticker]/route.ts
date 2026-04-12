import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChartCandle {
  time:    string;
  open:    number;
  high:    number;
  low:     number;
  close:   number;
  volume:  number;
  haOpen:  number | null;
  haHigh:  number | null;
  haLow:   number | null;
  haClose: number | null;
  ma50:    number | null;
  ma200:   number | null;
  bbUpper: number | null;
  bbMid:   number | null;
  bbLower: number | null;
  vwap:    number | null;
  aVwap:   number | null;
}

export interface StructureMarker {
  time:      string;
  event:     "BOS_B" | "BOS_S" | "CHoCH_B" | "CHoCH_S";
  price:     number;
  direction: "bull" | "bear";
}

export interface OrderBlock {
  high:   number;
  low:    number;
  mid:    number;
  type:   "demand" | "supply";
  active: boolean;
}

export interface ChartData {
  ticker:           string;
  name:             string;
  candles:          ChartCandle[];
  structureMarkers: StructureMarker[];
  orderBlocks:      OrderBlock[];
  volumeProfile:    { poc: number; vah: number; val: number };
  optionLevels:     { maxPain: number | null; resistance: number | null; support: number | null; atmIv: number | null };
  swingLevels:      { highs: number[]; lows: number[] };
}

// ─── Computation helpers ──────────────────────────────────────────────────────

function sma(arr: number[], n: number): (number | null)[] {
  return arr.map((_, i) => {
    if (i < n - 1) return null;
    return arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
  });
}

function computeHACandles(bars: { open: number; high: number; low: number; close: number }[]) {
  const ha: { open: number; high: number; low: number; close: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen  = i === 0
      ? (b.open + b.close) / 2
      : (ha[i - 1].open + ha[i - 1].close) / 2;
    const haHigh  = Math.max(b.high, haOpen, haClose);
    const haLow   = Math.min(b.low,  haOpen, haClose);
    ha.push({ open: haOpen, high: haHigh, low: haLow, close: haClose });
  }
  return ha;
}

function computeRollingBB(closes: number[], period = 20, mult = 2) {
  return closes.map((_, i) => {
    if (i < period - 1) return { upper: null, mid: null, lower: null };
    const sl   = closes.slice(i - period + 1, i + 1);
    const mean = sl.reduce((a, b) => a + b, 0) / period;
    const std  = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    return { upper: mean + mult * std, mid: mean, lower: mean - mult * std };
  });
}

function computeRollingVWAP(bars: { high: number; low: number; close: number; volume: number }[], period = 20) {
  return bars.map((_, i) => {
    const sl     = bars.slice(Math.max(0, i - period + 1), i + 1);
    const cumTPV = sl.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * Math.max(b.volume, 1), 0);
    const cumVol = sl.reduce((s, b) => s + Math.max(b.volume, 1), 0);
    return cumTPV / cumVol;
  });
}

function computeAnchoredVWAP(bars: { time: string; high: number; low: number; close: number; volume: number }[]) {
  const year   = new Date().getFullYear();
  const ytdIdx = bars.findIndex((b) => b.time >= `${year}-01-01`);
  if (ytdIdx < 0) return bars.map(() => null as number | null);

  const result: (number | null)[] = bars.map(() => null);
  let cumTPV = 0;
  let cumVol = 0;
  for (let i = ytdIdx; i < bars.length; i++) {
    const b = bars[i];
    cumTPV += ((b.high + b.low + b.close) / 3) * Math.max(b.volume, 1);
    cumVol += Math.max(b.volume, 1);
    result[i] = cumTPV / cumVol;
  }
  return result;
}

function detectStructureMarkers(
  bars: { time: string; high: number; low: number; close: number }[],
): StructureMarker[] {
  if (bars.length < 20) return [];
  const markers: StructureMarker[] = [];
  const lookback = Math.min(bars.length, 120);
  const slice    = bars.slice(-lookback);

  // Find swing highs/lows (5-bar pivot)
  const swingHighs: { idx: number; price: number }[] = [];
  const swingLows:  { idx: number; price: number }[] = [];

  for (let i = 2; i < slice.length - 2; i++) {
    const isHigh = slice[i].high > slice[i-1].high && slice[i].high > slice[i-2].high &&
                   slice[i].high > slice[i+1].high && slice[i].high > slice[i+2].high;
    const isLow  = slice[i].low  < slice[i-1].low  && slice[i].low  < slice[i-2].low  &&
                   slice[i].low  < slice[i+1].low   && slice[i].low  < slice[i+2].low;
    if (isHigh) swingHighs.push({ idx: i, price: slice[i].high });
    if (isLow)  swingLows.push({ idx: i, price: slice[i].low });
  }

  // BOS Bullish: close breaks above last swing high
  for (let k = swingHighs.length - 1; k >= Math.max(0, swingHighs.length - 3); k--) {
    const sh = swingHighs[k];
    for (let i = sh.idx + 1; i < Math.min(sh.idx + 15, slice.length); i++) {
      if (slice[i].close > sh.price) {
        markers.push({
          time:      slice[i].time,
          event:     "BOS_B",
          price:     sh.price,
          direction: "bull",
        });
        break;
      }
    }
  }

  // BOS Bearish: close breaks below last swing low
  for (let k = swingLows.length - 1; k >= Math.max(0, swingLows.length - 3); k--) {
    const sl = swingLows[k];
    for (let i = sl.idx + 1; i < Math.min(sl.idx + 15, slice.length); i++) {
      if (slice[i].close < sl.price) {
        markers.push({
          time:      slice[i].time,
          event:     "BOS_S",
          price:     sl.price,
          direction: "bear",
        });
        break;
      }
    }
  }

  // CHoCH: break in opposite direction of last BOS (simple — last BOS bull → next bear break = CHoCH)
  // Detect via latest structure shift
  const recentHigh = swingHighs.at(-1);
  const recentLow  = swingLows.at(-1);
  if (recentHigh && recentLow) {
    const lastBar = slice.at(-1)!;
    if (slice.length >= 2) {
      const prev = slice.at(-2)!;
      // If last swing was a high but current bar breaks below a recent swing low → CHoCH Bear
      if (recentHigh.idx > recentLow.idx && lastBar.close < recentLow.price && prev.close >= recentLow.price) {
        markers.push({ time: lastBar.time, event: "CHoCH_S", price: recentLow.price, direction: "bear" });
      }
      // If last swing was a low but current bar breaks above recent swing high → CHoCH Bull
      if (recentLow.idx > recentHigh.idx && lastBar.close > recentHigh.price && prev.close <= recentHigh.price) {
        markers.push({ time: lastBar.time, event: "CHoCH_B", price: recentHigh.price, direction: "bull" });
      }
    }
  }

  // Deduplicate by time+event
  const seen = new Set<string>();
  return markers.filter((m) => {
    const key = `${m.time}-${m.event}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.time.localeCompare(b.time));
}

function computeOrderBlocks(bars: { high: number; low: number; close: number; open: number }[]): OrderBlock[] {
  if (bars.length < 20) return [];
  const slice = bars.slice(-50);
  const close = slice.at(-1)!.close;
  const IMPULSE = 0.006;
  const blocks: OrderBlock[] = [];

  for (let i = 1; i < slice.length - 2; i++) {
    const body = Math.abs(slice[i].close - slice[i].open);
    const rng  = slice[i].high - slice[i].low;
    if (rng === 0 || body / rng < 0.4) continue;

    // Demand block: strong bullish candle, look back 1-2 bars for bearish consolidation
    if (slice[i].close > slice[i].open) {
      const impulsePct = (slice[i].close - slice[i - 1].close) / slice[i - 1].close;
      if (impulsePct > IMPULSE) {
        const obHigh = Math.max(slice[i-1].open, slice[i-1].close);
        const obLow  = Math.min(slice[i-1].open, slice[i-1].close);
        const active = close >= obLow * 0.99 && close <= obHigh * 1.05;
        blocks.push({ high: obHigh, low: obLow, mid: (obHigh + obLow) / 2, type: "demand", active });
      }
    }

    // Supply block: strong bearish candle, look back 1-2 bars for bullish consolidation
    if (slice[i].close < slice[i].open) {
      const impulsePct = (slice[i - 1].close - slice[i].close) / slice[i - 1].close;
      if (impulsePct > IMPULSE) {
        const obHigh = Math.max(slice[i-1].open, slice[i-1].close);
        const obLow  = Math.min(slice[i-1].open, slice[i-1].close);
        const active = close >= obLow * 0.97 && close <= obHigh * 1.01;
        blocks.push({ high: obHigh, low: obLow, mid: (obHigh + obLow) / 2, type: "supply", active });
      }
    }
  }

  // Return at most the 2 most recent of each type
  const demand = blocks.filter((b) => b.type === "demand").slice(-2);
  const supply = blocks.filter((b) => b.type === "supply").slice(-2);
  return [...demand, ...supply];
}

function computeVolumeProfile(bars: { high: number; low: number; close: number; volume: number }[], lookback = 60) {
  const slice    = bars.slice(-lookback);
  const high     = Math.max(...slice.map((b) => b.high));
  const low      = Math.min(...slice.map((b) => b.low));
  const numBuckets = 30;
  const step     = (high - low) / numBuckets;
  if (step === 0) return { poc: slice.at(-1)!.close, vah: high, val: low };

  const buckets  = Array(numBuckets).fill(0);
  for (const b of slice) {
    const vol = Math.max(b.volume, 1);
    const lo  = Math.max(0, Math.floor((b.low - low) / step));
    const hi  = Math.min(numBuckets - 1, Math.ceil((b.high - low) / step));
    for (let j = lo; j <= hi; j++) buckets[j] += vol / Math.max(1, hi - lo + 1);
  }

  const pocIdx   = buckets.indexOf(Math.max(...buckets));
  const poc      = low + pocIdx * step + step / 2;
  const total    = buckets.reduce((a, b) => a + b, 0);
  let   va       = 0;
  let   vahIdx   = pocIdx;
  let   valIdx   = pocIdx;

  while (va < total * 0.7 && (vahIdx < numBuckets - 1 || valIdx > 0)) {
    const up   = vahIdx < numBuckets - 1 ? buckets[vahIdx + 1] : 0;
    const down = valIdx > 0 ? buckets[valIdx - 1] : 0;
    if (up >= down && vahIdx < numBuckets - 1) { vahIdx++; va += buckets[vahIdx]; }
    else if (valIdx > 0)                        { valIdx--; va += buckets[valIdx]; }
    else break;
  }

  return {
    poc: parseFloat(poc.toFixed(2)),
    vah: parseFloat((low + vahIdx * step + step).toFixed(2)),
    val: parseFloat((low + valIdx * step).toFixed(2)),
  };
}

// ─── GET handler ─────────────────────────────────────────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;

  const asset = await prisma.asset.findUnique({
    where:   { ticker },
    include: {
      priceData: { orderBy: { timestamp: "asc" }, take: 280 },
      indicators: {
        where:   { name: { in: ["OPT_MAX_PAIN", "OPT_RESISTANCE", "OPT_SUPPORT", "OPT_ATM_IV"] } },
        orderBy: { timestamp: "desc" },
        take:    4,
      },
    },
  });

  if (!asset || asset.priceData.length < 5) {
    return NextResponse.json({ error: "No data" }, { status: 404 });
  }

  const raw = asset.priceData.map((p) => ({
    time:   p.timestamp.toISOString().split("T")[0],
    open:   p.open  ?? p.close,
    high:   p.high  ?? p.close,
    low:    p.low   ?? p.close,
    close:  p.close,
    volume: p.volume ?? 0,
  }));

  const closes = raw.map((b) => b.close);
  const ma50s  = sma(closes, 50);
  const ma200s = sma(closes, 200);
  const bbArr  = computeRollingBB(closes, 20, 2);
  const haArr  = computeHACandles(raw);
  const vwapArr  = computeRollingVWAP(raw, 20);
  const aVwapArr = computeAnchoredVWAP(raw);

  const candles: ChartCandle[] = raw.map((b, i) => ({
    ...b,
    haOpen:  parseFloat(haArr[i].open.toFixed(2)),
    haHigh:  parseFloat(haArr[i].high.toFixed(2)),
    haLow:   parseFloat(haArr[i].low.toFixed(2)),
    haClose: parseFloat(haArr[i].close.toFixed(2)),
    ma50:    ma50s[i - (closes.length - ma50s.length)] ?? null,
    ma200:   ma200s[i - (closes.length - ma200s.length)] ?? null,
    bbUpper: bbArr[i].upper !== null ? parseFloat(bbArr[i].upper!.toFixed(2)) : null,
    bbMid:   bbArr[i].mid   !== null ? parseFloat(bbArr[i].mid!.toFixed(2))   : null,
    bbLower: bbArr[i].lower !== null ? parseFloat(bbArr[i].lower!.toFixed(2)) : null,
    vwap:    parseFloat(vwapArr[i].toFixed(2)),
    aVwap:   aVwapArr[i] !== null ? parseFloat(aVwapArr[i]!.toFixed(2)) : null,
  }));

  const structureMarkers = detectStructureMarkers(raw);
  const orderBlocks      = computeOrderBlocks(raw);
  const volumeProfile    = computeVolumeProfile(raw, 60);

  const indMap: Record<string, number> = {};
  for (const ind of asset.indicators) indMap[ind.name] = ind.value;

  // Swing levels for reference lines
  const recentBars = raw.slice(-30);
  const swingHighs = recentBars.map((b) => b.high).sort((a, b) => b - a).slice(0, 3);
  const swingLows  = recentBars.map((b) => b.low).sort((a, b) => a - b).slice(0, 3);

  const response: ChartData = {
    ticker,
    name: asset.name,
    candles,
    structureMarkers,
    orderBlocks,
    volumeProfile,
    optionLevels: {
      maxPain:    indMap["OPT_MAX_PAIN"]    ?? null,
      resistance: indMap["OPT_RESISTANCE"]  ?? null,
      support:    indMap["OPT_SUPPORT"]     ?? null,
      atmIv:      indMap["OPT_ATM_IV"]      ?? null,
    },
    swingLevels: { highs: swingHighs, lows: swingLows },
  };

  return NextResponse.json(response);
}
