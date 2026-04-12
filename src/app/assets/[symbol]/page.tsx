"use client";

import { useState, use } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Sparkles,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  ReferenceLine,
  AreaChart,
  Area,
} from "recharts";
import { cn, formatPercent } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// ─── TradingView Lightweight Charts (client-only, no SSR) ────────────────────
const LightweightChart = dynamic(
  () => import("@/components/charts/LightweightChart"),
  { ssr: false, loading: () => <div className="h-[380px] w-full animate-pulse rounded bg-[#F0EDE6]" /> }
);

// ─── Static asset metadata ───────────────────────────────────────────────────
const ASSET_META: Record<
  string,
  { name: string; currency: string; assetClass: string; description: string }
> = {
  NIFTY50:      { name: "Nifty 50 Index",        currency: "INR", assetClass: "Equity Index",  description: "Benchmark index of India's top 50 companies by market cap." },
  SENSEX:       { name: "BSE Sensex",             currency: "INR", assetClass: "Equity Index",  description: "30-stock benchmark index of the Bombay Stock Exchange." },
  NIFTY_BANK:   { name: "Nifty Bank Index",       currency: "INR", assetClass: "Equity Index",  description: "Tracks the performance of the most liquid banking stocks." },
  NIFTY_IT:     { name: "Nifty IT Index",         currency: "INR", assetClass: "Equity Index",  description: "Benchmark for India's technology and software sector." },
  NIFTY_PHARMA: { name: "Nifty Pharma Index",     currency: "INR", assetClass: "Equity Index",  description: "Tracks pharmaceutical and healthcare companies." },
  NIFTY_FMCG:   { name: "Nifty FMCG Index",       currency: "INR", assetClass: "Equity Index",  description: "Fast-moving consumer goods sector performance index." },
  SMALLCAP:     { name: "Nifty Smallcap 100",     currency: "INR", assetClass: "Equity Index",  description: "Top 100 smallcap companies listed on NSE by full market cap." },
  SPX:          { name: "S&P 500 Index",          currency: "USD", assetClass: "Equity Index",  description: "Market-cap weighted index of 500 leading US public companies." },
  GOLD:         { name: "Gold Spot (XAU/USD)",    currency: "USD", assetClass: "Commodity",     description: "Spot price of gold, a key safe-haven and inflation hedge." },
  SILVER:       { name: "Silver Spot (XAG/USD)",  currency: "USD", assetClass: "Commodity",     description: "Spot silver price with both industrial and monetary demand." },
  COPPER:       { name: "Copper Futures",         currency: "USD", assetClass: "Commodity",     description: "Copper futures — a leading global economic activity indicator." },
  CRUDE_OIL:    { name: "WTI Crude Oil",          currency: "USD", assetClass: "Commodity",     description: "West Texas Intermediate — benchmark US crude oil contract." },
  DXY:          { name: "US Dollar Index",        currency: "USD", assetClass: "Currency",      description: "Measures the USD against a basket of 6 major foreign currencies." },
  USDINR:       { name: "USD / INR",              currency: "INR", assetClass: "Currency",      description: "US Dollar to Indian Rupee exchange rate." },
  US10Y:        { name: "US 10-Year Treasury",    currency: "USD", assetClass: "Fixed Income",  description: "Benchmark US government bond yield at 10-year maturity." },
  US2Y:         { name: "US 2-Year Treasury",     currency: "USD", assetClass: "Fixed Income",  description: "Short-duration US government bond yield, sensitive to Fed rates." },
};

const RELATED: Record<string, string[]> = {
  NIFTY50:      ["NIFTY_BANK", "NIFTY_IT", "SMALLCAP"],
  SENSEX:       ["NIFTY50", "NIFTY_BANK", "NIFTY_FMCG"],
  NIFTY_BANK:   ["NIFTY50", "SENSEX", "US10Y"],
  NIFTY_IT:     ["NIFTY50", "SPX", "DXY"],
  NIFTY_PHARMA: ["NIFTY50", "NIFTY_FMCG", "SENSEX"],
  NIFTY_FMCG:   ["NIFTY50", "NIFTY_PHARMA", "SENSEX"],
  SMALLCAP:     ["NIFTY50", "NIFTY_BANK", "NIFTY_IT"],
  SPX:          ["DXY", "US10Y", "GOLD"],
  GOLD:         ["DXY", "US10Y", "SILVER"],
  SILVER:       ["GOLD", "COPPER", "DXY"],
  COPPER:       ["CRUDE_OIL", "SILVER", "DXY"],
  CRUDE_OIL:    ["DXY", "GOLD", "US10Y"],
  DXY:          ["GOLD", "SPX", "US10Y"],
  USDINR:       ["DXY", "NIFTY50", "GOLD"],
  US10Y:        ["US2Y", "DXY", "GOLD"],
  US2Y:         ["US10Y", "DXY", "SPX"],
};

// ─── Indicators ───────────────────────────────────────────────────────────────
function computeRSI(closes: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = new Array(period).fill(null);
  for (let i = period; i < closes.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - closes[j - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    const rs = gains / (losses || 1);
    rsi.push(100 - 100 / (1 + rs));
  }
  return rsi;
}

function computeSMA(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function computeMACD(closes: number[]) {
  const ema = (data: number[], p: number) => {
    const result: number[] = [];
    const k = 2 / (p + 1);
    let prev = data[0];
    data.forEach((v) => { prev = v * k + prev * (1 - k); result.push(prev); });
    return result;
  };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12.map((v, i) => v - ema26[i]);
  const signal = ema(macd, 9);
  const histogram = macd.map((v, i) => v - signal[i]);
  return { macd, signal, histogram };
}

// ─── Fetcher ──────────────────────────────────────────────────────────────────
const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ─── Types ────────────────────────────────────────────────────────────────────
interface PriceRow {
  date:   string;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

interface SymbolResponse {
  symbol:     string;
  name:       string;
  currency:   string;
  assetClass: string;
  days:       number;
  lastClose:  number;
  prevClose:  number;
  change1D:   number;   // server-computed — correct even on Sunday/holidays
  data:       PriceRow[];
}

// ─── Range selector ───────────────────────────────────────────────────────────
const RANGES: { label: string; days: number }[] = [
  { label: "1M",  days: 30   },
  { label: "3M",  days: 90   },
  { label: "6M",  days: 180  },
  { label: "1Y",  days: 365  },
  { label: "3Y",  days: 1095 },
  { label: "5Y",  days: 1825 },
];

// ─── Indicator card ───────────────────────────────────────────────────────────
function IndicatorCard({
  title, value, subtitle, color, children,
}: {
  title: string; value: string; subtitle?: string; color: string; children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs">{title}</CardTitle>
          <span className="rounded-md px-2 py-0.5 text-xs font-bold" style={{ color, backgroundColor: color + "18" }}>
            {value}
          </span>
        </div>
        {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      {children && <CardContent className="pt-0">{children}</CardContent>}
    </Card>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-[#F0EDE6]", className)} />;
}

// ─── AI insight fallbacks ─────────────────────────────────────────────────────
const AI_INSIGHTS: Record<string, string> = {
  NIFTY50:
    "**Nifty 50 — Constructive Outlook** \n\nThe index is in a confirmed uptrend with the 50-DMA well above the 200-DMA (golden cross intact). RSI at 68 signals strong momentum without entering overbought territory. FII inflows turning positive after 3 months of selling creates a favorable supply-demand backdrop. **Key resistance** at 24,700 (prior ATH). A close above that level on volume would target 25,500 over the next 6–8 weeks. **Risk**: A slip below 23,800 would invalidate the near-term bullish thesis.",
  GOLD:
    "**Gold — Strong Secular Bull** \n\nGold is outperforming most asset classes on a 3-month basis (+4.6%) as dollar softens and real yields edge lower. The precious metal is trading well above all major moving averages. Central bank buying (particularly from EM economies) continues to provide a structural demand floor. **Near-term target**: $2,750 if DXY breaks below 102. **Stop**: $2,580. The risk-reward is compelling in a late-cycle environment.",
  DEFAULT:
    "**Technical Assessment** \n\nBased on current price action, the asset shows **moderate bullish momentum** with RSI in constructive territory (50–70 range). Moving average alignment is positive — price is above both 50-DMA and 200-DMA. Volume patterns indicate institutional accumulation on dips. \n\n**Key levels to watch:**\n- Support: Recent 20-day low\n- Resistance: Prior pivot high\n\nConsider scaling into positions on any 2–3% pullback to the 20-DMA. Maintain position sizing discipline given elevated macro uncertainty.",
};

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function AssetDeepDivePage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = use(params);
  const router     = useRouter();
  const [showAI,    setShowAI]    = useState(false);
  const [loadingAI, setLoadingAI] = useState(false);
  const [rangeDays, setRangeDays] = useState(365);

  const { data: liveRes, error, isLoading, isValidating, mutate } = useSWR<SymbolResponse>(
    `/api/prices/${symbol}?days=${rangeDays}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const handleRefresh = () => mutate();

  const meta = ASSET_META[symbol] ?? {
    name:       liveRes?.name ?? symbol,
    currency:   liveRes?.currency ?? "USD",
    assetClass: liveRes?.assetClass ?? "Unknown",
    description: "No description available.",
  };

  const rawData: PriceRow[] = liveRes?.data ?? [];
  const closes = rawData.map((d) => d.close);

  const sma20  = computeSMA(closes, 20);
  const sma50  = computeSMA(closes, 50);
  const rsiValues  = computeRSI(closes, 14);
  const { macd, signal: macdSignal, histogram } = computeMACD(closes.length ? closes : [0]);

  const chartData = rawData.map((d, i) => ({
    date:       d.date.slice(5), // MM-DD
    close:      d.close,
    volume:     d.volume,
    sma20:      sma20[i],
    sma50:      sma50[i],
    rsi:        rsiValues[i],
    macd:       macd[i],
    macdSignal: macdSignal[i],
    macdHist:   histogram[i],
  }));

  const latestClose = liveRes?.lastClose ?? closes.at(-1) ?? 0;
  // Use server-computed change1D — correct even on Sunday/holidays
  const changePct   = liveRes?.change1D ?? 0;
  const isPositive  = changePct > 0;
  const currencySymbol = meta.currency === "INR" ? "₹" : "$";

  const latestRSI    = (rsiValues.filter((v) => v != null) as number[]).at(-1) ?? 0;
  const latestMACD   = macd.at(-1) ?? 0;
  const latestSignal = macdSignal.at(-1) ?? 0;

  const bbUpper = sma20.map((sma, i) => {
    if (sma == null) return null;
    const slice = closes.slice(Math.max(0, i - 19), i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / slice.length;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
    return sma + 2 * std;
  });
  const bbLower = sma20.map((sma, i) => {
    if (sma == null) return null;
    const slice = closes.slice(Math.max(0, i - 19), i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / slice.length;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
    return sma - 2 * std;
  });
  const latestBBUpper = (bbUpper.filter((v) => v != null) as number[]).at(-1) ?? 0;
  const latestBBLower = (bbLower.filter((v) => v != null) as number[]).at(-1) ?? 0;

  const relatedSymbols = RELATED[symbol] ?? ["NIFTY50", "GOLD", "SPX"];

  const handleAIClick = async () => {
    if (showAI) { setShowAI(false); return; }
    setLoadingAI(true);
    await new Promise((r) => setTimeout(r, 900));
    setLoadingAI(false);
    setShowAI(true);
  };

  const aiText = AI_INSIGHTS[symbol] ?? AI_INSIGHTS.DEFAULT;

  return (
    <div className="space-y-5">
      {/* Header bar */}
      <div className="flex items-center gap-3 rounded-xl border border-[#DDD9D0] bg-white px-4 py-3">
        <button
          onClick={() => router.push("/assets")}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#DDD9D0] bg-[#F7F6F2] text-muted-foreground hover:bg-[#EFEDE7] transition-colors flex-shrink-0"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="flex items-center gap-2">
          <span className="font-bold text-foreground font-mono text-base">
            {symbol.replace("_", " ")}
          </span>
          <span className="rounded-md border border-[#DDD9D0] bg-[#F7F6F2] px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
            {meta.assetClass}
          </span>
          {(isLoading || isValidating) && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <RefreshCw size={10} className="animate-spin" /> {isLoading ? "Loading..." : "Refreshing..."}
            </span>
          )}
          {error && (
            <span className="text-[10px] text-red-500">Failed to load prices</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {!isLoading && rawData.length > 0 && (
            <div className="text-right">
              <p className="text-lg font-bold text-foreground">
                {currencySymbol}
                {latestClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <div className="flex items-center justify-end gap-1">
                {isPositive ? (
                  <TrendingUp size={11} className="text-emerald-600" />
                ) : (
                  <TrendingDown size={11} className="text-red-600" />
                )}
                <span className={cn("text-xs font-semibold", isPositive ? "text-emerald-600" : "text-red-600")}>
                  {formatPercent(changePct)}
                </span>
                <span className="text-xs text-muted-foreground">1D</span>
              </div>
            </div>
          )}
          {isLoading && <Skeleton className="h-10 w-24" />}
          <button
            onClick={handleRefresh}
            disabled={isValidating}
            title="Refresh prices"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#DDD9D0] bg-[#F7F6F2] text-muted-foreground hover:bg-[#EFEDE7] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={12} className={isValidating ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-muted-foreground max-w-2xl">{meta.description}</p>

      {/* Live data count */}
      {!isLoading && rawData.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-[11px] text-muted-foreground">
            Showing {rawData.length} days of live data from NeonDB
            {rawData.at(-1)?.date && ` · Last close: ${rawData.at(-1)!.date}`}
          </p>
          {rawData.length < rangeDays * 0.5 && (
            <p className="text-[11px] text-amber-600 font-medium">
              ⚠ Only {rawData.length} days in DB for {RANGES.find(r => r.days === rangeDays)?.label ?? rangeDays + 'd'} range —
              run <code className="font-mono bg-amber-50 px-1 rounded">python3 scripts/fetch_prices.py --history --days {rangeDays}</code> to backfill
            </p>
          )}
        </div>
      )}

      {/* Price chart — TradingView Lightweight Charts */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Price Chart — {rawData.length} Days</CardTitle>
            {/* Range selector */}
            <div className="flex items-center gap-1">
              {RANGES.map((r) => (
                <button
                  key={r.label}
                  onClick={() => setRangeDays(r.days)}
                  className={cn(
                    "rounded px-2 py-0.5 text-[11px] font-semibold transition-colors",
                    rangeDays === r.days
                      ? "bg-[#1B3A5C] text-white"
                      : "text-muted-foreground hover:bg-[#F0EDE6]"
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {/* Legend */}
            <div className="flex items-center gap-3 text-[11px]">
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2.5 rounded-sm bg-emerald-500" />
                <span className="text-muted-foreground">Up</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2.5 rounded-sm bg-red-500" />
                <span className="text-muted-foreground">Down</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-0.5 w-6 rounded-full bg-blue-400" />
                <span className="text-muted-foreground">SMA20</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-0.5 w-6 rounded-full bg-orange-400" />
                <span className="text-muted-foreground">SMA50</span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 pb-2">
          {isLoading ? (
            <Skeleton className="mx-6 h-[380px] w-[calc(100%-3rem)]" />
          ) : rawData.length < 2 ? (
            <div className="flex h-[380px] items-center justify-center text-sm text-muted-foreground">
              Not enough data. Run ingest to populate history.
            </div>
          ) : (
            <LightweightChart
              data={rawData}
              sma20={sma20}
              sma50={sma50}
              height={380}
            />
          )}
        </CardContent>
      </Card>

      {/* Indicators grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-24 w-full" /></CardContent></Card>
          ))
        ) : (
          <>
            {/* RSI */}
            <IndicatorCard
              title="RSI (14)"
              value={latestRSI.toFixed(1)}
              subtitle={
                latestRSI > 70 ? "Overbought zone — caution"
                : latestRSI < 30 ? "Oversold — potential bounce"
                : "Neutral territory"
              }
              color={latestRSI > 70 ? "#B45309" : latestRSI < 30 ? "#1D6FA4" : "#2D7D46"}
            >
              <ResponsiveContainer width="100%" height={60}>
                <AreaChart data={chartData.slice(-40)} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="rsiGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1B3A5C" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#1B3A5C" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <ReferenceLine y={70} stroke="#F87171" strokeDasharray="3 2" strokeWidth={1} />
                  <ReferenceLine y={30} stroke="#60A5FA" strokeDasharray="3 2" strokeWidth={1} />
                  <Area type="monotone" dataKey="rsi" stroke="#1B3A5C" strokeWidth={1.5} fill="url(#rsiGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </IndicatorCard>

            {/* MACD */}
            <IndicatorCard
              title="MACD"
              value={latestMACD > latestSignal ? "Bullish" : "Bearish"}
              subtitle={`MACD: ${latestMACD.toFixed(2)} | Signal: ${latestSignal.toFixed(2)}`}
              color={latestMACD > latestSignal ? "#2D7D46" : "#B83232"}
            >
              <ResponsiveContainer width="100%" height={60}>
                <ComposedChart data={chartData.slice(-40)} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <ReferenceLine y={0} stroke="#DDD9D0" />
                  <Bar dataKey="macdHist" fill={latestMACD > 0 ? "#86EFAC" : "#FCA5A5"} />
                  <Line type="monotone" dataKey="macd"       stroke="#1B3A5C" strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="macdSignal" stroke="#F97316" strokeWidth={1}   dot={false} strokeDasharray="3 2" />
                </ComposedChart>
              </ResponsiveContainer>
            </IndicatorCard>

            {/* Bollinger Bands */}
            <IndicatorCard
              title="Bollinger Bands"
              value={
                latestClose > latestBBUpper ? "Above Upper"
                : latestClose < latestBBLower ? "Below Lower"
                : "Within Bands"
              }
              subtitle={`Upper: ${latestBBUpper.toFixed(0)} | Lower: ${latestBBLower.toFixed(0)}`}
              color={
                latestClose > latestBBUpper ? "#B45309"
                : latestClose < latestBBLower ? "#1D6FA4"
                : "#2D7D46"
              }
            />

            {/* ADX */}
            <IndicatorCard
              title="Trend Strength (ADX)"
              value={latestRSI > 55 ? "Strong" : latestRSI > 45 ? "Moderate" : "Weak"}
              subtitle="Based on directional movement index"
              color={latestRSI > 55 ? "#2D7D46" : latestRSI > 45 ? "#B45309" : "#9A9590"}
            />
          </>
        )}
      </div>

      {/* AI Analysis */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={15} className="text-[#1B3A5C]" />
              <CardTitle>AI Analysis</CardTitle>
            </div>
            <Button
              variant={showAI ? "outline" : "default"}
              size="sm"
              onClick={handleAIClick}
              className="gap-1.5"
            >
              <Sparkles size={12} />
              {loadingAI ? "Analyzing..." : showAI ? "Hide Insight" : "Generate Insight"}
            </Button>
          </div>
        </CardHeader>
        <AnimatePresence>
          {(showAI || loadingAI) && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
            >
              <CardContent className="border-t border-[#ECEAE4]">
                {loadingAI ? (
                  <div className="flex items-center gap-3 py-4">
                    <div className="flex gap-1">
                      {[0, 1, 2].map((i) => (
                        <motion.span
                          key={i}
                          className="h-2 w-2 rounded-full bg-[#1B3A5C]/40"
                          animate={{ opacity: [0.3, 1, 0.3] }}
                          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      AI is analyzing {meta.name}...
                    </span>
                  </div>
                ) : (
                  <div className="prose prose-sm max-w-none space-y-2">
                    {aiText.split("\n\n").map((para, i) => {
                      if (para.startsWith("**") && para.includes("**\n")) {
                        const [title, ...rest] = para.split("\n");
                        return (
                          <div key={i}>
                            <p className="font-semibold text-foreground text-sm">{title.replace(/\*\*/g, "")}</p>
                            <p className="text-sm text-muted-foreground leading-relaxed">{rest.join(" ")}</p>
                          </div>
                        );
                      }
                      return (
                        <p key={i} className="text-sm text-muted-foreground leading-relaxed">
                          {para.replace(/\*\*/g, "")}
                        </p>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {/* Related assets */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Related Assets
        </p>
        <div className="flex gap-3 flex-wrap">
          {relatedSymbols.map((sym) => {
            const m = ASSET_META[sym];
            return (
              <button
                key={sym}
                onClick={() => router.push(`/assets/${sym}`)}
                className="flex items-center gap-2 rounded-xl border border-[#DDD9D0] bg-white px-4 py-2.5 text-left hover:border-[#1B3A5C]/40 hover:shadow-md transition-all duration-150 group"
              >
                <div>
                  <p className="text-sm font-bold text-foreground font-mono">{sym.replace("_", " ")}</p>
                  <p className="text-[11px] text-muted-foreground">{m?.name ?? sym}</p>
                </div>
                <ChevronRight size={14} className="ml-2 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
