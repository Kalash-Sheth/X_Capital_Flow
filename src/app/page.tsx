"use client";

import { useCallback } from "react";
import useSWR from "swr";
import { motion, AnimatePresence } from "framer-motion";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
  Activity,
  Zap,
  BarChart2,
  DollarSign,
  Globe,
  ArrowRight,
  ShieldCheck,
  Brain,
  ChevronRight,
  AlertCircle,
  Lightbulb,
  Target,
  Wifi,
} from "lucide-react";

import RegimeBadge from "@/components/dashboard/RegimeBadge";
import SparklineChart from "@/components/charts/SparklineChart";

// ─── Types ──────────────────────────────────────────────────────────────────

type RegimeType = "Risk-On" | "Risk-Off" | "Neutral" | "Transitioning";

interface MarketApiData {
  regime: RegimeType;
  regimeConfidence: number;
  vix: number;
  vixHistory: number[];
  fiiFlow: number;
  fiiHistory: number[];
  rotationScore: number;
  rotationHistory: number[];
  marketHealth: number;
  healthHistory: number[];
  assets: AssetCard[];
  quickStats: QuickStats;
}

interface AssetCard {
  ticker: string;
  name: string;
  price: number;
  change1D: number;
  pct1D: number;
  trend: number[];
}

interface QuickStats {
  yieldCurve: string;
  yieldSpread: number;
  breadthPct: number;
  adRatio: number;
  realYield: number;
}

interface RotationSignal {
  from:       string;
  to:         string;
  confidence: number;
  regime:     RegimeType;
  signals:    string[];
  strength:   string;
}

interface RotationApiData {
  primary: RotationSignal | null;   // null when no signal clears threshold
  all:     RotationSignal[];
}

interface AIInsightApiData {
  title: string;
  happening: string;
  why: string;
  action: string;
  confidence: number;
  generatedAt: string;
  tags: string[];
}

// ─── Fetcher ─────────────────────────────────────────────────────────────────

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ─── Animation variants ───────────────────────────────────────────────────────

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.06, duration: 0.5, ease: [0.22, 1, 0.36, 1] },
  }),
};

const scaleIn = {
  hidden: { opacity: 0, scale: 0.94 },
  show: (i: number) => ({
    opacity: 1,
    scale: 1,
    transition: { delay: i * 0.05, duration: 0.45, ease: [0.22, 1, 0.36, 1] },
  }),
};

// ─── Regime config ────────────────────────────────────────────────────────────

const REGIME_GRADIENTS: Record<RegimeType, { from: string; to: string; border: string; glow: string }> = {
  "Risk-On":      { from: "from-emerald-500", to: "to-teal-600",   border: "border-emerald-200", glow: "shadow-emerald-100" },
  "Risk-Off":     { from: "from-red-500",     to: "to-rose-600",   border: "border-red-200",     glow: "shadow-red-100" },
  "Neutral":      { from: "from-amber-500",   to: "to-orange-500", border: "border-amber-200",   glow: "shadow-amber-100" },
  "Transitioning":{ from: "from-blue-500",    to: "to-indigo-600", border: "border-blue-200",    glow: "shadow-blue-100" },
};

// ─── Metric Card ──────────────────────────────────────────────────────────────

function MetricCard({
  title, value, unit, trend, sparkData, sparkColor,
  delta, deltaLabel, icon: Icon, index, accentColor,
}: {
  title: string; value: string | number; unit?: string;
  trend: "up" | "down" | "neutral"; sparkData: number[];
  sparkColor: string; delta?: string; deltaLabel?: string;
  icon: React.ElementType; index: number; accentColor: string;
}) {
  const trendColor = trend === "up" ? "text-emerald-600" : trend === "down" ? "text-red-500" : "text-gray-400";
  const TrendIcon  = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendBg    = trend === "up" ? "bg-emerald-50 border-emerald-100" : trend === "down" ? "bg-red-50 border-red-100" : "bg-gray-50 border-gray-100";

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="show"
      className="relative bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300 group"
    >
      {/* Colored top accent */}
      <div className="h-0.5 w-full" style={{ background: `linear-gradient(90deg, ${sparkColor}, ${sparkColor}88)` }} />

      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg" style={{ background: `${accentColor}15` }}>
              <Icon size={14} style={{ color: accentColor }} />
            </span>
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{title}</span>
          </div>
          <span className={["flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border", trendBg, trendColor].join(" ")}>
            <TrendIcon size={10} />
            {delta}
          </span>
        </div>

        <div className="flex items-end justify-between gap-2">
          <div>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-black text-gray-900 tabular-nums tracking-tight">{value}</span>
              {unit && <span className="text-sm font-medium text-gray-400">{unit}</span>}
            </div>
            {deltaLabel && <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">{deltaLabel}</p>}
          </div>
          <div className="w-24 shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
            <SparklineChart data={sparkData} color={sparkColor} height={38} area />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Asset Price Card ─────────────────────────────────────────────────────────

function AssetPriceCard({ asset, index }: { asset: AssetCard; index: number }) {
  const positive = asset.pct1D >= 0;
  const color    = positive ? "#10b981" : "#ef4444";

  return (
    <motion.div
      custom={index}
      variants={scaleIn}
      initial="hidden"
      animate="show"
      className="relative bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-2.5 hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 overflow-hidden group"
    >
      {/* Subtle background tint */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none rounded-2xl"
        style={{ background: `${color}05` }}
      />

      <div className="flex items-start justify-between relative">
        <div>
          <span className="text-[10px] font-black tracking-widest text-gray-400 uppercase">{asset.ticker}</span>
          <p className="text-[11px] text-gray-500 mt-0.5 leading-tight">{asset.name}</p>
        </div>
        <span className={[
          "text-[11px] font-black px-2 py-0.5 rounded-full",
          positive ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600",
        ].join(" ")}>
          {positive ? "+" : ""}{(asset.pct1D ?? 0).toFixed(2)}%
        </span>
      </div>

      <div className="relative">
        <div className="flex items-baseline gap-1 mb-1">
          <span className="text-lg font-black text-gray-900 tabular-nums tracking-tight">
            {asset.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
          </span>
          <span className={["text-[10px] font-bold", positive ? "text-emerald-600" : "text-red-500"].join(" ")}>
            {positive ? "▲" : "▼"} {Math.abs(asset.change1D).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
          </span>
        </div>
        <SparklineChart data={asset.trend} color={color} height={28} area />
      </div>
    </motion.div>
  );
}

// ─── Rotation Summary Card ────────────────────────────────────────────────────

function RotationSummaryCard({ data, index }: { data: RotationApiData; index: number }) {
  const p = data.primary;

  if (!p) {
    return (
      <motion.div
        custom={index}
        variants={fadeUp}
        initial="hidden"
        animate="show"
        className="relative bg-gradient-to-br from-gray-50 to-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col items-center justify-center gap-2 text-center"
      >
        <BarChart2 size={20} className="text-gray-300" />
        <p className="text-xs font-semibold text-gray-400">No Active Rotation Signal</p>
        <p className="text-[11px] text-gray-400">Conditions not met for any rotation threshold</p>
      </motion.div>
    );
  }

  const pct = Math.round(p.confidence * 100);
  const regimeGradient: Record<string, string> = {
    "Risk-On":      "from-emerald-500/10 to-teal-500/5",
    "Risk-Off":     "from-red-500/10 to-rose-500/5",
    "Neutral":      "from-amber-500/10 to-orange-500/5",
    "Transitioning":"from-blue-500/10 to-indigo-500/5",
  };
  const regimeBadge: Record<string, string> = {
    "Risk-On":      "bg-emerald-100 text-emerald-800",
    "Risk-Off":     "bg-red-100 text-red-800",
    "Neutral":      "bg-amber-100 text-amber-800",
    "Transitioning":"bg-blue-100 text-blue-800",
  };

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="show"
      className={`relative bg-gradient-to-br ${regimeGradient[p.regime] ?? "from-gray-50 to-white"} rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-4 hover:shadow-md transition-shadow overflow-hidden`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="p-1.5 bg-indigo-100 rounded-lg">
            <BarChart2 size={14} className="text-indigo-600" />
          </span>
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Active Rotation</span>
        </div>
        <span className={["text-[10px] font-bold px-2.5 py-1 rounded-full", regimeBadge[p.regime] ?? "bg-gray-100 text-gray-700"].join(" ")}>
          {p.regime}
        </span>
      </div>

      {/* Animated flow arrow */}
      <div className="flex items-center justify-center gap-4 py-1">
        <div className="text-center">
          <p className="text-[9px] text-gray-400 uppercase tracking-widest mb-1">Outflow</p>
          <p className="text-xl font-black text-red-500 leading-none">{p.from}</p>
        </div>
        <div className="flex items-center gap-0.5">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              animate={{ opacity: [0.2, 1, 0.2], x: [0, 3, 0] }}
              transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.2 }}
            >
              <ArrowRight size={i === 1 ? 20 : 14} className="text-gray-300" />
            </motion.div>
          ))}
        </div>
        <div className="text-center">
          <p className="text-[9px] text-gray-400 uppercase tracking-widest mb-1">Inflow</p>
          <p className="text-xl font-black text-emerald-600 leading-none">{p.to}</p>
        </div>
      </div>

      {/* Confidence */}
      <div>
        <div className="flex justify-between text-[10px] text-gray-500 mb-1.5">
          <span className="font-medium">Signal Confidence</span>
          <span className="font-bold text-gray-800">{pct}%</span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ delay: 0.4, duration: 1, ease: "easeOut" }}
          />
        </div>
        <p className="text-[10px] text-gray-400 mt-1.5">{p.strength} · {p.signals[0]}</p>
      </div>
    </motion.div>
  );
}

// ─── AI Insight Card ──────────────────────────────────────────────────────────

function AIInsightCard({ data, isLoading, onRefresh, index }: {
  data: AIInsightApiData | null; isLoading: boolean;
  onRefresh: () => void; index: number;
}) {
  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="show"
      className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow"
    >
      {/* Animated gradient top bar */}
      <div className="h-[3px] bg-gradient-to-r from-violet-500 via-indigo-500 via-blue-500 to-cyan-500 bg-[length:200%_100%] animate-[gradientShift_3s_linear_infinite]" />

      <div className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <span className="p-2 bg-gradient-to-br from-violet-50 to-indigo-50 rounded-xl border border-violet-100">
              <Brain size={14} className="text-violet-600" />
            </span>
            <div>
              <p className="text-xs font-bold text-gray-800">AI Market Insight</p>
              {data && (
                <p className="text-[10px] text-gray-400">
                  {new Date(data.generatedAt).toLocaleTimeString("en-IN", {
                    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
                  })} IST
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="p-2 rounded-xl hover:bg-gray-50 transition-colors text-gray-400 hover:text-gray-600 border border-transparent hover:border-gray-100"
          >
            <RefreshCw size={13} className={isLoading ? "animate-spin" : ""} />
          </button>
        </div>

        {isLoading ? (
          <div className="space-y-3 animate-pulse">
            <div className="h-4 bg-gray-100 rounded-lg w-3/4" />
            <div className="h-3 bg-gray-100 rounded-lg" />
            <div className="h-3 bg-gray-100 rounded-lg w-5/6" />
            <div className="h-3 bg-gray-100 rounded-lg w-4/6" />
          </div>
        ) : data ? (
          <>
            <h3 className="text-sm font-bold text-gray-900 mb-4 leading-snug">{data.title}</h3>

            <div className="space-y-2.5">
              <div className="flex gap-3 p-3.5 bg-blue-50/80 rounded-xl border border-blue-100/60">
                <div className="p-1.5 bg-blue-100 rounded-lg shrink-0 mt-0.5">
                  <AlertCircle size={12} className="text-blue-600" />
                </div>
                <div>
                  <p className="text-[9px] font-black text-blue-600 uppercase tracking-widest mb-1">What&apos;s Happening</p>
                  <p className="text-xs text-blue-900 leading-relaxed">{data.happening}</p>
                </div>
              </div>

              <div className="flex gap-3 p-3.5 bg-amber-50/80 rounded-xl border border-amber-100/60">
                <div className="p-1.5 bg-amber-100 rounded-lg shrink-0 mt-0.5">
                  <Lightbulb size={12} className="text-amber-600" />
                </div>
                <div>
                  <p className="text-[9px] font-black text-amber-600 uppercase tracking-widest mb-1">Why It&apos;s Happening</p>
                  <p className="text-xs text-amber-900 leading-relaxed">{data.why}</p>
                </div>
              </div>

              <div className="flex gap-3 p-3.5 bg-emerald-50/80 rounded-xl border border-emerald-100/60">
                <div className="p-1.5 bg-emerald-100 rounded-lg shrink-0 mt-0.5">
                  <Target size={12} className="text-emerald-600" />
                </div>
                <div>
                  <p className="text-[9px] font-black text-emerald-700 uppercase tracking-widest mb-1">What To Do</p>
                  <p className="text-xs text-emerald-900 leading-relaxed">{data.action}</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 mt-4 pt-3 border-t border-gray-50">
              {data.tags.map((tag) => (
                <span key={tag} className="text-[9px] font-semibold bg-violet-50 text-violet-700 border border-violet-100 px-2 py-0.5 rounded-full uppercase tracking-wide">
                  {tag}
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400 text-center py-4">No insight available.</p>
        )}
      </div>
    </motion.div>
  );
}

// ─── Quick Stats Panel ────────────────────────────────────────────────────────

function QuickStatsPanel({ stats, index }: { stats: QuickStats; index: number }) {
  const items = [
    {
      label: "Yield Curve",
      value: stats.yieldCurve ?? "—",
      sub: `${(stats.yieldSpread ?? 0) > 0 ? "+" : ""}${(stats.yieldSpread ?? 0).toFixed(2)}% spread`,
      positive: stats.yieldCurve !== "Inverted",
      icon: Activity,
    },
    {
      label: "Market Breadth",
      value: `${stats.breadthPct ?? 0}%`,
      sub: "above 50-day MA",
      positive: (stats.breadthPct ?? 0) > 50,
      icon: BarChart2,
    },
    {
      label: "A/D Ratio",
      value: (stats.adRatio ?? 0).toFixed(2),
      sub: (stats.adRatio ?? 0) >= 1 ? "More advances" : "More declines",
      positive: (stats.adRatio ?? 0) >= 1,
      icon: TrendingUp,
    },
    {
      label: "Real Yield",
      value: `${(stats.realYield ?? 0).toFixed(2)}%`,
      sub: "10Y Treasury − CPI",
      positive: stats.realYield < 2,
      icon: Globe,
    },
  ];

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="show"
      className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow h-full"
    >
      <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-2">
        <span className="p-1.5 bg-gray-50 rounded-lg">
          <ShieldCheck size={13} className="text-gray-500" />
        </span>
        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Market Pulse</span>
      </div>

      <div className="divide-y divide-gray-50/80">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50/50 transition-colors">
              <span className={["p-1.5 rounded-lg shrink-0", item.positive ? "bg-emerald-50" : "bg-red-50"].join(" ")}>
                <Icon size={11} className={item.positive ? "text-emerald-600" : "text-red-500"} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">{item.label}</p>
                <p className="text-[10px] text-gray-400 truncate">{item.sub}</p>
              </div>
              <span className={["text-sm font-black tabular-nums", item.positive ? "text-emerald-600" : "text-red-500"].join(" ")}>
                {item.value}
              </span>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function DashboardPage() {
  const {
    data: market,
    isLoading: mktLoading,
    mutate: mktMutate,
  } = useSWR<MarketApiData>("/api/market", fetcher, { refreshInterval: 60_000 });

  const { data: rotation } = useSWR<RotationApiData>("/api/rotation", fetcher, {
    refreshInterval: 120_000,
  });

  const {
    data: ai,
    isLoading: aiLoading,
    mutate: aiMutate,
  } = useSWR<AIInsightApiData>("/api/ai/insight", fetcher, { refreshInterval: 300_000 });

  const refreshAI = useCallback(() => {
    aiMutate(undefined, { revalidate: true });
  }, [aiMutate]);

  const vixTrend    = (market?.vix ?? 15) > 20 ? "up" : (market?.vix ?? 15) < 16 ? "down" : "neutral" as const;
  const fiiTrend    = (market?.fiiFlow ?? 0) > 0 ? "up" : "down" as const;
  const scoreTrend  = (market?.rotationScore ?? 50) > 55 ? "up" : (market?.rotationScore ?? 50) < 40 ? "down" : "neutral" as const;
  const healthTrend = (market?.marketHealth ?? 50) > 60 ? "up" : (market?.marketHealth ?? 50) < 40 ? "down" : "neutral" as const;

  const regimeGrad  = market ? REGIME_GRADIENTS[market.regime] : null;

  return (
    <div className="min-h-full -m-6 bg-[#F7F6F2]">

      {/* ── Hero Header ────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden border-b border-gray-200/60 bg-white px-6 py-5 mb-0">
        {/* Subtle gradient orb */}
        <div className="absolute -top-12 -right-12 w-48 h-48 rounded-full opacity-[0.06] blur-3xl pointer-events-none"
          style={{ background: market ? (market.regime === "Risk-On" ? "#10b981" : market.regime === "Risk-Off" ? "#ef4444" : "#f59e0b") : "#6366f1" }}
        />

        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="flex items-center justify-between flex-wrap gap-4 relative"
        >
          <div>
            <div className="flex items-center gap-2.5 mb-1">
              <h1 className="text-2xl font-black text-gray-900 tracking-tight">Market Dashboard</h1>
              <AnimatePresence>
                {!mktLoading && (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    LIVE
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <p className="text-sm text-gray-500">
              Capital flow &amp; regime intelligence ·{" "}
              <span className="font-semibold text-gray-700">
                {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              </span>
            </p>
          </div>

          <div className="flex items-center gap-3">
            {market && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-semibold ${regimeGrad?.border} ${regimeGrad?.glow} shadow-sm`}
                style={{ background: `${market.regime === "Risk-On" ? "#ecfdf5" : market.regime === "Risk-Off" ? "#fef2f2" : "#fffbeb"}` }}
              >
                <Wifi size={12} className={market.regime === "Risk-On" ? "text-emerald-600" : market.regime === "Risk-Off" ? "text-red-600" : "text-amber-600"} />
                <span className={market.regime === "Risk-On" ? "text-emerald-700" : market.regime === "Risk-Off" ? "text-red-700" : "text-amber-700"}>
                  {market.regime}
                </span>
              </motion.div>
            )}
            <button
              onClick={() => mktMutate()}
              className="flex items-center gap-2 text-xs font-medium text-gray-400 hover:text-gray-700 bg-white border border-gray-200 hover:border-gray-300 px-3 py-1.5 rounded-xl transition-all"
            >
              <RefreshCw size={11} className={mktLoading ? "animate-spin" : ""} />
              {mktLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </motion.div>
      </div>

      <div className="p-6 space-y-5">

        {/* ── Loading ─────────────────────────────────────────────────────── */}
        {mktLoading && (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 animate-pulse">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 bg-white rounded-2xl border border-gray-100" />
            ))}
          </div>
        )}

        {/* ── ROW 1: Regime (hero) + Active Rotation + 2 Metrics ──────────── */}
        {market && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">

            {/* Regime Hero Card — spans visually as the anchor */}
            <motion.div
              custom={0}
              variants={fadeUp}
              initial="hidden"
              animate="show"
              className="relative bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden hover:shadow-lg transition-shadow"
            >
              {/* Gradient accent background */}
              <div className={`absolute inset-0 bg-gradient-to-br ${regimeGrad?.from} ${regimeGrad?.to} opacity-[0.06] pointer-events-none`} />
              <div className="relative p-5 h-full flex flex-col justify-between">
                <div className="flex items-center gap-2 mb-3">
                  <span className="p-1.5 rounded-lg bg-gray-50">
                    <Zap size={13} className="text-gray-500" />
                  </span>
                  <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Market Regime</span>
                </div>
                <RegimeBadge regime={market.regime} confidence={market.regimeConfidence} size="md" />
              </div>
            </motion.div>

            {rotation && <RotationSummaryCard data={rotation} index={1} />}

            <MetricCard
              title="Volatility (RVol)"
              value={(market.vix ?? 0).toFixed(1)} unit="%"
              trend={vixTrend}
              sparkData={market.vixHistory ?? []}
              sparkColor={(market.vix ?? 0) > 20 ? "#ef4444" : "#10b981"}
              delta={(market.vix ?? 0) > 20 ? "Elevated" : "Calm"}
              deltaLabel="Nifty 20D realized vol"
              icon={Activity} index={2}
              accentColor={(market.vix ?? 0) > 20 ? "#ef4444" : "#10b981"}
            />

            <MetricCard
              title="FII Proxy"
              value={market.fiiFlow >= 0 ? `+${Math.abs(market.fiiFlow).toLocaleString("en-IN")}` : `-${Math.abs(market.fiiFlow).toLocaleString("en-IN")}`}
              trend={fiiTrend}
              sparkData={market.fiiHistory}
              sparkColor={market.fiiFlow >= 0 ? "#10b981" : "#ef4444"}
              delta={market.fiiFlow >= 0 ? "INR ↑" : "INR ↓"}
              deltaLabel="USD/INR momentum signal"
              icon={DollarSign} index={3}
              accentColor={market.fiiFlow >= 0 ? "#10b981" : "#ef4444"}
            />
          </div>
        )}

        {/* ── ROW 2: Rotation Score + Market Health ────────────────────────── */}
        {market && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <MetricCard
              title="Capital Rotation Score"
              value={market.rotationScore} unit="/ 100"
              trend={scoreTrend}
              sparkData={market.rotationHistory}
              sparkColor={market.rotationScore > 55 ? "#10b981" : "#f59e0b"}
              delta={market.rotationScore > 55 ? "Bullish" : market.rotationScore < 40 ? "Bearish" : "Mixed"}
              deltaLabel="Composite momentum index"
              icon={Globe} index={4}
              accentColor={market.rotationScore > 55 ? "#10b981" : "#f59e0b"}
            />
            <MetricCard
              title="Market Health Score"
              value={market.marketHealth} unit="/ 100"
              trend={healthTrend}
              sparkData={market.healthHistory}
              sparkColor={market.marketHealth > 60 ? "#10b981" : "#ef4444"}
              delta={market.marketHealth > 60 ? "Healthy" : market.marketHealth < 40 ? "Weak" : "Fair"}
              deltaLabel="Breadth · momentum · vol"
              icon={BarChart2} index={5}
              accentColor={market.marketHealth > 60 ? "#10b981" : "#ef4444"}
            />
          </div>
        )}

        {/* ── ROW 3: AI Insight (2/3) + Market Pulse (1/3) ─────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <AIInsightCard data={ai ?? null} isLoading={aiLoading} onRefresh={refreshAI} index={6} />
          </div>
          {market?.quickStats && (
            <QuickStatsPanel stats={market.quickStats} index={7} />
          )}
        </div>

        {/* ── ROW 4: Asset Prices ───────────────────────────────────────────── */}
        {market?.assets && (
          <motion.div custom={8} variants={fadeUp} initial="hidden" animate="show">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-1 h-4 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500" />
                <h2 className="text-sm font-bold text-gray-800">Live Asset Prices</h2>
                <span className="text-[10px] text-gray-400 font-medium bg-gray-100 px-2 py-0.5 rounded-full">1D change</span>
              </div>
              <a href="/assets" className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-semibold transition-colors">
                All Assets <ChevronRight size={12} />
              </a>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
              {market.assets.map((asset, i) => (
                <AssetPriceCard key={asset.ticker} asset={asset} index={i} />
              ))}
            </div>
          </motion.div>
        )}

        {/* ── ROW 5: Active Rotations ───────────────────────────────────────── */}
        {rotation?.all && (
          <motion.div custom={14} variants={fadeUp} initial="hidden" animate="show">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-1 h-4 rounded-full bg-gradient-to-b from-violet-500 to-indigo-500" />
                <h2 className="text-sm font-bold text-gray-800">Active Capital Rotations</h2>
                <span className="text-[10px] text-gray-400 font-medium bg-gray-100 px-2 py-0.5 rounded-full">
                  {rotation.all.length} signal{rotation.all.length !== 1 ? "s" : ""}
                </span>
              </div>
              <a href="/rotation" className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-semibold transition-colors">
                Full Rotation Map <ChevronRight size={12} />
              </a>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {rotation.all.map((rot, i) => {
                const pct = Math.round(rot.confidence * 100);
                const borderColors: Record<string, string> = {
                  "Risk-On":      "border-l-emerald-500",
                  "Risk-Off":     "border-l-red-500",
                  "Neutral":      "border-l-amber-500",
                  "Transitioning":"border-l-blue-500",
                };
                const barColors: Record<string, string> = {
                  "Risk-On":      "from-emerald-500 to-teal-400",
                  "Risk-Off":     "from-red-500 to-rose-400",
                  "Neutral":      "from-amber-500 to-orange-400",
                  "Transitioning":"from-blue-500 to-indigo-400",
                };
                return (
                  <motion.div
                    key={`${rot.from}-${rot.to}`}
                    custom={i}
                    variants={scaleIn}
                    initial="hidden"
                    animate="show"
                    className={[
                      "bg-white rounded-xl border border-gray-100 border-l-4 shadow-sm p-4 hover:shadow-md hover:-translate-y-0.5 transition-all duration-300",
                      borderColors[rot.regime] ?? "border-l-gray-300",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between mb-2.5">
                      <div className="flex items-center gap-1.5 text-sm font-bold">
                        <span className="text-red-500">{rot.from}</span>
                        <motion.span
                          animate={{ x: [0, 3, 0] }}
                          transition={{ duration: 1.6, repeat: Infinity }}
                        >
                          <ArrowRight size={13} className="text-gray-300" />
                        </motion.span>
                        <span className="text-emerald-600">{rot.to}</span>
                      </div>
                      <span className="text-xs font-black text-gray-700 tabular-nums">{pct}%</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-1.5 mb-2.5 overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full bg-gradient-to-r ${barColors[rot.regime] ?? "from-gray-400 to-gray-300"}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ delay: i * 0.1 + 0.3, duration: 0.8, ease: "easeOut" }}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {rot.signals.slice(0, 2).map((s) => (
                        <span key={s} className="text-[9px] font-medium bg-gray-50 border border-gray-200 text-gray-500 px-1.5 py-0.5 rounded-full">
                          {s}
                        </span>
                      ))}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}

      </div>
    </div>
  );
}
