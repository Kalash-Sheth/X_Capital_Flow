"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  TrendingUp,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Activity,
  Zap,
  AlertCircle,
  Layers,
  BarChart2,
  Eye,
  Clock,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import dynamic from "next/dynamic";
import type { FlowData, NodeData } from "@/components/rotation/RotationMap";
import FiiDiiChart from "@/components/charts/FiiDiiChart";
import type { FiiDiiResponse } from "@/app/api/fii-dii/route";

const RotationMap = dynamic(
  () => import("@/components/rotation/RotationMap"),
  { ssr: false, loading: () => <RotationMapSkeleton /> }
);

// ─── Types ────────────────────────────────────────────────────────────────────

type RegimeType = "Risk-On" | "Risk-Off" | "Neutral" | "Transitioning";

interface RotationResult {
  from: string;
  to: string;
  confidence: number;
  regime: RegimeType;
  signals: string[];
  strength: "Strong" | "Moderate" | "Weak";
  timeframe: string;
}

interface CapitalFlowPrediction {
  from:        string;
  to:          string;
  horizon:     "5D" | "10D" | "20D";
  confidence:  number;
  conf5D:      number;
  conf10D:     number;
  conf20D:     number;
  direction:   "Strengthening" | "Weakening" | "Reversing" | "Stable";
  targetAlloc: Record<string, number>;
  drivers:     string[];
  riskFactors: string[];
}

interface RotationApiData {
  primary: RotationResult;
  all: RotationResult[];
  predictions: CapitalFlowPrediction[];
  flows: FlowData[];
  nodes: NodeData[];
  timeline: Array<{
    date: string;
    equity: number;
    gold: number;
    bonds: number;
    cash: number;
    commodities: number;
    international: number;
  }>;
  fii: {
    net5D: number;
    diiNet5D: number;
    hasData: boolean;
  };
  regime: {
    type: string;
    confidence: number;
    score: number;
  };
  meta: Record<string, number | string>;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ─── Regime palette ───────────────────────────────────────────────────────────

const REGIME_PALETTE: Record<RegimeType, {
  bg: string; text: string; border: string;
  gradFrom: string; gradTo: string; dot: string;
}> = {
  "Risk-On":      { bg: "bg-emerald-50",  text: "text-emerald-800",  border: "border-emerald-200", gradFrom: "#10b981", gradTo: "#0d9488", dot: "bg-emerald-500" },
  "Risk-Off":     { bg: "bg-red-50",      text: "text-red-800",      border: "border-red-200",     gradFrom: "#ef4444", gradTo: "#dc2626", dot: "bg-red-500" },
  "Neutral":      { bg: "bg-amber-50",    text: "text-amber-800",    border: "border-amber-200",   gradFrom: "#f59e0b", gradTo: "#d97706", dot: "bg-amber-500" },
  "Transitioning":{ bg: "bg-blue-50",     text: "text-blue-800",     border: "border-blue-200",    gradFrom: "#3b82f6", gradTo: "#4f46e5", dot: "bg-blue-500" },
};

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.07, duration: 0.45, ease: [0.22, 1, 0.36, 1] },
  }),
};

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function RotationMapSkeleton() {
  return (
    <div className="w-full aspect-square max-w-[520px] mx-auto bg-gray-50 rounded-2xl animate-pulse flex items-center justify-center">
      <span className="text-xs text-gray-400">Loading Rotation Map…</span>
    </div>
  );
}

// ─── FII/DII Panel ────────────────────────────────────────────────────────────

function FiiDiiPanel({ fiiData, rotFii }: {
  fiiData: FiiDiiResponse | undefined;
  rotFii: RotationApiData["fii"] | undefined;
}) {
  const trendColor = (t: string) =>
    t === "Buying"  ? "text-emerald-700 bg-emerald-50 border-emerald-200" :
    t === "Selling" ? "text-red-700 bg-red-50 border-red-200" :
                     "text-amber-700 bg-amber-50 border-amber-200";

  const fmtCr = (v: number) =>
    `${v >= 0 ? "+" : ""}₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;

  const hasChartData = fiiData?.hasData && (fiiData.days?.length ?? 0) > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="p-1.5 bg-indigo-50 rounded-lg">
            <BarChart2 size={13} className="text-indigo-500" />
          </span>
          <h2 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
            Institutional Flows — FII / DII
          </h2>
          {fiiData?.lastDate && (
            <span className="text-[10px] text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">
              Last: {new Date(fiiData.lastDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
            </span>
          )}
        </div>
        {!fiiData?.hasData && (
          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full">
            Run --fii to populate
          </span>
        )}
      </div>

      <div className="p-5 space-y-4">
        {/* Stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* FII 20D Cumulative */}
          <div className="rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-3">
            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">FII 20D Net</p>
            <p className={`text-base font-black tabular-nums ${(fiiData?.cumFii20D ?? 0) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              {fiiData?.hasData ? fmtCr(fiiData.cumFii20D) : "—"}
            </p>
          </div>
          {/* DII 20D Cumulative */}
          <div className="rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-3">
            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">DII 20D Net</p>
            <p className={`text-base font-black tabular-nums ${(fiiData?.cumDii20D ?? 0) >= 0 ? "text-blue-600" : "text-orange-600"}`}>
              {fiiData?.hasData ? fmtCr(fiiData.cumDii20D) : "—"}
            </p>
          </div>
          {/* FII 5D Avg + Trend */}
          <div className="rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-3">
            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">FII Trend (5D)</p>
            <div className="flex items-center gap-2">
              <p className={`text-sm font-black tabular-nums ${(fiiData?.avgDailyFii5D ?? 0) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                {fiiData?.hasData ? fmtCr(fiiData.avgDailyFii5D) : "—"}
              </p>
              {fiiData?.hasData && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${trendColor(fiiData.fiTrend)}`}>
                  {fiiData.fiTrend}
                </span>
              )}
            </div>
          </div>
          {/* DII 5D Avg + Trend */}
          <div className="rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-3">
            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">DII Trend (5D)</p>
            <div className="flex items-center gap-2">
              <p className={`text-sm font-black tabular-nums ${(fiiData?.avgDailyDii5D ?? 0) >= 0 ? "text-blue-600" : "text-orange-600"}`}>
                {fiiData?.hasData ? fmtCr(fiiData.avgDailyDii5D) : "—"}
              </p>
              {fiiData?.hasData && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${trendColor(fiiData.diiTrend)}`}>
                  {fiiData.diiTrend}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Prediction confirmation row (from rotation API) */}
        {rotFii?.hasData && (
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-indigo-50/60 border border-indigo-100/60">
            <Zap size={11} className="text-indigo-400 shrink-0" />
            <p className="text-[10px] text-indigo-700 font-medium">
              Prediction inputs — FII 5D: {fmtCr(rotFii.net5D)}&nbsp;&nbsp;·&nbsp;&nbsp;DII 5D: {fmtCr(rotFii.diiNet5D)}
            </p>
          </div>
        )}

        {/* Chart or placeholder */}
        {hasChartData ? (
          <FiiDiiChart days={fiiData!.days} height={160} />
        ) : (
          <div className="flex items-center justify-center h-28 rounded-xl border border-dashed border-gray-200 bg-gray-50/40">
            <p className="text-[11px] text-gray-400 font-medium text-center leading-relaxed px-6">
              No FII/DII data yet.<br />
              Run <span className="font-mono text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">python3 scripts/fetch_prices.py --fii</span> to populate.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Prediction View ──────────────────────────────────────────────────────────

const DIRECTION_CONFIG: Record<string, { text: string; bg: string; border: string; icon: string }> = {
  Strengthening: { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", icon: "↑" },
  Weakening:     { text: "text-red-700",     bg: "bg-red-50",     border: "border-red-200",     icon: "↓" },
  Reversing:     { text: "text-amber-700",   bg: "bg-amber-50",   border: "border-amber-200",   icon: "⟳" },
  Stable:        { text: "text-blue-700",    bg: "bg-blue-50",    border: "border-blue-200",    icon: "→" },
};

function PredictionCard({ pred, index }: { pred: CapitalFlowPrediction; index: number }) {
  const [open, setOpen] = useState(false);
  const dir = DIRECTION_CONFIG[pred.direction] ?? DIRECTION_CONFIG.Stable;

  const horizons = [
    { label: "5D",  val: pred.conf5D,  color: "#6366f1" },
    { label: "10D", val: pred.conf10D, color: "#8b5cf6" },
    { label: "20D", val: pred.conf20D, color: "#a78bfa" },
  ];

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="show"
      className="bg-white rounded-xl border border-gray-100 overflow-hidden"
    >
      <button
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50/60 transition-colors"
      >
        <span className="text-[10px] font-black text-gray-300 w-5 shrink-0">#{index + 1}</span>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-black text-red-500 truncate leading-none">{pred.from}</span>
          <ArrowRight size={12} className="text-gray-300 shrink-0" />
          <span className="text-sm font-black text-emerald-600 truncate leading-none">{pred.to}</span>
        </div>

        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${dir.bg} ${dir.text} ${dir.border}`}>
          {dir.icon} {pred.direction}
        </span>

        {/* Horizon mini bars */}
        <div className="flex items-center gap-1.5 shrink-0">
          {horizons.map((h) => (
            <div key={h.label} className="flex flex-col items-center gap-0.5">
              <span className="text-[8px] text-gray-400 font-semibold">{h.label}</span>
              <div className="w-6 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.round(h.val * 100)}%`, backgroundColor: h.color }}
                />
              </div>
            </div>
          ))}
        </div>

        <span className="text-sm font-black text-gray-800 tabular-nums ml-1 shrink-0">
          {Math.round(pred.conf5D * 100)}%
        </span>
        {open ? <ChevronUp size={13} className="text-gray-400 shrink-0" /> : <ChevronDown size={13} className="text-gray-400 shrink-0" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="border-t border-gray-50 px-4 py-3 bg-gray-50/40 space-y-3">
              {/* Confidence horizons */}
              <div>
                <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-2">Confidence by Horizon</p>
                <div className="grid grid-cols-3 gap-2">
                  {horizons.map((h) => (
                    <div key={h.label} className="bg-white rounded-lg border border-gray-100 px-3 py-2">
                      <p className="text-[9px] font-black text-gray-400 uppercase mb-1">{h.label}</p>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <motion.div
                            className="h-full rounded-full"
                            style={{ backgroundColor: h.color }}
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.round(h.val * 100)}%` }}
                            transition={{ duration: 0.7, ease: "easeOut" }}
                          />
                        </div>
                        <span className="text-xs font-black tabular-nums" style={{ color: h.color }}>
                          {Math.round(h.val * 100)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Drivers */}
              {pred.drivers?.length > 0 && (
                <div>
                  <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Drivers</p>
                  <div className="flex flex-wrap gap-1.5">
                    {pred.drivers.map((d) => (
                      <span key={d} className="text-[10px] bg-white border border-emerald-200 text-emerald-700 px-2 py-0.5 rounded-full">
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Risk factors */}
              {pred.riskFactors?.length > 0 && (
                <div>
                  <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Risk Factors</p>
                  <div className="flex flex-wrap gap-1.5">
                    {pred.riskFactors.map((r) => (
                      <span key={r} className="text-[10px] bg-white border border-red-200 text-red-600 px-2 py-0.5 rounded-full">
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Target allocation preview */}
              {Object.keys(pred.targetAlloc ?? {}).length > 0 && (
                <div>
                  <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5">5D Target Allocation</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(pred.targetAlloc)
                      .sort(([, a], [, b]) => b - a)
                      .map(([k, v]) => (
                        <span key={k} className="text-[10px] bg-white border border-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-mono">
                          {k} {v}%
                        </span>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Primary Banner ───────────────────────────────────────────────────────────

function RotationBanner({ primary }: { primary: RotationResult }) {
  const pct = Math.round(primary.confidence * 100);
  const p   = REGIME_PALETTE[primary.regime] ?? REGIME_PALETTE["Neutral"];

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="relative overflow-hidden rounded-2xl border border-gray-200 shadow-md"
      style={{ background: `linear-gradient(135deg, ${p.gradFrom}18 0%, ${p.gradTo}08 100%)` }}
    >
      <div
        className="absolute -right-16 -top-16 w-64 h-64 rounded-full opacity-10 blur-3xl pointer-events-none"
        style={{ background: `radial-gradient(circle, ${p.gradFrom}, transparent)` }}
      />

      <div className="relative px-6 py-5 flex flex-col sm:flex-row sm:items-center gap-5">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className={["h-2 w-2 rounded-full animate-pulse", p.dot].join(" ")} />
            <p className={["text-[10px] font-black uppercase tracking-widest", p.text].join(" ")}>
              Primary Rotation Signal
            </p>
            <span className={["text-[10px] font-bold px-2 py-0.5 rounded-full border", p.bg, p.text, p.border].join(" ")}>
              {primary.regime}
            </span>
          </div>

          <div className="flex items-center gap-4 mb-3">
            <span className="text-3xl font-black text-red-600 leading-none">{primary.from}</span>
            <div className="flex items-center gap-0.5">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  animate={{ opacity: [0.3, 1, 0.3], x: [0, 4, 0] }}
                  transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.18, ease: "easeInOut" }}
                >
                  <ArrowRight size={i === 1 ? 24 : 16} className="text-gray-400" />
                </motion.div>
              ))}
            </div>
            <span className="text-3xl font-black text-emerald-600 leading-none">{primary.to}</span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {primary.signals.slice(0, 4).map((s) => (
              <span key={s} className={["text-[10px] font-semibold px-2.5 py-0.5 rounded-full border", p.bg, p.text, p.border].join(" ")}>
                {s}
              </span>
            ))}
          </div>
        </div>

        <div className="shrink-0 flex flex-col items-center sm:items-end gap-1">
          <div className="relative w-20 h-20">
            <svg viewBox="0 0 80 80" className="w-full h-full -rotate-90">
              <circle cx="40" cy="40" r="32" fill="none" stroke="#e5e7eb" strokeWidth="6" />
              <motion.circle
                cx="40" cy="40" r="32" fill="none"
                stroke={p.gradFrom} strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 32}`}
                initial={{ strokeDashoffset: 2 * Math.PI * 32 }}
                animate={{ strokeDashoffset: 2 * Math.PI * 32 * (1 - pct / 100) }}
                transition={{ duration: 1.2, delay: 0.3, ease: "easeOut" }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-lg font-black text-gray-900 leading-none">{pct}%</span>
            </div>
          </div>
          <p className={["text-[10px] font-bold text-center", p.text].join(" ")}>{primary.strength}</p>
          <p className="text-[10px] text-gray-400 text-center">{primary.timeframe}</p>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Rotation Signal Row ──────────────────────────────────────────────────────

function RotationSignalRow({ rotation, index, isExpanded, onToggle, prediction }: {
  rotation: RotationResult; index: number;
  isExpanded: boolean; onToggle: () => void;
  prediction?: CapitalFlowPrediction;
}) {
  const pct = Math.round(rotation.confidence * 100);
  const p   = REGIME_PALETTE[rotation.regime] ?? REGIME_PALETTE["Neutral"];
  const strengthConfig = {
    Strong:   { color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200", bar: "from-emerald-500 to-teal-400" },
    Moderate: { color: "text-amber-700",   bg: "bg-amber-50 border-amber-200",     bar: "from-amber-500 to-orange-400" },
    Weak:     { color: "text-gray-500",    bg: "bg-gray-50 border-gray-200",       bar: "from-gray-400 to-gray-300" },
  };
  const sc = strengthConfig[rotation.strength] ?? strengthConfig.Weak;
  const dir = prediction ? DIRECTION_CONFIG[prediction.direction] : null;

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="show"
      className="bg-white rounded-xl border border-gray-100 overflow-hidden hover:shadow-sm transition-all"
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50/60 transition-colors"
      >
        <span className="text-[10px] font-black text-gray-300 w-5 shrink-0 tabular-nums">#{index + 1}</span>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-black text-red-500 truncate leading-none">{rotation.from}</span>
          <motion.span
            animate={{ x: [0, 3, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, delay: index * 0.1 }}
          >
            <ArrowRight size={13} className="text-gray-300 shrink-0" />
          </motion.span>
          <span className="text-sm font-black text-emerald-600 truncate leading-none">{rotation.to}</span>
        </div>

        <span className={["hidden sm:inline text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0", p.bg, p.text, p.border].join(" ")}>
          {rotation.regime}
        </span>

        <span className={["text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0", sc.bg, sc.color].join(" ")}>
          {rotation.strength}
        </span>

        {/* Prediction direction pill */}
        {dir && (
          <span className={`hidden md:inline text-[9px] font-bold px-1.5 py-0.5 rounded-full border shrink-0 ${dir.bg} ${dir.text} ${dir.border}`}>
            {dir.icon} {prediction!.direction}
          </span>
        )}

        <div className="flex items-center gap-2 ml-1 shrink-0">
          <span className="text-sm font-black text-gray-800 tabular-nums">{pct}%</span>
          {isExpanded
            ? <ChevronUp size={13} className="text-gray-400" />
            : <ChevronDown size={13} className="text-gray-400" />}
        </div>
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="border-t border-gray-50 px-4 py-3 bg-gray-50/40 space-y-3">
              {/* Current confidence bar */}
              <div>
                <div className="flex justify-between text-[10px] text-gray-500 mb-1.5">
                  <span className="font-semibold uppercase tracking-wide">Current Signal Strength</span>
                  <span className="font-black text-gray-800">{pct}%</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                  <motion.div
                    className={`h-full rounded-full bg-gradient-to-r ${sc.bar}`}
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                  />
                </div>
              </div>

              {/* Prediction horizons */}
              {prediction && (
                <div>
                  <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-2">Predicted Confidence</p>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "5D",  val: prediction.conf5D,  color: "#6366f1" },
                      { label: "10D", val: prediction.conf10D, color: "#8b5cf6" },
                      { label: "20D", val: prediction.conf20D, color: "#a78bfa" },
                    ].map((h) => (
                      <div key={h.label} className="bg-white rounded-lg border border-gray-100 px-3 py-2">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[9px] font-black text-gray-400 uppercase">{h.label}</p>
                          <span className="text-[10px] font-black tabular-nums" style={{ color: h.color }}>
                            {Math.round(h.val * 100)}%
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <motion.div
                            className="h-full rounded-full"
                            style={{ backgroundColor: h.color }}
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.round(h.val * 100)}%` }}
                            transition={{ duration: 0.7, ease: "easeOut" }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Driving signals */}
              <div>
                <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-2">Driving Signals</p>
                <div className="flex flex-wrap gap-1.5">
                  {rotation.signals.map((sig) => (
                    <span key={sig} className="text-[10px] bg-white border border-gray-200 text-gray-600 px-2 py-0.5 rounded-full shadow-sm">
                      {sig}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Allocation Panel ─────────────────────────────────────────────────────────

function AllocationPanel({ nodes }: { nodes: NodeData[] }) {
  const sorted = [...nodes].sort((a, b) => b.value - a.value);
  const total  = sorted.reduce((s, n) => s + n.value, 0);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-2">
        <span className="p-1.5 bg-gray-50 rounded-lg">
          <TrendingUp size={13} className="text-gray-500" />
        </span>
        <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Current Allocation</h3>
      </div>
      <div className="p-5 space-y-3">
        {sorted.map((node, i) => {
          const pct = total > 0 ? Math.round((node.value / total) * 100) : node.value;
          return (
            <div key={node.id}>
              <div className="flex justify-between items-center mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: node.color }} />
                  <span className="text-xs font-semibold text-gray-700">{node.label}</span>
                </div>
                <span className="text-xs font-black tabular-nums" style={{ color: node.color }}>{node.value}%</span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <motion.div
                  className="h-2 rounded-full"
                  style={{ backgroundColor: node.color }}
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ delay: i * 0.07 + 0.2, duration: 0.8, ease: "easeOut" }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Flow Magnitude ───────────────────────────────────────────────────────────

function FlowMagnitudeTable({ flows, nodes }: { flows: FlowData[]; nodes: NodeData[] }) {
  const nodeLabel = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  const sorted = [...flows].sort((a, b) => b.magnitude - a.magnitude);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-2">
        <span className="p-1.5 bg-gray-50 rounded-lg">
          <Activity size={13} className="text-gray-500" />
        </span>
        <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Flow Magnitude</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50/80">
              <th className="text-left px-5 py-2.5 text-[10px] font-black text-gray-400 uppercase tracking-wider">From</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-black text-gray-400 uppercase tracking-wider">To</th>
              <th className="text-right px-5 py-2.5 text-[10px] font-black text-gray-400 uppercase tracking-wider">Magnitude</th>
              <th className="text-center px-5 py-2.5 text-[10px] font-black text-gray-400 uppercase tracking-wider">Type</th>
              <th className="px-5 py-2.5 text-[10px] font-black text-gray-400 uppercase tracking-wider w-32">Strength</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sorted.map((flow, i) => {
              const typeConfig = {
                inflow:  { text: "text-emerald-700", bg: "bg-emerald-50", bar: "from-emerald-500 to-teal-400" },
                outflow: { text: "text-red-700",     bg: "bg-red-50",     bar: "from-red-500 to-rose-400" },
                neutral: { text: "text-gray-600",    bg: "bg-gray-50",    bar: "from-gray-400 to-gray-300" },
              };
              const tc = typeConfig[flow.type as keyof typeof typeConfig] ?? typeConfig.neutral;
              const pct = Math.round(flow.magnitude * 100);

              return (
                <motion.tr
                  key={`${flow.from}-${flow.to}`}
                  custom={i}
                  variants={fadeUp}
                  initial="hidden"
                  animate="show"
                  className="hover:bg-gray-50/60 transition-colors"
                >
                  <td className="px-5 py-3 font-black text-red-500">{nodeLabel(flow.from)}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      <ArrowRight size={10} className="text-gray-300" />
                      <span className="font-black text-emerald-600">{nodeLabel(flow.to)}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right font-black font-mono text-gray-800">{pct}%</td>
                  <td className="px-5 py-3 text-center">
                    <span className={["text-[10px] font-bold px-2 py-0.5 rounded-full", tc.bg, tc.text].join(" ")}>
                      {flow.type}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full bg-gradient-to-r ${tc.bar}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ delay: i * 0.06 + 0.2, duration: 0.7, ease: "easeOut" }}
                      />
                    </div>
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Timeline Chart ───────────────────────────────────────────────────────────

const TIMELINE_LINES = [
  { key: "equity",        label: "Equity",       color: "#6366f1" },
  { key: "gold",          label: "Gold",          color: "#f59e0b" },
  { key: "bonds",         label: "Bonds",         color: "#3b82f6" },
  { key: "cash",          label: "Cash",          color: "#10b981" },
  { key: "commodities",   label: "Commodities",   color: "#ef4444" },
  { key: "international", label: "International", color: "#8b5cf6" },
];

const TimelineTooltip = ({
  active, payload, label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-xl p-3.5 text-xs min-w-[160px]">
      <p className="font-bold text-gray-700 mb-2.5 pb-2 border-b border-gray-100">{label}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: entry.color }} />
            <span className="text-gray-500 font-medium">{entry.name}</span>
          </span>
          <span className="font-black tabular-nums" style={{ color: entry.color }}>{entry.value}%</span>
        </div>
      ))}
    </div>
  );
};

function FlowTimeline({ data }: { data: RotationApiData["timeline"] }) {
  const thinned = useMemo(() => {
    const step = Math.max(1, Math.floor(data.length / 30));
    return data.filter((_, i) => i % step === 0 || i === data.length - 1);
  }, [data]);

  const tickFmt = (v: string) => new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="p-1.5 bg-gray-50 rounded-lg">
            <Layers size={13} className="text-gray-500" />
          </span>
          <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
            Capital Flow Timeline — 90 Day Allocation Shift
          </h3>
        </div>
        <span className="text-[10px] font-medium text-gray-400 bg-gray-50 px-2.5 py-1 rounded-full">Live Data</span>
      </div>
      <div className="p-5">
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={thinned} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              {TIMELINE_LINES.map((l) => (
                <linearGradient key={l.key} id={`tl-${l.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={l.color} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={l.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0eeea" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={tickFmt}
              tick={{ fontSize: 9, fill: "#9ca3af" }}
              axisLine={false} tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 9, fill: "#9ca3af" }}
              axisLine={false} tickLine={false}
              width={28}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip content={<TimelineTooltip />} />
            <Legend
              wrapperStyle={{ fontSize: 10, paddingTop: 12 }}
              iconType="circle"
              iconSize={7}
            />
            {TIMELINE_LINES.map((l) => (
              <Area
                key={l.key}
                type="monotone"
                dataKey={l.key}
                name={l.label}
                stroke={l.color}
                strokeWidth={1.8}
                fill={`url(#tl-${l.key})`}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function RotationPage() {
  const { data, isLoading, error, mutate } = useSWR<RotationApiData>(
    "/api/rotation", fetcher, { refreshInterval: 120_000 }
  );

  const { data: fiiData } = useSWR<FiiDiiResponse>(
    "/api/fii-dii", fetcher, { refreshInterval: 300_000 }
  );

  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
  const [mapView, setMapView] = useState<"current" | "predicted">("current");

  return (
    <div className="min-h-full -m-6 bg-[#F7F6F2]">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200/60 px-6 py-5">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex items-center justify-between flex-wrap gap-4"
        >
          <div>
            <div className="flex items-center gap-2.5 mb-1">
              <h1 className="text-2xl font-black text-gray-900 tracking-tight">Rotation Map</h1>
              <span className="flex items-center gap-1.5 text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2.5 py-1 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                LIVE
              </span>
            </div>
            <p className="text-sm text-gray-500">Real-time capital flow analysis across asset classes</p>
          </div>
          <button
            onClick={() => mutate()}
            disabled={isLoading}
            className="flex items-center gap-2 text-xs font-medium text-gray-400 hover:text-gray-700 bg-white border border-gray-200 hover:border-gray-300 px-3 py-1.5 rounded-xl transition-all disabled:opacity-50"
          >
            <RefreshCw size={11} className={isLoading ? "animate-spin" : ""} />
            {isLoading ? "Refreshing…" : "Refresh"}
          </button>
        </motion.div>
      </div>

      <div className="p-6 space-y-5">

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle size={15} />
            Failed to load rotation data. Make sure prices are ingested.
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div className="space-y-4 animate-pulse">
            <div className="h-28 rounded-2xl bg-white border border-gray-100" />
            <div className="h-40 rounded-2xl bg-white border border-gray-100" />
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-5">
              <div className="h-[520px] rounded-2xl bg-white border border-gray-100" />
              <div className="space-y-4">
                <div className="h-48 rounded-2xl bg-white border border-gray-100" />
                <div className="h-48 rounded-2xl bg-white border border-gray-100" />
              </div>
            </div>
          </div>
        )}

        {/* ── Layer 1: Primary banner ───────────────────────────────────── */}
        {data?.primary && <RotationBanner primary={data.primary} />}

        {/* ── Layer 2: Institutional FII/DII flows ─────────────────────── */}
        {(data || fiiData) && (
          <FiiDiiPanel fiiData={fiiData} rotFii={data?.fii} />
        )}

        {/* ── Layer 3: Capital Flow Network (Current) + Right panel ─────── */}
        {data && (
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-5">

            {/* Capital Flow Network with Current / Predicted tabs */}
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 bg-gray-50 rounded-lg">
                    <Activity size={13} className="text-gray-500" />
                  </span>
                  <h2 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Capital Flow Network</h2>
                </div>

                <div className="flex items-center gap-3">
                  {/* Current / Predicted toggle */}
                  <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
                    <button
                      onClick={() => setMapView("current")}
                      className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-md transition-all ${
                        mapView === "current"
                          ? "bg-white text-gray-800 shadow-sm"
                          : "text-gray-400 hover:text-gray-600"
                      }`}
                    >
                      <Eye size={10} />
                      Current
                    </button>
                    <button
                      onClick={() => setMapView("predicted")}
                      className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-md transition-all ${
                        mapView === "predicted"
                          ? "bg-white text-indigo-700 shadow-sm"
                          : "text-gray-400 hover:text-gray-600"
                      }`}
                    >
                      <Clock size={10} />
                      Predicted
                    </button>
                  </div>

                  {mapView === "current" && (
                    <div className="hidden sm:flex items-center gap-3 text-[10px] text-gray-500">
                      {[
                        { label: "Inflow",  color: "bg-emerald-500" },
                        { label: "Outflow", color: "bg-red-500" },
                        { label: "Neutral", color: "bg-gray-400" },
                      ].map(({ label, color }) => (
                        <span key={label} className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full ${color}`} />
                          <span className="font-medium">{label}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <AnimatePresence mode="wait">
                {mapView === "current" ? (
                  <motion.div
                    key="current"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="p-5 flex justify-center">
                      <RotationMap nodes={data.nodes} flows={data.flows} width={500} height={460} animated />
                    </div>

                    <div className="mx-5 mb-5 flex items-start gap-2 p-3.5 bg-blue-50/60 rounded-xl border border-blue-100/60">
                      <Zap size={12} className="text-blue-400 shrink-0 mt-0.5" />
                      <p className="text-[10px] text-blue-700 leading-relaxed font-medium">
                        Node size = current allocation. Arrow thickness = flow magnitude. Green glow = receiving capital. Red glow = sending capital.
                        <span className="ml-1 text-blue-500">Technical-momentum proxy — not FII/DII predictions.</span>
                      </p>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="predicted"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="p-5 space-y-3"
                  >
                    <div className="flex items-center gap-2 p-3.5 bg-indigo-50/60 rounded-xl border border-indigo-100/60 mb-1">
                      <Clock size={12} className="text-indigo-400 shrink-0" />
                      <p className="text-[10px] text-indigo-700 font-medium leading-relaxed">
                        Forward confidence estimates based on MACD direction, RSI slope, FII 5D net, and cycle persistence. Not a guarantee of future returns.
                      </p>
                    </div>

                    {(data.predictions ?? []).length === 0 ? (
                      <div className="flex items-center justify-center h-40 text-xs text-gray-400">
                        No prediction data available
                      </div>
                    ) : (
                      (data.predictions ?? []).map((pred, i) => (
                        <PredictionCard key={`${pred.from}-${pred.to}`} pred={pred} index={i} />
                      ))
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

            {/* Right panel */}
            <div className="flex flex-col gap-4">
              <AllocationPanel nodes={data.nodes} />

              {/* Rotation signals with prediction overlays */}
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-2">
                  <span className="p-1.5 bg-gray-50 rounded-lg">
                    <Zap size={13} className="text-gray-500" />
                  </span>
                  <h3 className="text-[11px] font-bold text-gray-500 uppercase tracking-wider flex-1">Rotation Signals</h3>
                  <span className="text-[10px] font-semibold text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">
                    {data.all.length} active
                  </span>
                </div>
                <div className="p-3 space-y-2">
                  {data.all.map((rot, i) => {
                    const pred = (data.predictions ?? []).find(
                      (p) => p.from === rot.from && p.to === rot.to
                    );
                    return (
                      <RotationSignalRow
                        key={`${rot.from}-${rot.to}`}
                        rotation={rot}
                        index={i}
                        isExpanded={expandedIndex === i}
                        onToggle={() => setExpandedIndex((prev) => (prev === i ? null : i))}
                        prediction={pred}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Timeline */}
        {data?.timeline && (
          <motion.div custom={5} variants={fadeUp} initial="hidden" animate="show">
            <FlowTimeline data={data.timeline} />
          </motion.div>
        )}

        {/* Flow table */}
        {data?.flows && (
          <motion.div custom={6} variants={fadeUp} initial="hidden" animate="show">
            <FlowMagnitudeTable flows={data.flows} nodes={data.nodes} />
          </motion.div>
        )}

      </div>
    </div>
  );
}
