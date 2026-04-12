"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import useSWR from "swr";
import {
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  Info,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  Zap,
  Clock,
  Brain,
  AlertCircle,
  ShieldCheck,
  Activity,
  Lightbulb,
  Sparkles,
} from "lucide-react";
import AllocationBar from "@/components/portfolio/AllocationBar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Allocation {
  asset:      string;
  symbol:     string;
  assetClass: string;
  current:    number;
  suggested:  number;
  change:     number;
  rationale:  string;
  priority:   "HIGH" | "MEDIUM" | "LOW";
}

interface RebalancingAction {
  id:        string;
  type:      "REDUCE" | "INCREASE" | "LIQUIDATE" | "INITIATE";
  asset:     string;
  fromPct:   number;
  toPct:     number;
  priority:  "HIGH" | "MEDIUM" | "LOW";
  rationale: string;
}

interface PortfolioData {
  regime:           string;
  regimeConfidence: number;
  allocations:      Allocation[];
  actions:          RebalancingAction[];
  compositeContext: {
    capitalRotationScore: number;
    riskPressureIndex:    number;
    marketHealthScore:    number;
  };
  portfolioInsight: string | null;
  preferredAssets:  string[] | null;
  avoidAssets:      string[] | null;
  keyRisks:         string[] | null;
  generatedBy:      "claude" | "computed";
  rebalancingAlert: boolean;
  alertMessage:     string;
  confidence:       number;
  timestamp:        string;
  indicators: {
    niftyRSI:       number;
    niftyMom:       number;
    goldMom:        number;
    yieldSpread:    number;
    vixProxy:       number;
    usdinrChgPct:   number;
    realYield:      number;
    goldNiftyRatio: number;
    macdHistogram:  number;
  };
}

interface AIAnalysis {
  allocations:      Allocation[];
  actions:          RebalancingAction[];
  portfolioInsight: string;
  preferredAssets:  string[];
  avoidAssets:      string[];
  keyRisks:         string[];
  generatedBy:      "claude";
  generatedAt:      string;
}

// ─── Fetcher ──────────────────────────────────────────────────────────────────
const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ─── Regime styles ────────────────────────────────────────────────────────────
const REGIME_STYLES: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  "Risk-On":      { bg: "bg-emerald-50",  border: "border-emerald-200", text: "text-emerald-800", dot: "bg-emerald-500" },
  "Risk-Off":     { bg: "bg-red-50",      border: "border-red-200",     text: "text-red-800",     dot: "bg-red-500" },
  "Neutral":      { bg: "bg-amber-50",    border: "border-amber-200",   text: "text-amber-800",   dot: "bg-amber-500" },
  "Transitioning":{ bg: "bg-blue-50",     border: "border-blue-200",    text: "text-blue-800",    dot: "bg-blue-500" },
};

function RegimeBadge({ regime }: { regime: string }) {
  const s = REGIME_STYLES[regime] ?? REGIME_STYLES["Neutral"];
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-full border px-4 py-1.5", s.bg, s.border)}>
      <span className={cn("h-2.5 w-2.5 animate-pulse rounded-full", s.dot)} />
      <span className={cn("text-sm font-bold uppercase tracking-wider", s.text)}>{regime}</span>
    </div>
  );
}

// ─── Priority / action styles ─────────────────────────────────────────────────
const PRIORITY_STYLES = {
  HIGH:   { badge: "border-red-200 bg-red-50 text-red-700",               icon: Zap,   label: "High" },
  MEDIUM: { badge: "border-amber-200 bg-amber-50 text-amber-700",         icon: Clock, label: "Medium" },
  LOW:    { badge: "border-[#DDD9D0] bg-[#F7F6F2] text-muted-foreground", icon: Info,  label: "Low" },
};

const ACTION_ICONS = {
  REDUCE:    TrendingDown,
  INCREASE:  TrendingUp,
  LIQUIDATE: ShieldAlert,
  INITIATE:  TrendingUp,
};

const ACTION_COLORS = {
  REDUCE:    "text-red-600 bg-red-50 border-red-200",
  INCREASE:  "text-emerald-600 bg-emerald-50 border-emerald-200",
  LIQUIDATE: "text-orange-600 bg-orange-50 border-orange-200",
  INITIATE:  "text-blue-600 bg-blue-50 border-blue-200",
};

// ─── Action card ──────────────────────────────────────────────────────────────
function ActionCard({ action, index }: { action: RebalancingAction; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const priorityStyle = PRIORITY_STYLES[action.priority];
  const Icon          = ACTION_ICONS[action.type] ?? TrendingUp;
  const colorClass    = ACTION_COLORS[action.type] ?? ACTION_COLORS.INCREASE;
  const diff          = action.toPct - action.fromPct;

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.35, delay: index * 0.07 }}
      className="rounded-xl border border-[#DDD9D0] bg-white overflow-hidden"
    >
      <div
        className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-[#F7F6F2]/60 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className={cn("flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border", colorClass)}>
          <Icon size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">
              {action.type === "REDUCE" ? "Reduce" : action.type === "INCREASE" ? "Increase" : action.type.charAt(0) + action.type.slice(1).toLowerCase()} {action.asset}
            </span>
            <span className="text-xs text-muted-foreground font-mono">
              {action.fromPct}% → {action.toPct}%
            </span>
            <span className={cn(
              "rounded-full border px-1.5 py-0.5 text-[10px] font-bold",
              diff > 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
            )}>
              {diff > 0 ? "+" : ""}{diff}%
            </span>
          </div>
        </div>
        <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold flex-shrink-0", priorityStyle.badge)}>
          <priorityStyle.icon size={9} className="inline mr-0.5" />
          {priorityStyle.label}
        </span>
        {expanded
          ? <ChevronUp size={14} className="text-muted-foreground flex-shrink-0" />
          : <ChevronDown size={14} className="text-muted-foreground flex-shrink-0" />
        }
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[#ECEAE4] bg-[#F7F6F2]/60 px-4 py-3">
              <p className="text-xs text-muted-foreground leading-relaxed">{action.rationale}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Confidence indicator ─────────────────────────────────────────────────────
function ConfidenceIndicator({ label, value, color, index }: {
  label: string; value: number; color: string; index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, delay: index * 0.08 }}
      className="flex-1 min-w-[140px] rounded-xl border border-[#DDD9D0] bg-white p-4"
    >
      <p className="mb-2 text-xs text-muted-foreground">{label}</p>
      <div className="mb-1.5">
        <span className="text-2xl font-bold" style={{ color }}>{value}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[#F0EDE6]">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.9, delay: index * 0.08 + 0.3, ease: "easeOut" }}
        />
      </div>
    </motion.div>
  );
}

// ─── Indicator pill ───────────────────────────────────────────────────────────
function IndicatorPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[#ECEAE4] bg-[#F7F6F2] px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-bold" style={{ color }}>{value}</span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function PortfolioPage() {
  const [showAllActions, setShowAllActions]   = useState(false);
  const [aiAnalysis, setAiAnalysis]           = useState<AIAnalysis | null>(null);
  const [aiLoading, setAiLoading]             = useState(false);
  const [aiError, setAiError]                 = useState<string | null>(null);

  // GET — live data + computed allocations, auto-refresh every 5 min (no Claude)
  const { data, error, isLoading, mutate } = useSWR<PortfolioData>(
    "/api/portfolio",
    fetcher,
    { refreshInterval: 5 * 60 * 1000 }
  );

  // POST — Claude AI analysis on button click only
  async function runAnalysis() {
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch("/api/portfolio", { method: "POST" });
      if (!res.ok) throw new Error("Claude analysis failed");
      const result: AIAnalysis = await res.json();
      setAiAnalysis(result);
    } catch {
      setAiError("AI analysis failed. Please try again.");
    } finally {
      setAiLoading(false);
    }
  }

  // Merge: prefer AI allocations/actions when available
  const allocations    = aiAnalysis?.allocations ?? data?.allocations ?? [];
  const actions        = aiAnalysis?.actions     ?? data?.actions     ?? [];
  const visibleActions = showAllActions ? actions : actions.slice(0, 4);
  const currentTotal   = allocations.reduce((s, a) => s + a.current, 0);
  const suggestedTotal = allocations.reduce((s, a) => s + a.suggested, 0);

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex flex-wrap items-center gap-3">
          {data
            ? <RegimeBadge regime={data.regime} />
            : <div className="h-8 w-36 animate-pulse rounded-full bg-gray-100" />
          }
          <span className="text-sm text-muted-foreground">
            Regime-based portfolio allocation
          </span>
          {aiAnalysis && (
            <span className="flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-semibold text-violet-700">
              <Brain size={10} />
              Claude Analysis Active
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Refresh live data */}
          <button
            onClick={() => mutate()}
            disabled={isLoading}
            className="flex items-center gap-1.5 rounded-lg border border-[#DDD9D0] bg-white px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-[#F0EDE6] hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw size={11} className={cn(isLoading && "animate-spin")} />
            Refresh Data
          </button>

          {/* Run Claude analysis */}
          <Button
            size="sm"
            onClick={runAnalysis}
            disabled={aiLoading || isLoading}
            className="gap-1.5 bg-[#1B3A5C] hover:bg-[#1B3A5C]/90 text-white"
          >
            {aiLoading
              ? <><RefreshCw size={12} className="animate-spin" /> Analysing…</>
              : <><Sparkles size={12} /> Run Analysis</>
            }
          </Button>
        </div>
      </motion.div>

      {/* ── Errors ─────────────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={15} />
          Failed to load portfolio data. Click Refresh Data to retry.
        </div>
      )}
      {aiError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={15} />
          {aiError}
        </div>
      )}

      {/* ── Loading skeleton ────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="space-y-4 animate-pulse">
          <div className="flex gap-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-20 flex-1 rounded-xl bg-gray-100" />)}
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-3">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-24 rounded-xl bg-gray-100" />)}
            </div>
            <div className="space-y-3">
              {[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-xl bg-gray-100" />)}
            </div>
          </div>
        </div>
      )}

      {data && (
        <>
          {/* ── Confidence indicators ──────────────────────────────────────── */}
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.1 }}>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Confidence Indicators
            </p>
            <div className="flex flex-wrap gap-4">
              <ConfidenceIndicator label="Regime Confidence"      value={Math.round(data.regimeConfidence * 100)}          color="#1B3A5C" index={0} />
              <ConfidenceIndicator label="Capital Rotation Score" value={data.compositeContext.capitalRotationScore}        color="#2D7D46" index={1} />
              <ConfidenceIndicator label="Market Health Score"    value={data.compositeContext.marketHealthScore}           color="#B45309" index={2} />
              <ConfidenceIndicator label="Risk Pressure Index"    value={data.compositeContext.riskPressureIndex}           color="#7C3AED" index={3} />
            </div>
          </motion.div>

          {/* ── Live indicators strip ──────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.15 }}
            className="grid grid-cols-2 sm:grid-cols-4 gap-2"
          >
            <IndicatorPill label="Nifty RSI (14)" value={`${data.indicators.niftyRSI}`}
              color={data.indicators.niftyRSI > 70 ? "#ef4444" : data.indicators.niftyRSI < 40 ? "#10b981" : "#f59e0b"} />
            <IndicatorPill label="Yield Spread"
              value={`${data.indicators.yieldSpread > 0 ? "+" : ""}${data.indicators.yieldSpread}%`}
              color={data.indicators.yieldSpread < 0 ? "#ef4444" : "#10b981"} />
            <IndicatorPill label="RVol (20D)" value={`${data.indicators.vixProxy}%`}
              color={data.indicators.vixProxy > 20 ? "#ef4444" : "#10b981"} />
            <IndicatorPill label="Real Yield"
              value={`${data.indicators.realYield > 0 ? "+" : ""}${data.indicators.realYield}%`}
              color={data.indicators.realYield > 0 ? "#f59e0b" : "#10b981"} />
          </motion.div>

          {/* ── AI Insight panel — shown only after Run Analysis ──────────── */}
          <AnimatePresence>
            {aiAnalysis && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.4 }}
                className="rounded-xl border border-violet-200 bg-violet-50 px-5 py-4"
              >
                <div className="flex items-start gap-3">
                  <Brain size={16} className="text-violet-600 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-bold uppercase tracking-wider text-violet-700">
                        AI Portfolio Insight — {data.regime} Regime
                      </p>
                      <span className="text-[10px] text-violet-500">
                        Generated {new Date(aiAnalysis.generatedAt).toLocaleTimeString("en-IN", {
                          timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit"
                        })} IST
                      </span>
                    </div>
                    <p className="text-sm text-violet-900 leading-relaxed">{aiAnalysis.portfolioInsight}</p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Prompt to run analysis — shown before first click */}
            {!aiAnalysis && !aiLoading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center justify-between rounded-xl border border-dashed border-[#C4BFB4] bg-[#F7F6F2] px-5 py-4"
              >
                <div className="flex items-center gap-3">
                  <Sparkles size={15} className="text-[#1B3A5C]" />
                  <div>
                    <p className="text-sm font-medium text-foreground">AI Analysis not run yet</p>
                    <p className="text-xs text-muted-foreground">Click <strong>Run Analysis</strong> to get Claude-powered rationale, key risks, and preferred/avoid assets based on live market data.</p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Loading state for AI */}
            {aiLoading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-3 rounded-xl border border-violet-200 bg-violet-50 px-5 py-4"
              >
                <RefreshCw size={15} className="text-violet-500 animate-spin" />
                <div>
                  <p className="text-sm font-medium text-violet-800">Claude is analysing your portfolio…</p>
                  <p className="text-xs text-violet-600">Fetching live market data and generating institutional-grade recommendations.</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Rebalancing alert ──────────────────────────────────────────── */}
          <AnimatePresence>
            {data.rebalancingAlert && (
              <motion.div
                initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3 }}
                className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4"
              >
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-600" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">Rebalancing Required</p>
                  <p className="mt-0.5 text-xs text-amber-700 leading-relaxed">{data.alertMessage}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {!data.rebalancingAlert && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3"
            >
              <CheckCircle2 size={15} className="text-emerald-600 flex-shrink-0" />
              <p className="text-xs text-emerald-800">{data.alertMessage}</p>
            </motion.div>
          )}

          {/* ── Main 2/3 + 1/3 grid ───────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Allocation bars */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Allocation Breakdown
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Current vs {aiAnalysis ? "AI-suggested" : "regime-computed"} allocation
                  </p>
                </div>
                <div className="flex items-center gap-3 text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-5 rounded-full bg-[#C4BFB4]" />
                    <span className="text-muted-foreground">Current</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-5 rounded-full bg-[#1B3A5C]" />
                    <span className="text-muted-foreground">Suggested</span>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {allocations.map((item, i) => (
                  <AllocationBar
                    key={item.symbol}
                    label={item.asset}
                    symbol={item.symbol}
                    currentPct={item.current}
                    suggestedPct={item.suggested}
                    assetClass={item.assetClass}
                    rationale={item.rationale}
                    index={i}
                  />
                ))}
              </div>

              <div className="flex gap-3">
                <div className="flex-1 rounded-lg border border-[#DDD9D0] bg-white px-3 py-2.5">
                  <p className="text-[10px] text-muted-foreground">Current Total</p>
                  <p className="text-lg font-bold text-foreground">{currentTotal}%</p>
                </div>
                <div className="flex-1 rounded-lg border border-[#1B3A5C]/30 bg-[#1B3A5C]/5 px-3 py-2.5">
                  <p className="text-[10px] text-muted-foreground">Suggested Total</p>
                  <p className="text-lg font-bold text-[#1B3A5C]">{suggestedTotal}%</p>
                </div>
              </div>
            </div>

            {/* Right panel */}
            <div className="space-y-4">
              {/* Actions */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Portfolio Actions
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {actions.length} action{actions.length !== 1 ? "s" : ""} required
                </p>
              </div>

              <div className="space-y-2">
                {visibleActions.map((action, i) => (
                  <ActionCard key={action.id} action={action} index={i} />
                ))}
              </div>

              {actions.length > 4 && (
                <button
                  onClick={() => setShowAllActions((v) => !v)}
                  className="w-full rounded-lg border border-[#DDD9D0] bg-white py-2 text-xs font-medium text-muted-foreground hover:bg-[#F0EDE6] hover:text-foreground transition-colors"
                >
                  {showAllActions ? "Show less" : `Show ${actions.length - 4} more actions`}
                </button>
              )}

              {/* Regime card — shows AI content if available, else static */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-1.5">
                    <ShieldCheck size={13} className="text-[#1B3A5C]" />
                    {data.regime} Regime
                  </CardTitle>
                  <CardDescription>
                    {Math.round(data.regimeConfidence * 100)}% model confidence
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {aiAnalysis ? (
                    <>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                          <Lightbulb size={9} className="inline mr-1" />Preferred
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {(aiAnalysis.preferredAssets ?? []).map((item) => (
                            <span key={item} className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                              {item}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                          <AlertTriangle size={9} className="inline mr-1" />Avoid
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {(aiAnalysis.avoidAssets ?? []).map((item) => (
                            <span key={item} className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700">
                              {item}
                            </span>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Run AI Analysis to get preferred assets, sectors to avoid, and regime-specific guidance.
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Key risks — shown only after AI analysis */}
              {aiAnalysis && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-1.5">
                      <Activity size={13} className="text-red-500" />
                      Key Risks to Monitor
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {(aiAnalysis.keyRisks ?? []).map((risk, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-400" />
                        <p className="text-xs text-muted-foreground leading-relaxed">{risk}</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Live indicators */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Activity size={13} className="text-[#1B3A5C]" />
                      Live Indicators
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  <div className="grid grid-cols-2 gap-1.5">
                    <IndicatorPill label="Nifty 20D"
                      value={`${data.indicators.niftyMom > 0 ? "+" : ""}${data.indicators.niftyMom}%`}
                      color={data.indicators.niftyMom > 0 ? "#10b981" : "#ef4444"} />
                    <IndicatorPill label="Gold 20D"
                      value={`${data.indicators.goldMom > 0 ? "+" : ""}${data.indicators.goldMom}%`}
                      color={data.indicators.goldMom > 0 ? "#10b981" : "#ef4444"} />
                    <IndicatorPill label="MACD Hist"
                      value={`${data.indicators.macdHistogram > 0 ? "+" : ""}${data.indicators.macdHistogram}`}
                      color={data.indicators.macdHistogram > 0 ? "#10b981" : "#ef4444"} />
                    <IndicatorPill label="Gold/Nifty"
                      value={`${data.indicators.goldNiftyRatio}`}
                      color={data.indicators.goldNiftyRatio > 4 ? "#ef4444" : "#6b7280"} />
                  </div>
                  <div className="flex items-center gap-2 pt-2 border-t border-[#ECEAE4]">
                    <CheckCircle2 size={11} className="text-emerald-500 flex-shrink-0" />
                    <p className="text-[10px] text-muted-foreground">
                      Live NeonDB · {new Date(data.timestamp).toLocaleTimeString("en-IN", {
                        timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit",
                      })} IST
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
