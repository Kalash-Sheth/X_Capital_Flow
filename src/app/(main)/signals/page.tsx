"use client";

import { useState, useRef, useCallback, useEffect, useMemo, Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import useSWR from "swr";
import {
  ArrowLeft, RefreshCw, AlertCircle, TrendingUp, Activity, Zap, BarChart2, Layers,
  ArrowUpRight, ArrowDownRight, Minus, ChevronRight, ChevronDown,
  Database, X, CheckCircle2, Clock, Eye, EyeOff,
} from "lucide-react";
import type {
  SignalsV2Response, AssetClassData, AssetData, Indicator,
  IndicatorCategory, Verdict,
} from "@/app/api/signals/v2/route";
import type { ChartData } from "@/app/api/chart/[ticker]/route";
import type { ChartOverlays } from "@/components/signals/TradingChart";

const TradingChart = lazy(() => import("@/components/signals/TradingChart"));

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ─── Design tokens ─────────────────────────────────────────────────────────────

const SIG: Record<string, { hex: string; hex2: string }> = {
  "Strong Bullish": { hex: "#059669", hex2: "#10b981" },
  "Bullish":        { hex: "#10b981", hex2: "#34d399" },
  "Neutral":        { hex: "#d97706", hex2: "#f59e0b" },
  "Bearish":        { hex: "#ef4444", hex2: "#f87171" },
  "Strong Bearish": { hex: "#dc2626", hex2: "#ef4444" },
};

const VERDICT: Record<Verdict, { dot: string; bg: string; text: string }> = {
  Bullish:    { dot: "#10b981", bg: "#f0fdf4", text: "#065f46" },
  Oversold:   { dot: "#34d399", bg: "#dcfce7", text: "#166534" },
  Neutral:    { dot: "#f59e0b", bg: "#fffbeb", text: "#92400e" },
  Overbought: { dot: "#f87171", bg: "#fff1f2", text: "#9f1239" },
  Bearish:    { dot: "#ef4444", bg: "#fef2f2", text: "#991b1b" },
};

const CAT: Record<IndicatorCategory, { icon: React.ElementType; hex: string; bg: string }> = {
  Trend:      { icon: TrendingUp, hex: "#6366f1", bg: "#eef2ff" },
  Momentum:   { icon: Zap,        hex: "#f59e0b", bg: "#fffbeb" },
  Flow:       { icon: Activity,   hex: "#10b981", bg: "#f0fdf4" },
  Volatility: { icon: BarChart2,  hex: "#ef4444", bg: "#fef2f2" },
  Structure:  { icon: Layers,     hex: "#8b5cf6", bg: "#f5f3ff" },
};

const CATS: IndicatorCategory[] = ["Trend", "Momentum", "Flow", "Volatility", "Structure"];

const TYPE_HEX: Record<string, string> = {
  CORE: "#6366f1", DERIVATIVE: "#8b5cf6", MACRO: "#0ea5e9",
  DEFENSIVE: "#10b981", HIGH_BETA: "#f59e0b", DEFAULT: "#94a3b8",
};

const ACTION_CFG = {
  "CONSIDER ENTRY":   { hex: "#10b981", glow: "rgba(16,185,129,0.14)",  border: "rgba(16,185,129,0.28)",  icon: "↗", label: "CONSIDER ENTRY"   },
  "WAIT & WATCH":     { hex: "#f59e0b", glow: "rgba(245,158,11,0.14)",  border: "rgba(245,158,11,0.28)",  icon: "◎", label: "WAIT & WATCH"     },
  "AVOID / STAY OUT": { hex: "#ef4444", glow: "rgba(239,68,68,0.14)",   border: "rgba(239,68,68,0.28)",   icon: "✕", label: "AVOID / STAY OUT" },
} as const;

// ─── Helpers ───────────────────────────────────────────────────────────────────

const fv = (v: number) =>
  Math.abs(v) < 0.01 ? v.toFixed(4) : Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2);

const scoreColor = (s: number) =>
  s >= 65 ? "#059669" : s >= 55 ? "#10b981" : s >= 45 ? "#d97706" : s >= 35 ? "#ef4444" : "#dc2626";

const sig = (s: string) => SIG[s] ?? SIG["Neutral"];

const fmtNum = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 0 });

// ─── Decision engine ───────────────────────────────────────────────────────────

function computeDecision(asset: AssetData, chart?: ChartData) {
  const { composite, signal, confidence } = asset.score;
  const inds  = asset.indicators;
  const close = asset.close;

  const isBull = signal === "Bullish" || signal === "Strong Bullish";
  const isBear = signal === "Bearish" || signal === "Strong Bearish";

  let action: keyof typeof ACTION_CFG;
  if (isBull && composite >= 58)              action = "CONSIDER ENTRY";
  else if (isBear || composite <= 38)         action = "AVOID / STAY OUT";
  else                                        action = "WAIT & WATCH";

  // ATR estimation
  const candles = chart?.candles ?? [];
  let atr = close * 0.015;
  if (candles.length >= 15) {
    const sl  = candles.slice(-14);
    const trs = sl.slice(1).map((b, i) => {
      const p = sl[i];
      return Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    });
    atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  }

  const stopLoss   = close - 2 * atr;
  const target1    = close + 2 * atr;
  const target2    = close + 4 * atr;
  const riskReward = ((target1 - close) / Math.max(close - stopLoss, 0.01)).toFixed(2);
  const bias       = isBull ? "Long" : isBear ? "Short" : "Neutral";

  // Smart reason generation
  const reasons: string[] = [];

  for (const cat of CATS) {
    if (reasons.length >= 3) break;
    const ci   = inds.filter((i) => i.category === cat);
    if (!ci.length) continue;
    const bull = ci.filter((i) => i.verdict === "Bullish" || i.verdict === "Oversold").length;
    const bear = ci.filter((i) => i.verdict === "Bearish" || i.verdict === "Overbought").length;
    const pct  = bull / ci.length;

    if (cat === "Trend") {
      if (pct >= 0.65) reasons.push(`${bull}/${ci.length} trend signals bullish — directional bias confirmed`);
      else if (pct <= 0.35) reasons.push(`${bear}/${ci.length} trend indicators bearish — downtrend pressure active`);
    }
    if (cat === "Momentum") {
      const rsiInd = inds.find((i) => i.name.includes("RSI"));
      if (rsiInd?.verdict === "Oversold")    reasons.push(`RSI oversold at ${rsiInd.value.toFixed(1)} — mean reversion potential building`);
      else if (rsiInd?.verdict === "Overbought") reasons.push(`RSI overbought at ${rsiInd.value.toFixed(1)} — pullback risk elevated`);
      else if (pct >= 0.6)  reasons.push("Momentum indicators aligned bullish — positive divergence forming");
      else if (pct <= 0.35) reasons.push("Momentum fading — MACD and RSI showing weakness");
    }
    if (cat === "Flow") {
      if (bull > bear) reasons.push("Net institutional flow positive — accumulation pressure evident");
      else if (bear > bull) reasons.push("Distribution detected — smart money outflow tilts negative");
    }
    if (cat === "Structure" && reasons.length < 3) {
      if (bull >= 2)  reasons.push("Structure intact — higher highs/lows supporting bullish bias");
      else if (bear >= 2) reasons.push("Structure breakdown — lower lows signal distribution phase");
    }
  }

  if (chart?.structureMarkers?.length && reasons.length < 4) {
    const last    = chart.structureMarkers.at(-1)!;
    const evLabel = last.event.startsWith("BOS") ? "BOS" : "CHoCH";
    const dir     = last.direction === "bull" ? "bullish" : "bearish";
    reasons.push(`Last structure: ${evLabel} ${dir} — market bias shift confirmed on chart`);
  }
  if (!reasons.length) reasons.push("Mixed signals — no strong directional consensus detected");

  return { action, stopLoss, target1, target2, riskReward, bias, reasons, confidence };
}

// ─── Arc score ring ────────────────────────────────────────────────────────────

function Arc({
  value, size = 52, color, track = "#f1f5f9",
}: { value: number; size?: number; color: string; track?: string }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={4} />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={4}
          strokeLinecap="round" strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - value / 100) }}
          transition={{ duration: 1.2, ease: "easeOut" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="font-black tabular-nums leading-none" style={{ fontSize: size * 0.24, color }}>
          {value}
        </span>
      </div>
    </div>
  );
}

// ─── Signal pill ───────────────────────────────────────────────────────────────

function Pill({ signal, size = "sm" }: { signal: string; size?: "xs" | "sm" | "md" }) {
  const s  = sig(signal);
  const sz = size === "xs" ? "text-[9px] px-1.5 py-0.5" : size === "sm" ? "text-[10px] px-2 py-0.5" : "text-xs px-2.5 py-1";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-bold ${sz}`}
      style={{ background: `${s.hex}14`, color: s.hex, border: `1px solid ${s.hex}30` }}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: s.hex }} />
      {signal}
    </span>
  );
}

// ─── Verdict dot ───────────────────────────────────────────────────────────────

function VDot({ verdict }: { verdict: Verdict }) {
  return <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ background: VERDICT[verdict].dot }} />;
}

// ─── Class card (Level 0) ──────────────────────────────────────────────────────

function ClassCard({ cls, idx, onClick }: { cls: AssetClassData; idx: number; onClick: () => void }) {
  const s       = sig(cls.aggregate.signal);
  const active  = cls.assets?.filter((a) => a.hasData).length ?? 0;
  const total   = cls.aggregate.bullCount + cls.aggregate.neutralCount + cls.aggregate.bearCount;
  const bullPct = total > 0 ? (cls.aggregate.bullCount / total) * 100 : 50;

  return (
    <motion.button
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0, transition: { delay: idx * 0.06, duration: 0.45, ease: [0.22, 1, 0.36, 1] } }}
      onClick={onClick}
      className="w-full text-left bg-white rounded-2xl border border-slate-100 hover:border-slate-200 hover:shadow-lg transition-all duration-200 overflow-hidden group"
    >
      <div className="h-[2px]" style={{ background: `linear-gradient(90deg, ${s.hex}, ${s.hex2})` }} />
      <div className="p-4 sm:p-6">
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{cls.icon}</span>
            <div>
              <h3 className="text-sm font-bold text-slate-800">{cls.name}</h3>
              <p className="text-xs text-slate-400 mt-0.5">{active} indices tracked</p>
            </div>
          </div>
          <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-500 transition-colors mt-0.5" />
        </div>
        <div className="flex items-center gap-5 mb-5">
          <Arc value={cls.aggregate.composite} size={56} color={s.hex} />
          <div className="space-y-1.5">
            <Pill signal={cls.aggregate.signal} />
            <div className="flex items-center gap-1.5 text-[11px] font-semibold"
              style={{ color: cls.aggregate.flowDirection === "Inflow" ? "#10b981" : cls.aggregate.flowDirection === "Outflow" ? "#ef4444" : "#d97706" }}>
              {cls.aggregate.flowDirection === "Inflow"  && <ArrowUpRight   size={11} />}
              {cls.aggregate.flowDirection === "Outflow" && <ArrowDownRight  size={11} />}
              {cls.aggregate.flowDirection === "Neutral" && <Minus          size={11} />}
              {cls.aggregate.flowDirection}
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
            <motion.div className="h-full rounded-full bg-emerald-400"
              initial={{ width: 0 }} animate={{ width: `${bullPct}%` }}
              transition={{ duration: 0.9, ease: "easeOut", delay: idx * 0.07 }} />
          </div>
          <div className="flex justify-between text-[10px] text-slate-400">
            <span className="font-bold text-emerald-600">{cls.aggregate.bullCount} bull</span>
            <span>{cls.aggregate.neutralCount} neutral</span>
            <span className="font-bold text-red-500">{cls.aggregate.bearCount} bear</span>
          </div>
        </div>
        {active > 1 && (
          <div className="mt-3 pt-3 border-t border-slate-50 flex justify-between text-[10px] text-slate-400">
            <span>↑ {cls.aggregate.topAsset}</span>
            <span>↓ {cls.aggregate.bottomAsset}</span>
          </div>
        )}
      </div>
    </motion.button>
  );
}

// ─── Asset row (Level 1) ───────────────────────────────────────────────────────

function AssetRow({ asset, idx, onClick }: { asset: AssetData; idx: number; onClick: () => void }) {
  const s  = sig(asset.score.signal);
  const tt = TYPE_HEX[asset.score.tickerType ?? "DEFAULT"] ?? "#94a3b8";

  return (
    <motion.button
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0, transition: { delay: idx * 0.04, duration: 0.32 } }}
      onClick={onClick}
      disabled={!asset.hasData}
      className={`w-full text-left flex items-center gap-3 sm:gap-4 px-3 sm:px-5 py-3 sm:py-4 rounded-xl border transition-all group ${
        asset.hasData
          ? "bg-white border-slate-100 hover:border-slate-200 hover:shadow-md cursor-pointer"
          : "bg-slate-50 border-slate-100 opacity-40 cursor-not-allowed"
      }`}
    >
      <Arc value={asset.hasData ? asset.score.composite : 50} size={44} color={s.hex} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-bold text-slate-800 truncate">{asset.name}</span>
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{ color: tt, background: `${tt}12`, border: `1px solid ${tt}25` }}>
            {asset.score.tickerType ?? "INDEX"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-slate-500 font-medium tabular-nums">
            {asset.close > 0 ? fmtNum(asset.close) : "—"}
          </span>
          {asset.hasData && (
            <span className={`text-[11px] font-bold ${asset.change1d >= 0 ? "text-emerald-600" : "text-red-500"}`}>
              {asset.change1d >= 0 ? "+" : ""}{asset.change1d.toFixed(2)}%
            </span>
          )}
        </div>
      </div>
      {asset.hasData && (
        <div className="hidden sm:flex items-center gap-3">
          {CATS.map((cat) => {
            const ci = asset.indicators.filter((i) => i.category === cat);
            const b  = ci.filter((i) => i.verdict === "Bullish" || i.verdict === "Oversold").length;
            const br = ci.filter((i) => i.verdict === "Bearish" || i.verdict === "Overbought").length;
            const v: Verdict = b > br ? "Bullish" : br > b ? "Bearish" : "Neutral";
            return (
              <div key={cat} className="flex flex-col items-center gap-1">
                <VDot verdict={v} />
                <span className="text-[8px] text-slate-400">{cat.slice(0, 3)}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
        <Pill signal={asset.score.signal} size="xs" />
        {asset.hasData && (
          <span className={`text-[9px] font-bold ${
            asset.score.riskLevel === "Low" ? "text-emerald-600" : asset.score.riskLevel === "High" ? "text-red-600" : "text-amber-600"
          }`}>{asset.score.riskLevel} Risk</span>
        )}
      </div>
      <ChevronRight size={13} className="text-slate-300 group-hover:text-slate-500 transition-colors flex-shrink-0" />
    </motion.button>
  );
}

// ─── Indicator card ────────────────────────────────────────────────────────────

function IndicatorCard({ ind }: { ind: Indicator }) {
  const [open, setOpen] = useState(false);
  const cat   = CAT[ind.category];
  const Icon  = cat.icon;
  const v     = VERDICT[ind.verdict];
  const sp    = ind.strength === "Strong" ? 3 : ind.strength === "Moderate" ? 2 : 1;
  const w     = ind.weight ?? 1;
  const wTier = w >= 3 ? "#dc2626" : w >= 2 ? "#f59e0b" : w >= 1.5 ? "#6366f1" : "#94a3b8";

  return (
    <div
      onClick={() => setOpen(!open)}
      className="rounded-xl border border-slate-100 bg-white overflow-hidden cursor-pointer transition-all duration-150"
      style={open ? { boxShadow: `0 0 0 1.5px ${cat.hex}35`, borderColor: `${cat.hex}35` } : {}}
    >
      <div className="flex items-center gap-3 px-3.5 py-3">
        <div className="w-[3px] h-10 rounded-full flex-shrink-0" style={{ background: cat.hex }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <Icon size={9} style={{ color: cat.hex }} className="flex-shrink-0" />
              <span className="text-[11px] font-semibold text-slate-700 truncate">{ind.name}</span>
              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: wTier }} title={`Weight: ${w}`} />
            </div>
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-md flex-shrink-0"
              style={{ background: v.bg, color: v.text }}>
              {ind.verdict}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-0.5">
              {[1, 2, 3].map((p) => (
                <div key={p} className="h-[3px] w-4 rounded-full"
                  style={{ background: p <= sp ? cat.hex : `${cat.hex}20` }} />
              ))}
            </div>
            <span className="text-[10px] font-black tabular-nums font-mono" style={{ color: cat.hex }}>
              {fv(ind.value)}
            </span>
          </div>
        </div>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16 }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 pt-1 border-t" style={{ borderColor: `${cat.hex}15` }}>
              <p className="text-[10px] text-slate-500 leading-relaxed">{ind.description}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Decision Engine ───────────────────────────────────────────────────────────

function DecisionEngine({ asset, chart }: { asset: AssetData; chart?: ChartData }) {
  const dec = computeDecision(asset, chart);
  const cfg = ACTION_CFG[dec.action];

  const tradeGrid = [
    { label: "Stop Loss",     value: fmtNum(dec.stopLoss),  note: "2× ATR below entry", color: "#ef4444", icon: "↓" },
    { label: "Target 1",      value: fmtNum(dec.target1),   note: "2× ATR above entry", color: "#10b981", icon: "↑" },
    { label: "Target 2",      value: fmtNum(dec.target2),   note: "4× ATR above entry", color: "#059669", icon: "↑↑" },
    { label: "Risk / Reward", value: `1 : ${dec.riskReward}`, note: "T1-based ratio",   color: cfg.hex,   icon: "⚖" },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-2xl bg-white"
      style={{ border: `1.5px solid ${cfg.border}`, boxShadow: `0 0 0 1px ${cfg.border}, 0 8px 32px ${cfg.glow}` }}
    >
      {/* Ambient glow */}
      <div className="absolute top-0 left-0 right-0 h-28 pointer-events-none"
        style={{ background: `radial-gradient(ellipse at 50% -10%, ${cfg.glow} 0%, transparent 70%)` }} />

      {/* Header */}
      <div className="relative px-5 pt-5 pb-4" style={{ borderBottom: `1px solid ${cfg.hex}18` }}>
        <p className="text-[9px] font-black tracking-[0.15em] uppercase text-slate-400 mb-3">
          Decision Engine
        </p>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-base font-black flex-shrink-0"
              style={{ background: `${cfg.hex}18`, color: cfg.hex, boxShadow: `0 0 0 1px ${cfg.hex}25` }}>
              {cfg.icon}
            </div>
            <div>
              <span className="text-[15px] font-black tracking-tight leading-tight block" style={{ color: cfg.hex }}>
                {dec.action}
              </span>
              <span className="text-[10px] text-slate-400 font-medium">{dec.bias} bias · Daily TF</span>
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-[9px] text-slate-400 font-medium mb-0.5">Confidence</p>
            <p className="text-2xl font-black tabular-nums" style={{ color: cfg.hex }}>
              {dec.confidence}%
            </p>
          </div>
        </div>

        {/* Confidence bar */}
        <div className="mt-4 h-[5px] rounded-full overflow-hidden bg-slate-100">
          <motion.div
            className="h-full rounded-full"
            style={{ background: `linear-gradient(90deg, ${cfg.hex}70, ${cfg.hex})` }}
            initial={{ width: 0 }}
            animate={{ width: `${dec.confidence}%` }}
            transition={{ duration: 1.1, ease: "easeOut", delay: 0.2 }}
          />
        </div>
        <div className="flex justify-between mt-1.5">
          <span className="text-[9px] text-slate-400">0%</span>
          <span className="text-[9px] text-slate-400">100%</span>
        </div>
      </div>

      {/* Reason bullets */}
      <div className="relative px-5 py-4 space-y-3" style={{ borderBottom: `1px solid ${cfg.hex}14` }}>
        <p className="text-[9px] font-black tracking-[0.12em] uppercase text-slate-400 mb-2.5">Signal Rationale</p>
        {dec.reasons.map((r, i) => (
          <div key={i} className="flex gap-2.5 items-start">
            <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-[1px]"
              style={{ background: `${cfg.hex}15` }}>
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: cfg.hex }} />
            </div>
            <p className="text-[11px] text-slate-600 leading-snug">{r}</p>
          </div>
        ))}
      </div>

      {/* 2×2 trade grid */}
      <div className="grid grid-cols-2 divide-x divide-y divide-slate-100/80">
        {tradeGrid.map(({ label, value, note, color, icon }) => (
          <div key={label} className="px-4 py-3.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
              <span className="text-sm font-black" style={{ color }}>{icon}</span>
            </div>
            <p className="text-[15px] font-black tabular-nums tracking-tight" style={{ color }}>{value}</p>
            <p className="text-[9px] text-slate-400 mt-0.5">{note}</p>
          </div>
        ))}
      </div>

      {/* Meta strip */}
      <div className="px-5 py-2.5 flex items-center gap-4 flex-wrap bg-slate-50/80 border-t border-slate-100">
        {[
          { k: "Risk",       v: asset.score.riskLevel },
          { k: "Indicators", v: `${asset.indicators.length}` },
          { k: "Timeframe",  v: "Daily" },
          { k: "Bias",       v: dec.bias },
        ].map(({ k, v }) => (
          <div key={k} className="flex items-center gap-1.5">
            <span className="text-[9px] text-slate-400">{k}:</span>
            <span className="text-[9px] font-bold text-slate-700">{v}</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ─── Asset Dashboard (Level 2) ─────────────────────────────────────────────────

function AssetDashboard({ asset, cls, allAssets }: {
  asset: AssetData; cls: AssetClassData; allAssets: AssetData[];
}) {
  const { data: chart, isLoading: chartLoading } = useSWR<ChartData>(
    `/api/chart/${asset.ticker}`, fetcher, { revalidateOnFocus: false }
  );

  const [chartType,   setChartType]   = useState<"candle" | "ha">("candle");
  const [overlays,    setOverlays]    = useState<ChartOverlays>({
    vwap: true, aVwap: true, ma50: true, ma200: true, bb: false, ob: true, vp: true, opt: true,
  });
  const [activeCat,   setActiveCat]   = useState<IndicatorCategory | "All">("All");
  const [showRanking, setShowRanking] = useState(false);
  const [chartH,      setChartH]      = useState(480);
  useEffect(() => { setChartH(window.innerWidth < 640 ? 300 : 480); }, []);

  const toggle = useCallback((k: keyof ChartOverlays) =>
    setOverlays((p) => ({ ...p, [k]: !p[k] })), []);

  const s    = sig(asset.score.signal);
  const wts  = asset.score.weights;
  const tt   = TYPE_HEX[asset.score.tickerType ?? "DEFAULT"] ?? "#94a3b8";

  const filtered = (activeCat === "All"
    ? asset.indicators
    : asset.indicators.filter((i) => i.category === activeCat)
  ).sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));

  const bullCount = asset.indicators.filter((i) => i.verdict === "Bullish" || i.verdict === "Oversold").length;
  const bearCount = asset.indicators.filter((i) => i.verdict === "Bearish" || i.verdict === "Overbought").length;

  const OVS: Array<{ key: keyof ChartOverlays; label: string; hex: string }> = [
    { key: "vwap",  label: "VWAP",  hex: "#10b981" },
    { key: "aVwap", label: "aVWAP", hex: "#0ea5e9" },
    { key: "ma50",  label: "MA50",  hex: "#6366f1" },
    { key: "ma200", label: "MA200", hex: "#f59e0b" },
    { key: "bb",    label: "BB",    hex: "#94a3b8" },
    { key: "ob",    label: "OB",    hex: "#10b981" },
    { key: "vp",    label: "VP",    hex: "#dc2626" },
    { key: "opt",   label: "Opt",   hex: "#8b5cf6" },
  ];

  const catScore = (cat: IndicatorCategory) =>
    cat === "Trend" ? asset.score.trend : cat === "Momentum" ? asset.score.momentum
    : cat === "Flow" ? asset.score.flow : cat === "Volatility" ? asset.score.volatility
    : asset.score.structure;

  return (
    <div className="space-y-5">

      {/* ── Dark glass hero ──────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } }}
        className="relative overflow-hidden rounded-2xl"
        style={{ background: "linear-gradient(135deg, #0d1525 0%, #172035 45%, #0d1525 100%)" }}
      >
        {/* Dot mesh */}
        <div className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.035) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }} />
        {/* Signal gradient line */}
        <div className="h-[1.5px]"
          style={{ background: `linear-gradient(90deg, transparent 5%, ${s.hex} 35%, ${s.hex2} 65%, transparent 95%)` }} />

        <div className="relative px-4 sm:px-7 py-4 sm:py-6">
          <div className="flex items-start justify-between gap-4 sm:gap-8 flex-wrap">

            {/* Identity + price */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4 flex-wrap">
                <span className="text-2xl">{cls.icon}</span>
                <h2 className="text-base sm:text-xl font-black text-white tracking-tight">{asset.name}</h2>
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full"
                  style={{ background: `${s.hex}20`, color: s.hex, border: `1px solid ${s.hex}35` }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.hex }} />
                  {asset.score.signal}
                </span>
                <span className="text-[9px] font-bold px-2 py-0.5 rounded-full"
                  style={{ color: tt, background: `${tt}20`, border: `1px solid ${tt}30` }}>
                  {asset.score.tickerType ?? "INDEX"}
                </span>
              </div>

              <div className="flex items-baseline gap-3 sm:gap-4 mb-4 sm:mb-5">
                <span className="text-[28px] sm:text-[40px] font-black text-white tabular-nums tracking-tight leading-none">
                  {asset.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                </span>
                <span className={`text-base sm:text-lg font-black tabular-nums ${asset.change1d >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {asset.change1d >= 0 ? "+" : ""}{asset.change1d.toFixed(2)}%
                </span>
              </div>

              <div className="flex items-center gap-6">
                {[{ label: "5 Day", val: asset.change5d }, { label: "20 Day", val: asset.change20d }].map(({ label, val }) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <span className={`text-sm font-bold tabular-nums ${val >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {val >= 0 ? "+" : ""}{val.toFixed(2)}%
                    </span>
                    <span className="text-[9px] text-slate-500 font-medium">{label}</span>
                  </div>
                ))}
                {asset.volume > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-bold text-slate-300 tabular-nums">
                      {asset.volume >= 1e9
                        ? `${(asset.volume / 1e9).toFixed(1)}B`
                        : `${(asset.volume / 1e6).toFixed(1)}M`}
                    </span>
                    <span className="text-[9px] text-slate-500 font-medium">Volume</span>
                  </div>
                )}
              </div>
            </div>

            {/* Score + indicator stats */}
            <div className="flex items-center gap-4 sm:gap-7 flex-shrink-0">
              <div className="flex flex-col items-center gap-2">
                <Arc value={asset.score.composite} size={72} color={s.hex} track="rgba(255,255,255,0.07)" />
                <span className="text-[9px] font-black text-slate-500 uppercase tracking-[0.15em]">Score</span>
              </div>
              <div className="border-l border-white/10 pl-4 sm:pl-7 space-y-2.5">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[26px] font-black text-emerald-400 tabular-nums leading-none">{bullCount}</span>
                  <span className="text-[11px] text-slate-500">bullish</span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[26px] font-black text-red-400 tabular-nums leading-none">{bearCount}</span>
                  <span className="text-[11px] text-slate-500">bearish</span>
                </div>
                <div className="flex items-center gap-2 pt-1 border-t border-white/[0.06]">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    asset.score.riskLevel === "Low" ? "bg-emerald-400"
                    : asset.score.riskLevel === "High" ? "bg-red-400" : "bg-amber-400"
                  }`} />
                  <span className="text-[11px] text-slate-400">
                    {asset.score.riskLevel} Risk · {asset.score.confidence}% conf
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Category chips row */}
          <div className="mt-6 pt-5 border-t border-white/[0.06] flex items-center gap-2 flex-wrap">
            {CATS.map((cat) => {
              const score = catScore(cat);
              const hex   = scoreColor(score);
              const Icon  = CAT[cat].icon;
              const wt    = wts ? Math.round((wts[cat] ?? 0) * 100) : null;
              return (
                <div key={cat}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full"
                  style={{ background: "rgba(255,255,255,0.055)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <Icon size={10} style={{ color: hex }} />
                  <span className="text-[10px] text-slate-400 font-semibold">{cat}</span>
                  <span className="text-[11px] font-black tabular-nums" style={{ color: hex }}>{score}</span>
                  {wt && <span className="text-[8px] text-slate-600 ml-0.5">{wt}%</span>}
                </div>
              );
            })}
          </div>
        </div>
      </motion.div>

      {/* ── 2-col layout ──────────────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row gap-4 sm:gap-5 items-start">

        {/* LEFT: chart + peer ranking */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* Chart controls */}
          <div className="bg-white rounded-xl border border-slate-100 px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-3 flex-wrap shadow-sm">
            {/* Type toggle */}
            <div className="flex items-center gap-0.5 bg-slate-50 rounded-lg p-0.5">
              {(["candle", "ha"] as const).map((t) => (
                <button key={t} onClick={() => setChartType(t)}
                  className={`text-[10px] font-bold px-3 py-1.5 rounded-md transition-all ${
                    chartType === t
                      ? "bg-white text-slate-800 shadow-sm"
                      : "text-slate-400 hover:text-slate-600"
                  }`}>
                  {t === "candle" ? "Candles" : "Heikin Ashi"}
                </button>
              ))}
            </div>

            <div className="w-px h-4 bg-slate-100" />

            {/* Overlay toggles */}
            <div className="flex items-center gap-1 flex-wrap">
              {OVS.map(({ key, label, hex }) => (
                <button key={key} onClick={() => toggle(key)}
                  className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg border transition-all"
                  style={overlays[key]
                    ? { color: hex, background: `${hex}12`, borderColor: `${hex}40` }
                    : { color: "#cbd5e1", background: "#f8fafc", borderColor: "#e2e8f0" }}>
                  {overlays[key] ? <Eye size={8} /> : <EyeOff size={8} />}
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Chart card */}
          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden shadow-sm">
            {/* Chart header */}
            <div className="px-5 py-3.5 border-b border-slate-50 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <span className="text-sm font-bold text-slate-800">{asset.name}</span>
                <span className="inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full"
                  style={{ background: `${s.hex}12`, color: s.hex, border: `1px solid ${s.hex}28` }}>
                  <span className="w-1 h-1 rounded-full" style={{ background: s.hex }} />
                  {asset.score.signal}
                </span>
              </div>
              {chart && (
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                    <div className="w-3 h-px bg-red-500" />
                    <span>POC {fmtNum(chart.volumeProfile.poc)}</span>
                  </div>
                  {chart.optionLevels.maxPain && (
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                      <div className="w-3 h-px border-t-2 border-dashed border-purple-400" style={{ height: 0 }} />
                      <span>MP {fmtNum(chart.optionLevels.maxPain)}</span>
                    </div>
                  )}
                  {chart.structureMarkers.slice(-2).map((m, i) => (
                    <span key={i} className="text-[9px] font-black px-2 py-0.5 rounded-md"
                      style={{
                        color: m.direction === "bull" ? "#059669" : "#dc2626",
                        background: m.direction === "bull" ? "#f0fdf4" : "#fef2f2",
                      }}>
                      {m.event.replace("_B", "↑").replace("_S", "↓")}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Chart body */}
            <div style={{ minHeight: chartH }}>
              {chartLoading && (
                <div className="flex items-center justify-center" style={{ height: chartH }}>
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-slate-100 border-t-indigo-500 rounded-full animate-spin" />
                    <span className="text-xs text-slate-400 font-medium">Loading chart…</span>
                  </div>
                </div>
              )}
              {!chartLoading && !chart && (
                <div className="flex items-center justify-center" style={{ height: chartH }}>
                  <div className="text-center">
                    <BarChart2 size={40} className="text-slate-100 mx-auto mb-3" />
                    <p className="text-sm text-slate-400">No chart data available</p>
                  </div>
                </div>
              )}
              {chart && !chartLoading && (
                <Suspense fallback={
                  <div className="flex items-center justify-center" style={{ height: chartH }}>
                    <div className="w-7 h-7 border-2 border-slate-100 border-t-indigo-500 rounded-full animate-spin" />
                  </div>
                }>
                  <TradingChart data={chart} overlays={overlays} chartType={chartType} height={chartH} />
                </Suspense>
              )}
            </div>
          </div>

          {/* Peer ranking */}
          <div className="bg-white rounded-xl border border-slate-100 overflow-hidden shadow-sm">
            <button onClick={() => setShowRanking(!showRanking)}
              className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors text-left">
              <span className="text-[11px] font-black text-slate-500 uppercase tracking-[0.1em]">
                Peer Ranking — {cls.name}
              </span>
              <ChevronDown size={13} className={`text-slate-400 transition-transform duration-200 ${showRanking ? "rotate-180" : ""}`} />
            </button>
            <AnimatePresence>
              {showRanking && (
                <motion.div
                  initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }}
                  className="overflow-hidden border-t border-slate-50"
                >
                  <div className="p-4 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
                    {[...allAssets].filter((a) => a.hasData)
                      .sort((a, b) => b.score.composite - a.score.composite)
                      .map((a, rank) => {
                        const as    = sig(a.score.signal);
                        const isCur = a.ticker === asset.ticker;
                        return (
                          <div key={a.ticker}
                            className={`px-3 py-2.5 rounded-xl border transition-all ${
                              isCur
                                ? "border-indigo-200 bg-indigo-50"
                                : "border-slate-100 bg-slate-50 hover:border-slate-200"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[9px] text-slate-400 font-bold">#{rank + 1}</span>
                              <span className="text-[11px] font-black tabular-nums" style={{ color: as.hex }}>
                                {a.score.composite}
                              </span>
                            </div>
                            <p className={`text-[10px] font-semibold truncate ${isCur ? "text-indigo-700" : "text-slate-600"}`}>
                              {a.name}
                            </p>
                            <span className={`text-[9px] font-bold ${a.change1d >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                              {a.change1d >= 0 ? "+" : ""}{a.change1d.toFixed(1)}%
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ── Indicator Matrix (horizontal, below chart) ────────────────── */}
          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden shadow-sm">
            {/* Header bar: filter tabs + legend in one row */}
            <div className="px-5 py-3.5 border-b border-slate-50 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] font-black tracking-[0.15em] uppercase text-slate-400 mr-2">
                  Indicator Matrix
                </span>
                {(["All", ...CATS] as const).map((cat) => {
                  const isActive = activeCat === cat;
                  const hex   = cat === "All" ? "#64748b" : CAT[cat as IndicatorCategory].hex;
                  const count = cat === "All"
                    ? asset.indicators.length
                    : asset.indicators.filter((i) => i.category === cat).length;
                  const wt = cat !== "All" && wts
                    ? Math.round((wts[cat as IndicatorCategory] ?? 0) * 100)
                    : null;
                  return (
                    <button key={cat}
                      onClick={() => setActiveCat(cat as IndicatorCategory | "All")}
                      className="text-[10px] font-bold px-2.5 py-1 rounded-lg border transition-all"
                      style={isActive
                        ? { background: hex, borderColor: hex, color: "#fff" }
                        : { background: "#f8fafc", borderColor: "#e2e8f0", color: "#64748b" }}>
                      {cat}
                      {wt !== null && <span className="opacity-60 ml-1 text-[8px]">{wt}%</span>}
                      <span className="ml-1 opacity-50 text-[8px]">{count}</span>
                    </button>
                  );
                })}
              </div>
              {/* Weight legend */}
              <div className="flex items-center gap-3">
                {[
                  { label: "KEY",  hex: "#dc2626" },
                  { label: "HIGH", hex: "#f59e0b" },
                  { label: "MED",  hex: "#6366f1" },
                  { label: "LOW",  hex: "#94a3b8" },
                ].map(({ label, hex }) => (
                  <div key={label} className="flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full" style={{ background: hex }} />
                    <span className="text-[8px] text-slate-400 font-bold">{label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Indicator cards grid — horizontal */}
            <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {filtered.map((ind) => <IndicatorCard key={ind.id} ind={ind} />)}
            </div>
          </div>
        </div>

        {/* RIGHT: decision engine + category scores */}
        <div className="flex flex-col w-full lg:w-80 flex-shrink-0 space-y-4">

          {/* Decision Engine */}
          <DecisionEngine asset={asset} chart={chart} />

          {/* Category score panel */}
          <div className="bg-white rounded-xl border border-slate-100 px-4 py-4 shadow-sm">
            <p className="text-[9px] font-black tracking-[0.15em] uppercase text-slate-400 mb-4">Category Scores</p>
            <div className="space-y-3.5">
              {CATS.map((cat) => {
                const score = catScore(cat);
                const hex   = scoreColor(score);
                const Icon  = CAT[cat].icon;
                const wt    = wts ? Math.round((wts[cat] ?? 0) * 100) : null;
                return (
                  <div key={cat} className="flex items-center gap-3">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ background: CAT[cat].bg }}>
                      <Icon size={11} style={{ color: hex }} />
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[10px] font-semibold text-slate-600">{cat}</span>
                        <div className="flex items-center gap-1.5">
                          {wt && <span className="text-[8px] text-slate-400">{wt}%</span>}
                          <span className="text-[11px] font-black tabular-nums" style={{ color: hex }}>{score}</span>
                        </div>
                      </div>
                      <div className="h-[5px] w-full rounded-full bg-slate-100 overflow-hidden">
                        <motion.div
                          className="h-full rounded-full"
                          style={{ background: `linear-gradient(90deg, ${hex}80, ${hex})` }}
                          initial={{ width: 0 }}
                          animate={{ width: `${score}%` }}
                          transition={{ duration: 0.9, ease: "easeOut" }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── India VIX Intelligence ────────────────────────────────────────────────────

import type { VixResponse } from "@/app/api/vix/route";

type VixBar = { date: string; open: number; high: number; low: number; close: number };

// Aggregate daily bars → monthly (YYYY-MM-01 keys)
function toMonthlyVixBars(bars: VixBar[]): VixBar[] {
  const groups = new Map<string, VixBar>();
  for (const b of bars) {
    const key = b.date.slice(0, 7) + "-01";
    const ex  = groups.get(key);
    if (!ex) {
      groups.set(key, { date: key, open: b.open, high: b.high, low: b.low, close: b.close });
    } else {
      ex.high  = Math.max(ex.high, b.high);
      ex.low   = Math.min(ex.low,  b.low);
      ex.close = b.close;
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Hover intelligence ───────────────────────────────────────────────────────

import type {
  VixOutcomeSummary, VixDivergence, NiftyBottomZone, VixMonthlyOutcomeSummary,
} from "@/app/api/vix/route";

interface HoverData {
  date:            string;
  vix:             number | null;
  nifty:           number | null;
  zoneLabel:       string;
  insight:         string;
  isBottomZone:    boolean;
  divergenceType?: "hidden_strength" | "weak_rally";
}

function getHoverInsight(
  vix: number, isBottom: boolean, divType: "hidden_strength" | "weak_rally" | undefined,
  summary: VixOutcomeSummary | null
): string {
  if (vix > 30) return `Panic zone · ${summary ? `${summary.winRate20d}% win (20d), avg +${summary.avgRet20d}%` : "Extreme fear"}`;
  if (vix > 28) {
    if (isBottom) return "VIX rejection → Nifty trough confirmed here historically";
    return summary
      ? `Extreme fear · 10d win ${summary.winRate10d}%, avg ${summary.avgRet10d > 0 ? "+" : ""}${summary.avgRet10d}%`
      : "Extreme fear zone";
  }
  if (vix > 25) return "High fear · Institutional hedging at scale — watch for reversal";
  if (vix > 20) return "Rising fear · Quant funds start de-risking above 20";
  if (vix < 12) return "Complacency · Lowest protection demand — correction risk elevated";
  if (divType === "hidden_strength") return "Hidden strength · VIX spiking but Nifty holding — bullish divergence";
  if (divType === "weak_rally") return "Weak rally · VIX falling but Nifty lagging — rally lacks conviction";
  return "Normal range · Watch direction: rising = warning, falling = tailwind";
}

// ─── Synced split chart: Nifty 50 (top) + India VIX (bottom) ─────────────────

function VixNiftySplitChart({ vixBars, niftyBars, rejections, niftyBottomZones,
  divergences, zoneColor, onHover }: {
  vixBars:          VixBar[];
  niftyBars:        VixBar[];
  rejections:       { date: string; vix: number }[];
  niftyBottomZones: NiftyBottomZone[];
  divergences:      VixDivergence[];
  zoneColor:        string;
  onHover:          (d: HoverData | null) => void;
}) {
  const niftyRef     = useRef<HTMLDivElement>(null);
  const vixRef       = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef   = useRef<(() => void) | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.6);
  const dragState = useRef<{ dragging: boolean; startY: number; startRatio: number }>({ dragging: false, startY: 0, startRatio: 0.6 });

  // Draggable divider handlers
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragState.current.dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dy   = e.clientY - dragState.current.startY;
      const delta = dy / rect.height;
      const next  = Math.min(0.85, Math.max(0.15, dragState.current.startRatio + delta));
      setSplitRatio(next);
    };
    const onMouseUp = () => { dragState.current.dragging = false; };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  }, []);

  useEffect(() => {
    if (!niftyRef.current || !vixRef.current) return;
    const filteredVix   = toMonthlyVixBars(vixBars);
    const filteredNifty = toMonthlyVixBars(niftyBars);
    if (filteredVix.length < 2) return;
    let removed = false;

    (async () => {
      const { createChart, CandlestickSeries, LineStyle, createSeriesMarkers } =
        await import("lightweight-charts");
      if (removed) return;

      // Convert daily event dates → monthly bucket keys (YYYY-MM-01)
      const toMk = (d: string) => d.slice(0, 7) + "-01";

      const bottomDates = new Set(niftyBottomZones.map((z) => toMk(z.date)));
      // Dedup divergences per month (first per month wins)
      const divMap = new Map<string, typeof divergences[0]["type"]>();
      for (const d of divergences) { const mk = toMk(d.date); if (!divMap.has(mk)) divMap.set(mk, d.type); }
      // Dedup rejections per month (highest VIX per month)
      const rejMonthMap = new Map<string, number>();
      for (const r of rejections) { const mk = toMk(r.date); if (!rejMonthMap.has(mk) || r.vix > rejMonthMap.get(mk)!) rejMonthMap.set(mk, r.vix); }

      const SCALE_W = 65; // fixed price-scale width — keeps crosshair x-aligned across panes

      const SHARED_LAYOUT = {
        layout:    { background: { color: "#ffffff" }, textColor: "#374151", fontFamily: "Inter,system-ui,sans-serif", fontSize: 11 },
        grid:      { vertLines: { color: "#f3f4f6", style: LineStyle.Solid }, horzLines: { color: "#f3f4f6", style: LineStyle.Solid } },
        crosshair: { mode: 1 },
        autoSize:  true,
      } as const;

      // ── Nifty chart — NO time axis ──
      const niftyChart = createChart(niftyRef.current!, {
        ...SHARED_LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.08, bottom: 0 }, minimumWidth: SCALE_W },
        timeScale: { visible: false },
      });

      const niftySeries = niftyChart.addSeries(CandlestickSeries, {
        upColor: "#10b981", downColor: "#ef4444",
        borderUpColor: "#10b981", borderDownColor: "#ef4444",
        wickUpColor: "#10b981", wickDownColor: "#ef4444",
        priceLineVisible: false,
      });
      niftySeries.setData(filteredNifty.map((b) => ({
        time: b.date as `${number}-${number}-${number}`,
        open: b.open, high: b.high, low: b.low, close: b.close,
      })));

      // Nifty markers: green bottom zones + divergences
      const niftyMarkers: Parameters<typeof createSeriesMarkers>[1] = [];
      for (const b of filteredNifty) {
        if (bottomDates.has(b.date))
          niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "belowBar", color: "#10b981", shape: "arrowUp", text: "VIX Bottom", size: 1 });
        const dt = divMap.get(b.date);
        if (dt === "hidden_strength")
          niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "aboveBar", color: "#3b82f6", shape: "circle", text: "HS", size: 1 });
        else if (dt === "weak_rally")
          niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "aboveBar", color: "#f59e0b", shape: "circle", text: "WR", size: 1 });
      }
      if (niftyMarkers.length) createSeriesMarkers(niftySeries as Parameters<typeof createSeriesMarkers>[0], niftyMarkers);

      // ── VIX chart — shared time axis at bottom ──
      const vixChart = createChart(vixRef.current!, {
        ...SHARED_LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0, bottom: 0.08 }, minimumWidth: SCALE_W },
        timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false },
      });

      const vixSeries = vixChart.addSeries(CandlestickSeries, {
        upColor: "#ef4444", downColor: "#10b981",
        borderUpColor: "#ef4444", borderDownColor: "#10b981",
        wickUpColor: "#ef4444", wickDownColor: "#10b981",
        priceLineVisible: false,
      });
      vixSeries.setData(filteredVix.map((b) => ({
        time: b.date as `${number}-${number}-${number}`,
        open: b.open, high: b.high, low: b.low, close: b.close,
      })));

      // VIX zone bands
      const ZONE_LINES = [
        { price: 12, color: "#22c55e", title: "Complacency  " },
        { price: 20, color: "#3b82f6", title: "Normal  " },
        { price: 25, color: "#f59e0b", title: "Rising Fear  " },
        { price: 28, color: "#f97316", title: "Extreme  " },
        { price: 30, color: "#ef4444", title: "Panic  " },
      ];
      for (const z of ZONE_LINES)
        vixSeries.createPriceLine({ price: z.price, color: z.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: z.title });

      // VIX rejection markers (monthly dates)
      const vixMarkers: Parameters<typeof createSeriesMarkers>[1] = [];
      const visibleVixDates = new Set(filteredVix.map((b) => b.date));
      for (const [date] of rejMonthMap)
        if (visibleVixDates.has(date))
          vixMarkers.push({ time: date as `${number}-${number}-${number}`, position: "aboveBar", color: "#f97316", shape: "circle", text: "", size: 1 });
      if (vixMarkers.length) createSeriesMarkers(vixSeries as Parameters<typeof createSeriesMarkers>[0], vixMarkers);

      niftyChart.timeScale().fitContent();
      vixChart.timeScale().fitContent();

      // ── Time-range sync (date-based, not index-based) ──
      let syncing = false;
      niftyChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true;
        vixChart.timeScale().setVisibleRange(r); syncing = false;
      });
      vixChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true;
        niftyChart.timeScale().setVisibleRange(r); syncing = false;
      });

      // ── Crosshair sync + hover intelligence ──
      const vixCloseMap  = new Map(filteredVix.map((b)   => [b.date, b.close]));
      const niftyDateMap = new Map(filteredNifty.map((b) => [b.date, b.close]));

      niftyChart.subscribeCrosshairMove((p) => {
        if (p.time) {
          const t = p.time as `${number}-${number}-${number}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          vixChart.setCrosshairPosition(0, t, vixSeries as any);
          const vix   = vixCloseMap.get(t) ?? null;
          const nifty = niftyDateMap.get(t) ?? null;
          const isBottom = bottomDates.has(t);
          const divType  = divMap.get(t) as "hidden_strength" | "weak_rally" | undefined;
          const zoneLabel = vix ? (vix > 30 ? "Panic Zone" : vix > 28 ? "Extreme Fear" : vix > 25 ? "High Fear" : vix > 20 ? "Rising Fear" : vix < 12 ? "Complacency" : "Normal") : "";
          onHover({ date: t, vix, nifty, zoneLabel, isBottomZone: isBottom, divergenceType: divType,
            insight: vix ? getHoverInsight(vix, isBottom, divType, null) : "" });
        } else { vixChart.clearCrosshairPosition(); onHover(null); }
      });
      vixChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) niftyChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, niftySeries as any);
        else        niftyChart.clearCrosshairPosition();
      });

      // autoSize: true handles resize automatically — no manual ResizeObserver needed
      cleanupRef.current = () => {
        niftyChart.remove(); vixChart.remove();
      };
    })();

    return () => {
      removed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [vixBars, niftyBars, rejections, niftyBottomZones, divergences, zoneColor, onHover]);

  // 1px visible hairline + 7px invisible hit area on each side = 9px total drag zone
  const DIVIDER_HIT = 9;
  const topH = `calc(${(splitRatio * 100).toFixed(3)}% - ${Math.ceil(DIVIDER_HIT / 2)}px)`;
  const botH = `calc(${((1 - splitRatio) * 100).toFixed(3)}% - ${Math.floor(DIVIDER_HIT / 2)}px)`;

  return (
    <div ref={containerRef} className="flex flex-col h-full select-none overflow-hidden"
      style={{ background: "#ffffff" }}>

      {/* ── Nifty pane ── */}
      <div className="relative flex-shrink-0" style={{ height: topH, overflow: "hidden" }}>
        <div ref={niftyRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>
            Nifty 50 · Monthly
          </span>
        </div>
      </div>

      {/* ── Hairline divider (1px) with wider invisible drag zone ── */}
      <div className="relative flex-shrink-0 cursor-row-resize z-20"
        style={{ height: DIVIDER_HIT }}
        onMouseDown={(e) => {
          dragState.current = { dragging: true, startY: e.clientY, startRatio: splitRatio };
          e.preventDefault();
        }}>
        {/* 1px visible line centred in the hit area */}
        <div className="absolute left-0 right-0" style={{ top: "50%", height: 1, background: "#e5e7eb", transform: "translateY(-50%)" }} />
      </div>

      {/* ── VIX pane ── */}
      <div className="relative flex-shrink-0" style={{ height: botH, overflow: "hidden" }}>
        <div ref={vixRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>
            India VIX · Monthly
          </span>
        </div>
      </div>

    </div>
  );
}

// ── helper: zone color for a given vix value (used in gauge) ──
function vixZoneColor(v: number) {
  if (v < 12)  return "#22c55e";
  if (v < 20)  return "#3b82f6";
  if (v < 25)  return "#f59e0b";
  if (v < 30)  return "#f97316";
  return "#ef4444";
}

// ── WinRateBar: animated horizontal bar ──
function WinRateBar({ wr, avg, label }: { wr: number; avg: number; label: string }) {
  const c = wr >= 65 ? "#10b981" : wr >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-black uppercase tracking-wide text-slate-400">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-black tabular-nums" style={{ color: c }}>{wr}%</span>
          <span className="text-[9px] font-bold tabular-nums" style={{ color: avg >= 0 ? "#10b981" : "#ef4444" }}>
            {avg >= 0 ? "+" : ""}{avg}%
          </span>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <motion.div className="h-full rounded-full" style={{ background: c }}
          initial={{ width: 0 }} animate={{ width: `${wr}%` }}
          transition={{ duration: 0.9, ease: "easeOut" }} />
      </div>
    </div>
  );
}

// Full-screen VIX modal — monthly split view + improved intelligence
function VixModal({ vix, onClose }: { vix: VixResponse; onClose: () => void }) {
  const { current, change1d, trend, zone, signal, rejections,
    bars, niftyBars, divergences, niftyBottomZones,
    context, monthlyOutcomeSummaries } = vix;
  const [hoverData,        setHoverData]        = useState<HoverData | null>(null);
  const [activeThreshold,  setActiveThreshold]  = useState<number>(25);
  const onHover = useCallback((d: HoverData | null) => setHoverData(d), []);

  const trendIcon   = trend === "rising" ? "↑" : trend === "falling" ? "↓" : "→";
  const trendColor  = trend === "rising" ? "#ef4444" : trend === "falling" ? "#10b981" : "#94a3b8";
  const signalColor = signal.bias === "Bullish" ? "#10b981" : signal.bias === "Bearish" ? "#ef4444" : "#94a3b8";
  const recentDivergences = divergences.slice(-4).reverse();

  const activeSummary: VixMonthlyOutcomeSummary | undefined =
    monthlyOutcomeSummaries.find((s) => s.threshold === activeThreshold);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col bg-white overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      {/* ══ HEADER ══ */}
      <div className="flex-shrink-0 px-3 sm:px-6 py-3 flex items-center gap-3 sm:gap-6 border-b border-slate-100 flex-wrap"
        style={{ background: zone.bgColor }}>

        {/* VIX value block */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex flex-col items-center justify-center bg-white shadow-sm flex-shrink-0"
            style={{ border: `2px solid ${zone.color}45` }}>
            <span className="text-base sm:text-lg font-black leading-none tabular-nums" style={{ color: zone.color }}>{current.toFixed(1)}</span>
            <span className="text-[8px] font-bold text-slate-400 mt-0.5 tracking-widest">VIX</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2 mb-0.5 flex-wrap">
              <span className="text-base sm:text-lg font-black text-slate-900">India VIX</span>
              <span className="text-[11px] font-black px-2.5 py-0.5 rounded-full" style={{ background: zone.color, color: "#fff" }}>{zone.label}</span>
              <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-slate-900 text-white">Monthly</span>
              <span className="text-sm font-bold tabular-nums" style={{ color: change1d >= 0 ? "#ef4444" : "#10b981" }}>
                {change1d >= 0 ? "+" : ""}{change1d.toFixed(2)}%
              </span>
              <span className="hidden sm:inline text-xs font-bold" style={{ color: trendColor }}>{trendIcon} {trend}</span>
            </div>
            {/* Context pills — hidden on mobile */}
            <div className="hidden sm:flex items-center gap-1.5">
              <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-white/70 border border-slate-200 text-slate-600">
                {context.percentileRank}th pct
              </span>
              <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-white/70 border border-slate-200 text-slate-600">
                {context.regimeDays}d in zone
              </span>
              <span className="text-[9px] font-bold px-2 py-0.5 rounded-full border"
                style={{
                  background:  context.aboveMa20 ? "#fef2f2" : "#f0fdf4",
                  borderColor: context.aboveMa20 ? "#fca5a5" : "#86efac",
                  color:       context.aboveMa20 ? "#dc2626" : "#16a34a",
                }}>
                {context.aboveMa20 ? "↑" : "↓"} MA20 {context.ma20.toFixed(1)}
              </span>
              <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-white/70 border border-slate-200"
                style={{ color: context.momentum5d >= 0 ? "#ef4444" : "#10b981" }}>
                5d {context.momentum5d >= 0 ? "+" : ""}{context.momentum5d}%
              </span>
            </div>
          </div>
        </div>

        {/* Signal — hidden on mobile */}
        <div className="hidden sm:flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-[8px] font-black tracking-widest uppercase text-slate-400 mb-1">Signal</p>
            <p className="text-base font-black" style={{ color: signalColor }}>{signal.label}</p>
            <div className="flex items-center gap-2 mt-1 justify-center">
              <div className="w-24 h-1.5 rounded-full bg-white/60 overflow-hidden">
                <motion.div className="h-full rounded-full" style={{ background: signalColor }}
                  initial={{ width: 0 }} animate={{ width: `${signal.confidence}%` }}
                  transition={{ duration: 1.1, ease: "easeOut" }} />
              </div>
              <span className="text-xs font-black" style={{ color: signalColor }}>{signal.confidence}%</span>
            </div>
          </div>
        </div>

        {/* Close */}
        <div className="ml-auto">
          <button onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/80 text-slate-400 hover:text-slate-900 hover:bg-white transition-all">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* ══ BODY ══ */}
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden min-h-0">

        {/* ── Chart column ── */}
        <div className="h-[45vh] md:h-auto md:flex-1 flex-shrink-0 md:flex-shrink flex flex-col px-3 sm:px-5 pt-3 pb-3 gap-2 min-w-0">
          <p className="text-[10px] font-black tracking-widest uppercase text-slate-400 flex-shrink-0">
            Nifty 50 × India VIX &nbsp;·&nbsp; Monthly · Linked
          </p>
          <div className="flex-1 rounded-xl overflow-hidden border border-slate-100 shadow-sm min-h-0">
            <VixNiftySplitChart
              vixBars={bars} niftyBars={niftyBars}
              rejections={rejections} niftyBottomZones={niftyBottomZones}
              divergences={divergences} zoneColor={zone.color}
              onHover={onHover} />
          </div>
        </div>

        {/* ── Right panel ── */}
        <div className="w-full md:w-72 flex-shrink-0 border-t md:border-t-0 md:border-l border-slate-100 flex flex-col overflow-y-auto bg-slate-50/40">

          {/* Crosshair card */}
          <div className="m-4 mb-0 rounded-xl border overflow-hidden flex-shrink-0"
            style={{ background: hoverData ? zone.bgColor : "#ffffff", borderColor: hoverData ? `${zone.color}35` : "#e2e8f0" }}>
            <div className="px-3 py-2 border-b border-black/5 flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: hoverData ? zone.color : "#94a3b8" }} />
              <p className="text-[9px] font-black tracking-wider uppercase" style={{ color: hoverData ? zone.color : "#94a3b8" }}>
                Crosshair · Live
              </p>
            </div>
            {hoverData ? (
              <div className="px-3 py-2.5 space-y-2">
                <p className="text-[10px] font-bold text-slate-400 font-mono">{hoverData.date}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="rounded-lg p-2 bg-white border border-slate-100">
                    <p className="text-[8px] font-black uppercase tracking-wide text-slate-400 mb-0.5">Nifty 50</p>
                    <p className="text-sm font-black text-slate-900 tabular-nums">
                      {hoverData.nifty ? hoverData.nifty.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : "—"}
                    </p>
                  </div>
                  <div className="rounded-lg p-2 bg-white border border-slate-100">
                    <p className="text-[8px] font-black uppercase tracking-wide text-slate-400 mb-0.5">VIX</p>
                    <p className="text-sm font-black tabular-nums" style={{ color: hoverData.vix ? vixZoneColor(hoverData.vix) : "#94a3b8" }}>
                      {hoverData.vix?.toFixed(2) ?? "—"}
                    </p>
                  </div>
                </div>
                {hoverData.zoneLabel && (
                  <span className="text-[9px] font-black px-2 py-0.5 rounded-md inline-block"
                    style={{ background: `${zone.color}18`, color: zone.color }}>{hoverData.zoneLabel}</span>
                )}
                <p className="text-[10px] leading-relaxed text-slate-600">{hoverData.insight}</p>
                <div className="flex flex-wrap gap-1">
                  {hoverData.isBottomZone && (
                    <span className="text-[8px] font-black text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">↑ Nifty trough zone</span>
                  )}
                  {hoverData.divergenceType === "hidden_strength" && (
                    <span className="text-[8px] font-black text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">◈ Hidden Strength</span>
                  )}
                  {hoverData.divergenceType === "weak_rally" && (
                    <span className="text-[8px] font-black text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">◈ Weak Rally</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="px-3 py-4 flex flex-col items-center gap-1 text-center">
                <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center mb-0.5">
                  <span className="text-slate-400 text-xs">⊕</span>
                </div>
                <p className="text-[10px] font-bold text-slate-400">Hover chart to inspect</p>
              </div>
            )}
          </div>

          {/* Monthly VIX Spike → Nifty Forward Returns */}
          <div className="m-4 mb-0 rounded-xl border border-slate-200 bg-white flex-shrink-0 overflow-hidden">
            <div className="px-4 pt-3 pb-2.5 border-b border-slate-100">
              <p className="text-[9px] font-black tracking-wider uppercase text-slate-400 mb-2">
                Monthly VIX Spike · Nifty Returns
              </p>
              {/* Threshold tabs */}
              <div className="flex gap-0.5 bg-slate-100 rounded-lg p-0.5">
                {[20, 25, 28].map((t) => (
                  <button key={t} onClick={() => setActiveThreshold(t)}
                    className="flex-1 text-[10px] font-bold py-1 rounded-md transition-all"
                    style={{
                      background: activeThreshold === t ? "#0f172a" : "transparent",
                      color:      activeThreshold === t ? "#fff" : "#64748b",
                    }}>
                    &gt;{t}
                  </button>
                ))}
              </div>
            </div>
            {activeSummary ? (
              <div className="px-4 py-3 space-y-2.5">
                <WinRateBar label="1 Month"   wr={activeSummary.winRate1m}  avg={activeSummary.avgRet1m} />
                <WinRateBar label="3 Months"  wr={activeSummary.winRate3m}  avg={activeSummary.avgRet3m} />
                <WinRateBar label="6 Months"  wr={activeSummary.winRate6m}  avg={activeSummary.avgRet6m} />
                <WinRateBar label="12 Months" wr={activeSummary.winRate12m} avg={activeSummary.avgRet12m} />
                <p className="text-[9px] text-slate-400 pt-1 border-t border-slate-100">
                  {activeSummary.count} monthly events · {activeSummary.zoneLabel}
                </p>
              </div>
            ) : (
              <div className="px-4 py-4 text-[10px] text-slate-400 text-center">
                Not enough data for VIX &gt; {activeThreshold}
              </div>
            )}
          </div>

          {/* Divergence alerts */}
          {recentDivergences.length > 0 && (
            <div className="m-4 mb-0 rounded-xl border border-slate-200 bg-white p-4 flex-shrink-0">
              <p className="text-[9px] font-black tracking-wider uppercase text-slate-400 mb-2.5">
                VIX–Nifty Divergences
              </p>
              <div className="space-y-1.5">
                {recentDivergences.map((d, i) => {
                  const isHS = d.type === "hidden_strength";
                  return (
                    <div key={i} className="flex items-center justify-between py-1.5 px-2.5 rounded-lg border"
                      style={{ background: isHS ? "#eff6ff" : "#fffbeb", borderColor: isHS ? "#bfdbfe" : "#fde68a" }}>
                      <div>
                        <p className="text-[9px] font-black" style={{ color: isHS ? "#1d4ed8" : "#92400e" }}>
                          {isHS ? "◈ Hidden Strength" : "◈ Weak Rally"}
                        </p>
                        <p className="text-[8px] font-mono mt-0.5" style={{ color: isHS ? "#3b82f6" : "#d97706" }}>{d.date}</p>
                      </div>
                      <div className="text-right space-y-0.5">
                        <p className="text-[9px] font-bold tabular-nums" style={{ color: d.vixChange > 0 ? "#ef4444" : "#10b981" }}>
                          VIX {d.vixChange > 0 ? "+" : ""}{d.vixChange}%
                        </p>
                        <p className="text-[9px] font-bold tabular-nums text-slate-500">
                          N50 {d.niftyChange > 0 ? "+" : ""}{d.niftyChange}%
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Monthly VIX reversal points */}
          {rejections.length > 0 && (
            <div className="m-4 mb-0 rounded-xl border border-slate-200 bg-white p-4 flex-shrink-0">
              <p className="text-[9px] font-black tracking-wider uppercase text-slate-400 mb-2.5">
                VIX Reversal Months ({rejections.length})
              </p>
              <div className="space-y-1">
                {[...rejections].reverse().map((r, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 px-2.5 rounded-lg bg-orange-50 border border-orange-100">
                    <span className="text-[10px] text-slate-500 font-mono">{r.date.slice(0, 7)}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                        style={{ background: `${vixZoneColor(r.vix)}18`, color: vixZoneColor(r.vix) }}>
                        {r.vix > 30 ? "Panic" : r.vix > 25 ? "High Fear" : "Fear"}
                      </span>
                      <span className="text-xs font-black tabular-nums" style={{ color: "#f97316" }}>{r.vix.toFixed(1)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Key insight */}
          <div className="m-4 rounded-xl p-4 border flex-shrink-0" style={{ background: zone.bgColor, borderColor: `${zone.color}25` }}>
            <p className="text-[9px] font-black tracking-wider uppercase mb-2" style={{ color: zone.color }}>Monthly Thesis</p>
            <p className="text-xs leading-relaxed text-slate-700">
              {zone.label === "Panic Zone"
                ? "Monthly VIX above 30 has historically marked major capitulation bottoms. Every prior monthly close above 30 preceded a 20%+ Nifty rally over the next 12 months."
                : zone.label === "High Fear"
                ? "Monthly VIX in 25–30 triggers institutional re-allocation from cash to equities. When monthly VIX rolls over from this zone, Nifty typically gains 15–25% over the next 6–12 months."
                : zone.label === "Complacency"
                ? "Monthly VIX below 12 signals extreme market complacency. Historically, this precedes volatility expansion and equity corrections of 10–15% within 3–6 months."
                : zone.label === "Rising Fear"
                ? "Monthly VIX crossing above 20 triggers systematic de-risking from quant funds. Historical data shows Nifty often bottoms within 1–3 months of monthly VIX peaking."
                : "Monthly VIX in the 12–20 normal band. Trend direction is key — a rising monthly VIX warns of institutional hedging buildup, while a declining VIX confirms risk-on positioning."}
            </p>
          </div>

        </div>
      </div>
    </motion.div>
  );
}

// Compact VIX card — light theme, shown in Indian Equities ClassView
function VixIntelligenceCard() {
  const { data } = useSWR<VixResponse>("/api/vix", fetcher, { refreshInterval: 300_000 });
  const [modalOpen, setModalOpen] = useState(false);

  if (!data) return null;

  if (!data.hasData) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 px-4 py-3 flex items-center gap-3 text-sm text-slate-400 bg-white">
        <Activity size={14} />
        <span>India VIX data unavailable</span>
      </div>
    );
  }

  const { current, change1d, trend, zone, signal } = data;
  const trendIcon   = trend === "rising" ? "↑" : trend === "falling" ? "↓" : "→";
  const trendColor  = trend === "rising" ? "#ef4444" : trend === "falling" ? "#10b981" : "#94a3b8";
  const signalColor = signal.bias === "Bullish" ? "#10b981" : signal.bias === "Bearish" ? "#ef4444" : "#94a3b8";

  return (
    <>
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {modalOpen && <VixModal vix={data} onClose={() => setModalOpen(false)} />}
        </AnimatePresence>,
        document.body
      )}

      <motion.button
        onClick={() => setModalOpen(true)}
        className="w-full rounded-xl text-left overflow-hidden bg-white shadow-sm"
        style={{ border: `1.5px solid ${zone.color}35` }}
        whileHover={{ scale: 1.004, boxShadow: `0 4px 20px ${zone.color}18` }}
        transition={{ duration: 0.15 }}
      >
        <div className="px-5 py-4 flex items-center gap-5 flex-wrap">
          {/* Icon */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: zone.bgColor, border: `1px solid ${zone.color}40` }}>
              <Activity size={16} style={{ color: zone.color }} />
            </div>
            <div>
              <p className="text-[9px] font-black tracking-wider uppercase text-slate-400 mb-0.5">Market Pulse · India VIX</p>
              <p className="text-xs font-bold" style={{ color: zone.textColor }}>{zone.label}</p>
            </div>
          </div>

          {/* Value */}
          <div className="flex items-end gap-2">
            <span className="text-3xl font-black tabular-nums leading-none" style={{ color: zone.color }}>
              {current.toFixed(1)}
            </span>
            <div className="pb-0.5 space-y-0.5">
              <span className="block text-[10px] font-bold tabular-nums"
                style={{ color: change1d >= 0 ? "#ef4444" : "#10b981" }}>
                {change1d >= 0 ? "+" : ""}{change1d.toFixed(2)}%
              </span>
              <span className="block text-[10px] font-bold" style={{ color: trendColor }}>
                {trendIcon} {trend}
              </span>
            </div>
          </div>

          {/* Signal */}
          <div className="flex-1 min-w-[120px]">
            <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide mb-1">Signal</p>
            <p className="text-sm font-black" style={{ color: signalColor }}>{signal.label}</p>
            <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-1">{signal.rationale.split(".")[0]}.</p>
          </div>

          {/* Confidence */}
          <div className="text-right flex-shrink-0">
            <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide mb-1">Confidence</p>
            <p className="text-lg font-black text-slate-900">{signal.confidence}%</p>
            <div className="w-20 h-[3px] rounded-full bg-slate-100 mt-1.5 ml-auto overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${signal.confidence}%`, background: zone.color }} />
            </div>
          </div>

          <ChevronRight size={14} className="text-slate-300 flex-shrink-0" />
        </div>

        {/* Active zone bar */}
        <div className="flex h-[3px]">
          {[
            { pct: 20, color: "#22c55e", band: 0 },
            { pct: 20, color: "#3b82f6", band: 1 },
            { pct: 13, color: "#f59e0b", band: 2 },
            { pct: 13, color: "#f97316", band: 3 },
            { pct: 34, color: "#ef4444", band: 4 },
          ].map((seg) => (
            <div key={seg.band} style={{
              width: `${seg.pct}%`,
              background: seg.color,
              opacity: seg.band === zone.band ? 1 : 0.2,
            }} />
          ))}
        </div>
      </motion.button>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Nifty RSI Extremes Engine ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

import type { RsiResponse } from "@/app/api/rsi/route";
import type { RocResponse } from "@/app/api/roc/route";
import type { BbResponse, BbTouchEvent } from "@/app/api/bb/route";
import type { BreadthResponse, AdBar, AdWeeklyBar } from "@/app/api/breadth/route";
import type { Dma200Response, Dma200Bar } from "@/app/api/dma200/route";
import type { LcResponse, LcBar } from "@/app/api/lc/route";

// ─── RSI Dual Chart ────────────────────────────────────────────────────────────

function RsiSplitChart({ niftyBars, rsiBars, extremeEvents, currentRsi }: {
  niftyBars:     RsiResponse["niftyBars"];
  rsiBars:       RsiResponse["rsiBars"];
  extremeEvents: RsiResponse["extremeEvents"];
  currentRsi:    number;
}) {
  const niftyRef    = useRef<HTMLDivElement>(null);
  const rsiRef      = useRef<HTMLDivElement>(null);
  const dividerRef  = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef  = useRef<(() => void) | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.6);
  const dragState = useRef({ dragging: false, startY: 0, startRatio: 0.6 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.dragging || !containerRef.current) return;
      const rect  = containerRef.current.getBoundingClientRect();
      const delta = (e.clientY - dragState.current.startY) / rect.height;
      setSplitRatio(Math.min(0.85, Math.max(0.15, dragState.current.startRatio + delta)));
    };
    const onUp = () => { dragState.current.dragging = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    if (!niftyRef.current || !rsiRef.current || niftyBars.length < 2 || rsiBars.length < 2) return;
    let removed = false;
    (async () => {
      const { createChart, CandlestickSeries, LineSeries, LineStyle, createSeriesMarkers } =
        await import("lightweight-charts");
      if (removed) return;

      const SCALE_W = 65; // same fixed price-scale width — keeps crosshair x-aligned

      const LAYOUT = {
        layout:    { background: { color: "#ffffff" }, textColor: "#374151", fontFamily: "Inter,system-ui,sans-serif", fontSize: 11 },
        grid:      { vertLines: { color: "#f3f4f6", style: LineStyle.Solid }, horzLines: { color: "#f3f4f6", style: LineStyle.Solid } },
        crosshair: { mode: 1 },
        autoSize:  true,
      } as const;

      // ── Nifty chart (top) — no time axis ──
      const niftyChart = createChart(niftyRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.06, bottom: 0 }, minimumWidth: SCALE_W },
        timeScale: { visible: false },
      });
      const niftySeries = niftyChart.addSeries(CandlestickSeries, {
        upColor: "#10b981", downColor: "#ef4444",
        borderUpColor: "#10b981", borderDownColor: "#ef4444",
        wickUpColor: "#10b981", wickDownColor: "#ef4444",
        priceLineVisible: false,
      });
      niftySeries.setData(niftyBars.map((b) => ({
        time: b.date as `${number}-${number}-${number}`,
        open: b.open, high: b.high, low: b.low, close: b.close,
      })));

      // Extreme event markers on Nifty — red arrow above extreme periods
      const eventDateSet = new Set(extremeEvents.flatMap((e) => [e.startDate, e.peakDate]));
      const niftyMarkers: Parameters<typeof createSeriesMarkers>[1] = [];
      for (const b of niftyBars) {
        if (extremeEvents.some((e) => b.date >= e.startDate && b.date <= e.endDate))
          niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "aboveBar", color: "#ef444480", shape: "circle", text: "", size: 0.5 });
        if (eventDateSet.has(b.date))
          niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "aboveBar", color: "#ef4444", shape: "arrowDown", text: "Extreme", size: 1 });
      }
      if (niftyMarkers.length) createSeriesMarkers(niftySeries as Parameters<typeof createSeriesMarkers>[0], niftyMarkers);

      // ── RSI chart (bottom) — with time axis ──
      const rsiChart = createChart(rsiRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0, bottom: 0.05 }, minimumWidth: SCALE_W },
        timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false },
      });

      // RSI line — colored by zone
      const rsiSeries = rsiChart.addSeries(LineSeries, {
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
      });
      rsiSeries.setData(rsiBars.map((b) => ({
        time:  b.date as `${number}-${number}-${number}`,
        value: b.rsi,
        color: b.rsi >= 80 ? "#ef4444" : b.rsi >= 70 ? "#f97316" : b.rsi <= 30 ? "#10b981" : "#3b82f6",
      })));

      // Reference lines
      const REF_LINES = [
        { price: 80, color: "#ef4444", title: "Extreme 80  ", style: LineStyle.Dashed },
        { price: 70, color: "#f97316", title: "Elevated 70  ", style: LineStyle.Dashed },
        { price: 50, color: "#94a3b8", title: "50  ", style: LineStyle.Dotted },
        { price: 30, color: "#10b981", title: "Oversold 30  ", style: LineStyle.Dashed },
      ];
      for (const l of REF_LINES)
        rsiSeries.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style, axisLabelVisible: true, title: l.title });

      // Extreme markers on RSI chart
      const rsiMarkers: Parameters<typeof createSeriesMarkers>[1] = [];
      for (const e of extremeEvents) {
        rsiMarkers.push({
          time: e.peakDate as `${number}-${number}-${number}`,
          position: "aboveBar", color: "#ef4444", shape: "circle", text: "⚠", size: 1,
        });
      }
      if (rsiMarkers.length) createSeriesMarkers(rsiSeries as Parameters<typeof createSeriesMarkers>[0], rsiMarkers);

      niftyChart.timeScale().fitContent();
      rsiChart.timeScale().fitContent();

      // ── Sync (date-based) ──
      let syncing = false;
      niftyChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; rsiChart.timeScale().setVisibleRange(r); syncing = false;
      });
      rsiChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; niftyChart.timeScale().setVisibleRange(r); syncing = false;
      });

      // ── Crosshair sync ──
      niftyChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) rsiChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, rsiSeries as any);
        else        rsiChart.clearCrosshairPosition();
      });
      rsiChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) niftyChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, niftySeries as any);
        else        niftyChart.clearCrosshairPosition();
      });

      cleanupRef.current = () => { niftyChart.remove(); rsiChart.remove(); };
    })();
    return () => { removed = true; cleanupRef.current?.(); cleanupRef.current = null; };
  }, [niftyBars, rsiBars, extremeEvents, currentRsi]);

  const DIVIDER_HIT = 9;
  const topH = `calc(${(splitRatio * 100).toFixed(3)}% - ${Math.ceil(DIVIDER_HIT / 2)}px)`;
  const botH = `calc(${((1 - splitRatio) * 100).toFixed(3)}% - ${Math.floor(DIVIDER_HIT / 2)}px)`;

  const rsiColor = currentRsi >= 80 ? "#dc2626" : currentRsi >= 70 ? "#c2410c" : "#1d4ed8";

  return (
    <div ref={containerRef} className="flex flex-col h-full select-none overflow-hidden"
      style={{ background: "#ffffff" }}>

      {/* ── Nifty pane ── */}
      <div className="relative flex-shrink-0" style={{ height: topH, overflow: "hidden" }}>
        <div ref={niftyRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>
            Nifty 50 · Monthly
          </span>
        </div>
      </div>

      {/* ── Hairline divider ── */}
      <div ref={dividerRef} className="relative flex-shrink-0 cursor-row-resize z-20"
        style={{ height: DIVIDER_HIT }}
        onMouseDown={(e) => { dragState.current = { dragging: true, startY: e.clientY, startRatio: splitRatio }; e.preventDefault(); }}>
        <div className="absolute left-0 right-0"
          style={{ top: "50%", height: 1, background: "#e5e7eb", transform: "translateY(-50%)" }} />
      </div>

      {/* ── RSI pane ── */}
      <div className="relative flex-shrink-0" style={{ height: botH, overflow: "hidden" }}>
        <div ref={rsiRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10 flex items-center gap-2">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>
            RSI (14)
          </span>
          <span className="text-[9px] font-black tabular-nums" style={{ color: rsiColor }}>
            {currentRsi.toFixed(1)}
          </span>
        </div>
      </div>

    </div>
  );
}

// ─── RSI Full-screen Modal ────────────────────────────────────────────────────

function RsiModal({ initialData: data, onClose }: { initialData: RsiResponse; onClose: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState<"nifty50" | "nifty500" | "smallcap100">("nifty50");
  const { data: fetched } = useSWR<RsiResponse>(
    `/api/rsi?index=${selectedIndex}`,
    fetcher,
    { fallbackData: selectedIndex === "nifty50" ? data : undefined, revalidateOnFocus: false },
  );
  const d = (fetched?.hasData ? fetched : null) ?? data;
  const { niftyBars, rsiBars, extremeEvents, summary, zone, signal, currentRsi, change, indexLabel } = d;
  const changeColor = change >= 0 ? "#ef4444" : "#10b981";

  const [obTab, setObTab] = useState<"ob80" | "ob70">("ob80");
  const [osTab, setOsTab] = useState<"os35" | "os50">("os35");
  const ob = summary[obTab];
  const os = summary[osTab];

  return (
    <motion.div className="fixed inset-0 z-50 flex flex-col bg-white overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}>

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-3 sm:px-6 py-3 flex items-center gap-3 sm:gap-5 border-b border-slate-100 flex-wrap"
        style={{ background: zone.bgColor }}>
        <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex flex-col items-center justify-center bg-white shadow-sm flex-shrink-0"
          style={{ border: `2px solid ${zone.color}45` }}>
          <span className="text-base sm:text-lg font-black leading-none tabular-nums" style={{ color: zone.color }}>{currentRsi.toFixed(1)}</span>
          <span className="text-[8px] font-bold text-slate-400 mt-0.5 tracking-widest">RSI</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-base sm:text-lg font-black text-slate-900">{indexLabel ?? "Nifty 50"} RSI Extremes</span>
            <span className="text-[11px] font-black px-2.5 py-0.5 rounded-full" style={{ background: zone.color, color: "#fff" }}>{zone.label}</span>
            <span className="text-sm font-bold tabular-nums" style={{ color: changeColor }}>
              {change >= 0 ? "+" : ""}{change.toFixed(2)} pts
            </span>
          </div>
          <p className="hidden sm:block text-xs text-slate-500 line-clamp-2">{signal.rationale}</p>
        </div>
        <div className="ml-auto flex items-center gap-3 sm:gap-4">
          <div className="hidden sm:block text-center">
            <p className="text-[8px] font-black tracking-widest uppercase text-slate-400 mb-1">Signal</p>
            <p className="text-sm font-black" style={{ color: zone.color }}>{signal.label}</p>
            <div className="flex items-center gap-1.5 mt-1 justify-center">
              <div className="w-20 h-1.5 rounded-full bg-white/60 overflow-hidden">
                <motion.div className="h-full rounded-full" style={{ background: zone.color }}
                  initial={{ width: 0 }} animate={{ width: `${signal.confidence}%` }}
                  transition={{ duration: 1.1, ease: "easeOut" }} />
              </div>
              <span className="text-[10px] font-black" style={{ color: zone.color }}>{signal.confidence}%</span>
            </div>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/80 text-slate-400 hover:text-slate-900 transition-all">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* ── Index selector ── */}
      <div className="flex-shrink-0 px-4 py-2 border-b border-slate-100 bg-white flex items-center gap-2">
        <span className="text-[9px] font-black tracking-widest uppercase text-slate-400 mr-1">Index</span>
        {([
          { key: "nifty50",     label: "Nifty 50"   },
          { key: "nifty500",    label: "Nifty 500"  },
          { key: "smallcap100", label: "SmallCap 100" },
        ] as const).map(({ key, label }) => (
          <button key={key} onClick={() => setSelectedIndex(key)}
            className="text-[9px] font-black px-2.5 py-1 rounded-full transition-all"
            style={{
              background: selectedIndex === key ? "#1e293b" : "#f1f5f9",
              color:      selectedIndex === key ? "#fff"    : "#64748b",
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden min-h-0">

        {/* Chart */}
        <div className="h-[45vh] md:h-auto md:flex-1 flex-shrink-0 md:flex-shrink flex flex-col px-3 sm:px-5 pt-4 pb-3 min-w-0">
          <p className="text-[10px] font-black tracking-widest uppercase text-slate-400 mb-3 flex-shrink-0">
            {indexLabel ?? "Nifty 50"} × RSI(14) · Monthly · Extreme Zone Analysis
          </p>
          <div className="flex-1 rounded-xl overflow-hidden border border-slate-100 shadow-sm min-h-0">
            <RsiSplitChart niftyBars={niftyBars} rsiBars={rsiBars}
              extremeEvents={extremeEvents} currentRsi={currentRsi} />
          </div>

          {/* Zone legend */}
          <div className="flex-shrink-0 mt-2 flex items-center gap-1.5 flex-wrap">
            {[
              { range: "< 30", label: "Extreme Oversold", color: "#10b981" },
              { range: "30–40", label: "Oversold", color: "#f59e0b" },
              { range: "40–70", label: "Normal", color: "#3b82f6" },
              { range: "70–80", label: "Elevated", color: "#f97316" },
              { range: "> 80",  label: "Extreme", color: "#ef4444" },
            ].map(({ range, label, color }) => (
              <div key={label} className="flex-1 min-w-[4rem] rounded-lg px-1.5 py-1 text-center border"
                style={{ background: `${color}0d`, borderColor: `${color}30` }}>
                <p className="text-[9px] font-black tabular-nums" style={{ color }}>{range}</p>
                <p className="hidden sm:block text-[8px] text-slate-500 font-bold mt-0.5">{label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div className="w-full md:w-72 flex-shrink-0 border-t md:border-t-0 md:border-l border-slate-100 bg-slate-50/40 flex flex-col overflow-y-auto">

          {/* Signal card */}
          <div className="m-4 mb-0 rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-[9px] font-black tracking-wider uppercase text-slate-400 mb-2">Current Signal</p>
            <div className="flex items-start justify-between gap-2 mb-2">
              <div>
                <p className="text-sm font-black" style={{ color: zone.color }}>{signal.label}</p>
                <p className="text-[9px] font-bold text-slate-500 mt-0.5">{signal.signal}</p>
              </div>
              <span className="text-[10px] font-black px-2 py-0.5 rounded-full flex-shrink-0"
                style={{ background: `${zone.color}15`, color: zone.color }}>
                {signal.confidence}% conf
              </span>
            </div>
            {/* RSI gauge bar */}
            <div className="relative h-3 rounded-full overflow-hidden mt-3"
              style={{ background: "linear-gradient(to right, #10b981 0%, #3b82f6 30%, #3b82f6 55%, #f97316 70%, #ef4444 80%, #ef4444 100%)" }}>
              <motion.div className="absolute top-0 bottom-0 w-0.5 bg-white rounded-full shadow"
                style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.25)" }}
                initial={{ left: "0%" }}
                animate={{ left: `${Math.min(100, currentRsi)}%` }}
                transition={{ duration: 1, ease: "easeOut" }} />
            </div>
            <div className="flex justify-between mt-0.5">
              <span className="text-[8px] text-slate-400">0</span>
              <span className="text-[8px] text-red-400 font-bold">80</span>
              <span className="text-[8px] text-slate-400">100</span>
            </div>
          </div>

          {/* Overbought outcome engine */}
          <div className="m-4 mb-0 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[9px] font-black tracking-wider uppercase text-slate-400">
                After RSI · Forward Returns
              </p>
              <div className="flex gap-1">
                {(["ob80", "ob70"] as const).map((key) => (
                  <button key={key} onClick={() => setObTab(key)}
                    className="text-[8px] font-black px-2 py-0.5 rounded-full transition-all"
                    style={{
                      background: obTab === key ? "#ef4444" : "#ef444415",
                      color:      obTab === key ? "#fff"    : "#ef4444",
                    }}>
                    {key === "ob80" ? ">80" : ">70"}
                  </button>
                ))}
              </div>
            </div>
            {ob ? (
              <>
                <div className="space-y-2.5">
                  {([
                    { label: "3 Months",  wr: ob.winRate3m,  avg: ob.avgRet3m  },
                    { label: "6 Months",  wr: ob.winRate6m,  avg: ob.avgRet6m  },
                    { label: "12 Months", wr: ob.winRate12m, avg: ob.avgRet12m },
                    { label: "18 Months", wr: ob.winRate18m, avg: ob.avgRet18m },
                  ]).map(({ label, wr, avg }) => {
                    const c = wr >= 55 ? "#10b981" : wr >= 40 ? "#f59e0b" : "#ef4444";
                    return (
                      <div key={label} className="space-y-0.5">
                        <div className="flex justify-between items-center">
                          <span className="text-[9px] font-black uppercase tracking-wide text-slate-400">{label}</span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-black tabular-nums" style={{ color: c }}>{wr}% win</span>
                            <span className="text-[9px] font-bold tabular-nums" style={{ color: avg >= 0 ? "#10b981" : "#ef4444" }}>
                              {avg >= 0 ? "+" : ""}{avg}%
                            </span>
                          </div>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                          <motion.div className="h-full rounded-full" style={{ background: c }}
                            initial={{ width: 0 }} animate={{ width: `${wr}%` }}
                            transition={{ duration: 0.9, ease: "easeOut" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-[9px] text-slate-400">{ob.totalEvents} events</span>
                  <span className="text-[9px] font-bold tabular-nums" style={{ color: "#ef4444" }}>
                    Avg drawdown: {ob.avgMaxDrawdown.toFixed(1)}%
                  </span>
                </div>
              </>
            ) : (
              <p className="text-[9px] text-slate-400">No events at this threshold yet.</p>
            )}
          </div>

          {/* Oversold outcome engine */}
          <div className="m-4 mb-0 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[9px] font-black tracking-wider uppercase text-slate-400">
                After RSI · Forward Returns
              </p>
              <div className="flex gap-1">
                {(["os35", "os50"] as const).map((key) => (
                  <button key={key} onClick={() => setOsTab(key)}
                    className="text-[8px] font-black px-2 py-0.5 rounded-full transition-all"
                    style={{
                      background: osTab === key ? "#10b981" : "#10b98115",
                      color:      osTab === key ? "#fff"    : "#10b981",
                    }}>
                    {key === "os35" ? "<35" : "<50"}
                  </button>
                ))}
              </div>
            </div>
            {os ? (
              <>
                <div className="space-y-2.5">
                  {([
                    { label: "3 Months",  wr: os.winRate3m,  avg: os.avgRet3m  },
                    { label: "6 Months",  wr: os.winRate6m,  avg: os.avgRet6m  },
                    { label: "12 Months", wr: os.winRate12m, avg: os.avgRet12m },
                    { label: "18 Months", wr: os.winRate18m, avg: os.avgRet18m },
                  ]).map(({ label, wr, avg }) => {
                    const c = wr >= 55 ? "#10b981" : wr >= 40 ? "#f59e0b" : "#ef4444";
                    return (
                      <div key={label} className="space-y-0.5">
                        <div className="flex justify-between items-center">
                          <span className="text-[9px] font-black uppercase tracking-wide text-slate-400">{label}</span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-black tabular-nums" style={{ color: c }}>{wr}% win</span>
                            <span className="text-[9px] font-bold tabular-nums" style={{ color: avg >= 0 ? "#10b981" : "#ef4444" }}>
                              {avg >= 0 ? "+" : ""}{avg}%
                            </span>
                          </div>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                          <motion.div className="h-full rounded-full" style={{ background: c }}
                            initial={{ width: 0 }} animate={{ width: `${wr}%` }}
                            transition={{ duration: 0.9, ease: "easeOut" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-[9px] text-slate-400">{os.totalEvents} events</span>
                  <span className="text-[9px] font-bold tabular-nums" style={{ color: "#ef4444" }}>
                    Avg drawdown: {os.avgMaxDrawdown.toFixed(1)}%
                  </span>
                </div>
              </>
            ) : (
              <p className="text-[9px] text-slate-400">No events at this threshold yet.</p>
            )}
          </div>

          {/* Historical events — all events, newest first */}
          {extremeEvents.length > 0 && (
            <div className="m-4 mb-0 rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between mb-2.5">
                <p className="text-[9px] font-black tracking-wider uppercase text-slate-400">
                  All RSI &gt; 80 Events ({extremeEvents.length})
                </p>
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">● Sustained 2m+</span>
                  <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-600">◌ Brief 1m</span>
                </div>
              </div>
              <div className="space-y-1.5 max-h-80 overflow-y-auto pr-0.5">
                {[...extremeEvents].reverse().map((e, i) => {
                  const isSustained = e.kind === "sustained";
                  return (
                    <div key={i} className="rounded-lg border p-2"
                      style={{
                        background:   isSustained ? "#fef2f2" : "#fff7ed",
                        borderColor:  isSustained ? "#fca5a5" : "#fdba74",
                      }}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[8px]">{isSustained ? "●" : "◌"}</span>
                          <span className="text-[9px] font-black font-mono"
                            style={{ color: isSustained ? "#b91c1c" : "#c2410c" }}>
                            {e.startDate.slice(0, 7)}{e.duration > 1 ? ` → ${e.endDate.slice(0, 7)}` : ""}
                          </span>
                        </div>
                        <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full"
                          style={{ background: isSustained ? "#fee2e2" : "#ffedd5", color: isSustained ? "#dc2626" : "#ea580c" }}>
                          {e.duration}mo · RSI {e.peakRsi.toFixed(0)}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-1">
                        {[
                          { label: "3M",  val: e.ret3m  },
                          { label: "6M",  val: e.ret6m  },
                          { label: "12M", val: e.ret12m },
                          { label: "18M", val: e.ret18m },
                        ].map(({ label, val }) => (
                          <div key={label} className="text-center rounded bg-white border border-slate-100 py-0.5">
                            <p className="text-[7px] font-black uppercase text-slate-400">{label}</p>
                            <p className="text-[9px] font-black tabular-nums"
                              style={{ color: val === null ? "#94a3b8" : val >= 0 ? "#10b981" : "#ef4444" }}>
                              {val === null ? "—" : `${val >= 0 ? "+" : ""}${val}%`}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Analyst interpretation */}
          <div className="m-4 rounded-xl p-4 border flex-shrink-0" style={{ background: zone.bgColor, borderColor: `${zone.color}25` }}>
            <p className="text-[9px] font-black tracking-wider uppercase mb-2" style={{ color: zone.color }}>
              Analyst Interpretation
            </p>
            <p className="text-xs leading-relaxed text-slate-700">
              {zone.label === "Extreme"
                ? `When ${indexLabel ?? "Nifty"} RSI stays above 80 on monthly timeframe, it signals excessive momentum and euphoria. Historically this has led to short-to-medium term corrections as markets become overextended and profit booking begins. ${summary.ob80 ? `Based on ${summary.ob80.totalEvents} past events, 3-month avg return is ${summary.ob80.avgRet3m >= 0 ? "+" : ""}${summary.ob80.avgRet3m}%.` : ""}`
                : zone.label === "Elevated"
                ? "RSI approaching extreme territory. Market is overheating but correction hasn't been triggered yet. Reduce fresh exposure and tighten stop-losses on existing positions."
                : zone.label === "Oversold" || zone.label === "Extreme Oversold"
                ? "Monthly RSI in oversold territory — historically marks accumulation zones in Nifty. Panic selling creates opportunities for patient long-term investors. Look for reversal signals."
                : "Monthly RSI in normal range — no extreme condition present. Market in a healthy trend phase. Focus on individual stock selection and sector rotation rather than macro hedges."}
            </p>
          </div>

        </div>
      </div>
    </motion.div>
  );
}

// ─── RSI Intelligence Card (compact) ─────────────────────────────────────────

function RsiIntelligenceCard() {
  const { data } = useSWR<RsiResponse>("/api/rsi", fetcher, { refreshInterval: 600_000 });
  const [modalOpen, setModalOpen] = useState(false);

  if (!data) return null;
  if (!data.hasData) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 px-4 py-3 flex items-center gap-3 text-sm text-slate-400 bg-white">
        <BarChart2 size={14} />
        <span>RSI data unavailable</span>
      </div>
    );
  }

  const { zone, signal, currentRsi, change, extremeEvents, summary } = data;
  const changeColor = change >= 0 ? "#ef4444" : "#10b981";
  const lastEvent   = extremeEvents.at(-1);

  return (
    <>
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {modalOpen && <RsiModal initialData={data} onClose={() => setModalOpen(false)} />}
        </AnimatePresence>,
        document.body
      )}

      <motion.button onClick={() => setModalOpen(true)}
        className="w-full rounded-xl text-left overflow-hidden bg-white shadow-sm"
        style={{ border: `1.5px solid ${zone.color}35` }}
        whileHover={{ scale: 1.004, boxShadow: `0 4px 20px ${zone.color}18` }}
        transition={{ duration: 0.15 }}>

        <div className="px-5 py-4 flex items-center gap-5 flex-wrap">
          {/* Icon + label */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: zone.bgColor, border: `1px solid ${zone.color}40` }}>
              <BarChart2 size={16} style={{ color: zone.color }} />
            </div>
            <div>
              <p className="text-[9px] font-black tracking-wider uppercase text-slate-400 mb-0.5">RSI Momentum · Nifty Monthly</p>
              <p className="text-xs font-bold" style={{ color: zone.color }}>{zone.label}</p>
            </div>
          </div>

          {/* RSI value */}
          <div className="flex items-end gap-2">
            <span className="text-3xl font-black tabular-nums leading-none" style={{ color: zone.color }}>
              {currentRsi.toFixed(1)}
            </span>
            <div className="pb-0.5 space-y-0.5">
              <span className="block text-[10px] font-bold tabular-nums" style={{ color: changeColor }}>
                {change >= 0 ? "+" : ""}{change.toFixed(2)} pts
              </span>
              <span className="block text-[9px] font-bold text-slate-400">RSI(14)</span>
            </div>
          </div>

          {/* Signal */}
          <div className="flex-1 min-w-[100px]">
            <p className="text-[9px] font-black tracking-wider uppercase text-slate-400 mb-0.5">Signal</p>
            <p className="text-xs font-black" style={{ color: zone.color }}>{signal.label}</p>
            <p className="text-[9px] text-slate-500 mt-0.5">{signal.signal}</p>
          </div>

          {/* Stats */}
          {summary.ob80 && (
            <div className="flex gap-3">
              {[
                { label: "3M avg",  val: summary.ob80.avgRet3m },
                { label: "events",  val: summary.ob80.totalEvents, isCount: true },
              ].map(({ label, val, isCount }) => (
                <div key={label} className="text-center">
                  <p className="text-[8px] font-black uppercase tracking-wide text-slate-400 mb-0.5">{label}</p>
                  <p className="text-sm font-black tabular-nums"
                    style={{ color: isCount ? "#64748b" : (val as number) >= 0 ? "#10b981" : "#ef4444" }}>
                    {isCount ? val : `${(val as number) >= 0 ? "+" : ""}${val}%`}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Last event badge */}
          {lastEvent && zone.label !== "Extreme" && (
            <div className="text-right flex-shrink-0">
              <p className="text-[8px] text-slate-400">Last extreme</p>
              <p className="text-[9px] font-bold text-slate-600 font-mono">{lastEvent.startDate.slice(0, 7)}</p>
              <p className="text-[9px] font-bold" style={{ color: lastEvent.ret3m !== null && lastEvent.ret3m < 0 ? "#ef4444" : "#10b981" }}>
                3M: {lastEvent.ret3m !== null ? `${lastEvent.ret3m >= 0 ? "+" : ""}${lastEvent.ret3m}%` : "—"}
              </p>
            </div>
          )}
          {zone.label === "Extreme" && (
            <div className="flex-shrink-0 px-3 py-1.5 rounded-lg border border-red-200 bg-red-50">
              <p className="text-[9px] font-black text-red-600">⚠ RSI &gt; 80 Active</p>
            </div>
          )}

          {/* Zone bar */}
          <div className="w-full h-1.5 rounded-full overflow-hidden flex mt-1">
            <div style={{ width: "30%", background: "#10b981" }} />
            <div style={{ width: "10%", background: "#f59e0b" }} />
            <div style={{ width: "30%", background: "#3b82f6" }} />
            <div style={{ width: "10%", background: "#f97316" }} />
            <div style={{ width: "20%", background: "#ef4444", opacity: zone.label === "Extreme" ? 1 : 0.3 }} />
          </div>
        </div>
      </motion.button>
    </>
  );
}

// ─── ROC Split Chart ──────────────────────────────────────────────────────────

function RocSplitChart({ niftyBars, rocBars, extremeEvents, currentRoc }: {
  niftyBars:     RocResponse["niftyBars"];
  rocBars:       RocResponse["rocBars"];
  extremeEvents: RocResponse["extremeEvents"];
  currentRoc:    number;
}) {
  const niftyRef     = useRef<HTMLDivElement>(null);
  const rocRef       = useRef<HTMLDivElement>(null);
  const dividerRef   = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef   = useRef<(() => void) | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.6);
  const dragState = useRef({ dragging: false, startY: 0, startRatio: 0.6 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.dragging || !containerRef.current) return;
      const rect  = containerRef.current.getBoundingClientRect();
      const delta = (e.clientY - dragState.current.startY) / rect.height;
      setSplitRatio(Math.min(0.85, Math.max(0.15, dragState.current.startRatio + delta)));
    };
    const onUp = () => { dragState.current.dragging = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    if (!niftyRef.current || !rocRef.current || niftyBars.length < 2 || rocBars.length < 2) return;
    let removed = false;
    (async () => {
      const { createChart, CandlestickSeries, LineSeries, LineStyle, createSeriesMarkers } =
        await import("lightweight-charts");
      if (removed) return;

      const SCALE_W = 65;
      const LAYOUT = {
        layout:    { background: { color: "#ffffff" }, textColor: "#374151", fontFamily: "Inter,system-ui,sans-serif", fontSize: 11 },
        grid:      { vertLines: { color: "#f3f4f6", style: LineStyle.Solid }, horzLines: { color: "#f3f4f6", style: LineStyle.Solid } },
        crosshair: { mode: 1 },
        autoSize:  true,
      } as const;

      // ── Nifty chart (top) ──
      const niftyChart = createChart(niftyRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.06, bottom: 0 }, minimumWidth: SCALE_W },
        timeScale: { visible: false },
      });
      const niftySeries = niftyChart.addSeries(CandlestickSeries, {
        upColor: "#10b981", downColor: "#ef4444",
        borderUpColor: "#10b981", borderDownColor: "#ef4444",
        wickUpColor: "#10b981", wickDownColor: "#ef4444",
        priceLineVisible: false,
      });
      niftySeries.setData(niftyBars.map((b) => ({
        time: b.date as `${number}-${number}-${number}`,
        open: b.open, high: b.high, low: b.low, close: b.close,
      })));

      // Markers for overbought events on Nifty
      const obEvents = extremeEvents.filter((e) => e.type === "overbought");
      const osEvents = extremeEvents.filter((e) => e.type === "oversold");
      const niftyMarkers: Parameters<typeof createSeriesMarkers>[1] = [];
      for (const b of niftyBars) {
        if (obEvents.some((e) => b.date >= e.startDate && b.date <= e.endDate))
          niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "aboveBar", color: "#ef444460", shape: "circle", text: "", size: 0.5 });
        if (osEvents.some((e) => b.date >= e.startDate && b.date <= e.endDate))
          niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "belowBar", color: "#10b98160", shape: "circle", text: "", size: 0.5 });
        for (const e of obEvents)
          if (b.date === e.peakDate)
            niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "aboveBar", color: "#ef4444", shape: "arrowDown", text: "OB", size: 1 });
        for (const e of osEvents)
          if (b.date === e.peakDate)
            niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "belowBar", color: "#10b981", shape: "arrowUp", text: "OS", size: 1 });
      }
      if (niftyMarkers.length) createSeriesMarkers(niftySeries as Parameters<typeof createSeriesMarkers>[0], niftyMarkers);

      // ── ROC chart (bottom) ──
      const rocChart = createChart(rocRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0, bottom: 0.05 }, minimumWidth: SCALE_W },
        timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false },
      });

      const rocSeries = rocChart.addSeries(LineSeries, {
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
      });
      rocSeries.setData(rocBars.map((b) => ({
        time:  b.date as `${number}-${number}-${number}`,
        value: b.roc,
        color: b.roc >= 80 ? "#ef4444" : b.roc >= 30 ? "#f97316" : b.roc >= 0 ? "#3b82f6" : b.roc >= -25 ? "#f59e0b" : "#10b981",
      })));

      // Reference lines
      const REF_LINES = [
        { price: 80,  color: "#ef4444", title: "OB 80%  ",   style: LineStyle.Dashed },
        { price: 30,  color: "#f97316", title: "30%  ",       style: LineStyle.Dotted },
        { price: 0,   color: "#94a3b8", title: "0%  ",        style: LineStyle.Solid  },
        { price: -25, color: "#10b981", title: "OS -25%  ",   style: LineStyle.Dashed },
      ];
      for (const l of REF_LINES)
        rocSeries.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style, axisLabelVisible: true, title: l.title });

      // Markers on ROC chart
      const rocMarkers: Parameters<typeof createSeriesMarkers>[1] = [];
      for (const e of obEvents)
        rocMarkers.push({ time: e.peakDate as `${number}-${number}-${number}`, position: "aboveBar", color: "#ef4444", shape: "circle", text: "⚠", size: 1 });
      for (const e of osEvents)
        rocMarkers.push({ time: e.peakDate as `${number}-${number}-${number}`, position: "belowBar", color: "#10b981", shape: "circle", text: "●", size: 1 });
      if (rocMarkers.length) createSeriesMarkers(rocSeries as Parameters<typeof createSeriesMarkers>[0], rocMarkers);

      niftyChart.timeScale().fitContent();
      rocChart.timeScale().fitContent();

      // ── Sync ──
      let syncing = false;
      niftyChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; rocChart.timeScale().setVisibleRange(r); syncing = false;
      });
      rocChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; niftyChart.timeScale().setVisibleRange(r); syncing = false;
      });

      // ── Crosshair sync ──
      niftyChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) rocChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, rocSeries as any);
        else        rocChart.clearCrosshairPosition();
      });
      rocChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) niftyChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, niftySeries as any);
        else        niftyChart.clearCrosshairPosition();
      });

      cleanupRef.current = () => { niftyChart.remove(); rocChart.remove(); };
    })();
    return () => { removed = true; cleanupRef.current?.(); cleanupRef.current = null; };
  }, [niftyBars, rocBars, extremeEvents, currentRoc]);

  const DIVIDER_HIT = 9;
  const topH = `calc(${(splitRatio * 100).toFixed(3)}% - ${Math.ceil(DIVIDER_HIT / 2)}px)`;
  const botH = `calc(${((1 - splitRatio) * 100).toFixed(3)}% - ${Math.floor(DIVIDER_HIT / 2)}px)`;
  const rocColor = currentRoc >= 80 ? "#dc2626" : currentRoc >= 30 ? "#c2410c" : currentRoc >= 0 ? "#1d4ed8" : currentRoc >= -25 ? "#b45309" : "#047857";

  return (
    <div ref={containerRef} className="flex flex-col h-full select-none overflow-hidden" style={{ background: "#ffffff" }}>
      {/* ── Nifty pane ── */}
      <div className="relative flex-shrink-0" style={{ height: topH, overflow: "hidden" }}>
        <div ref={niftyRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>Nifty 50 · Monthly</span>
        </div>
      </div>
      {/* ── Hairline divider ── */}
      <div ref={dividerRef} className="relative flex-shrink-0 cursor-row-resize z-20"
        style={{ height: DIVIDER_HIT }}
        onMouseDown={(e) => { dragState.current = { dragging: true, startY: e.clientY, startRatio: splitRatio }; e.preventDefault(); }}>
        <div className="absolute left-0 right-0" style={{ top: "50%", height: 1, background: "#e5e7eb", transform: "translateY(-50%)" }} />
      </div>
      {/* ── ROC pane ── */}
      <div className="relative flex-shrink-0" style={{ height: botH, overflow: "hidden" }}>
        <div ref={rocRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10 flex items-center gap-2">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>ROC (18M)</span>
          <span className="text-[9px] font-black tabular-nums" style={{ color: rocColor }}>
            {currentRoc >= 0 ? "+" : ""}{currentRoc.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── ROC Full-screen Modal ────────────────────────────────────────────────────

const ROC_INDICES = [
  { key: "nifty50",     label: "Nifty 50"           },
  { key: "nifty500",    label: "Nifty 500"           },
  { key: "smallcap100", label: "Nifty SmallCap 100"  },
] as const;

function RocModal({ data: initialData, onClose }: { data: RocResponse; onClose: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState<"nifty50" | "nifty500" | "smallcap100">("nifty50");
  const { data: fetched, isLoading } = useSWR<RocResponse>(
    `/api/roc?index=${selectedIndex}`,
    fetcher,
    { fallbackData: selectedIndex === "nifty50" ? initialData : undefined, revalidateOnFocus: false },
  );
  const noData = !isLoading && fetched && !fetched.hasData;
  const data = (fetched?.hasData ? fetched : null) ?? initialData;
  const { niftyBars, rocBars, extremeEvents, summary, zone, signal, currentRoc, change, percentileRank } = data;
  const changeColor = change >= 0 ? "#ef4444" : "#10b981";

  const [obTab, setObTab] = useState<"ob80" | "ob30">("ob80");
  const [osTab, setOsTab] = useState<"os_25" | "os_10" | "os0">("os_25");
  const ob = summary[obTab];
  const os = summary[osTab];

  return (
    <motion.div className="fixed inset-0 z-50 flex flex-col bg-white overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}>

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-3 sm:px-6 py-3 flex items-center gap-3 sm:gap-5 border-b border-slate-100 flex-wrap"
        style={{ background: zone.bgColor }}>
        <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex flex-col items-center justify-center bg-white shadow-sm flex-shrink-0"
          style={{ border: `2px solid ${zone.color}45` }}>
          {isLoading ? (
            <div className="w-5 h-5 rounded-full border-2 border-slate-200 border-t-slate-500 animate-spin" />
          ) : (
            <>
              <span className="text-sm sm:text-base font-black leading-none tabular-nums" style={{ color: zone.color }}>
                {currentRoc >= 0 ? "+" : ""}{currentRoc.toFixed(0)}%
              </span>
              <span className="text-[8px] font-bold text-slate-400 mt-0.5 tracking-widest">ROC</span>
            </>
          )}
        </div>
        <div className="flex-1 min-w-0">
          {/* Index selector */}
          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
            {ROC_INDICES.map((idx) => (
              <button key={idx.key} onClick={() => setSelectedIndex(idx.key)}
                className="px-2 sm:px-2.5 py-1 rounded-lg text-[10px] sm:text-[11px] font-black transition-all"
                style={selectedIndex === idx.key
                  ? { background: zone.color, color: "#fff" }
                  : { background: "#f1f5f9", color: "#64748b" }}>
                {idx.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-base sm:text-lg font-black text-slate-900">18M Rate of Change</span>
            <span className="text-[11px] font-black px-2.5 py-0.5 rounded-full" style={{ background: zone.color, color: "#fff" }}>{zone.label}</span>
            <span className="text-sm font-bold tabular-nums" style={{ color: changeColor }}>
              {change >= 0 ? "+" : ""}{change.toFixed(2)} pts
            </span>
          </div>
          <p className="hidden sm:block text-xs text-slate-500 line-clamp-2">{signal.rationale}</p>
        </div>
        <div className="ml-auto flex items-center gap-2 sm:gap-4">
          <div className="hidden sm:block text-center">
            <p className="text-[8px] font-black tracking-widest uppercase text-slate-400 mb-1">Percentile</p>
            <p className="text-sm font-black" style={{ color: zone.color }}>{percentileRank}th</p>
          </div>
          <div className="hidden sm:block text-center">
            <p className="text-[8px] font-black tracking-widest uppercase text-slate-400 mb-1">Signal</p>
            <p className="text-sm font-black" style={{ color: zone.color }}>{signal.label}</p>
            <div className="flex items-center gap-1.5 mt-1 justify-center">
              <div className="w-20 h-1.5 rounded-full bg-white/60 overflow-hidden">
                <motion.div className="h-full rounded-full" style={{ background: zone.color }}
                  initial={{ width: 0 }} animate={{ width: `${signal.confidence}%` }}
                  transition={{ duration: 1.1, ease: "easeOut" }} />
              </div>
              <span className="text-[10px] font-black" style={{ color: zone.color }}>{signal.confidence}%</span>
            </div>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/80 text-slate-400 hover:text-slate-900 transition-all">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden min-h-0">

        {/* Chart */}
        <div className="h-[45vh] md:h-auto md:flex-1 flex-shrink-0 md:flex-shrink flex flex-col px-3 sm:px-5 pt-4 pb-3 min-w-0">
          <p className="text-[10px] font-black tracking-widest uppercase text-slate-400 mb-3 flex-shrink-0">
            {ROC_INDICES.find((i) => i.key === selectedIndex)?.label ?? "Nifty 50"} × 18M ROC · Monthly · Extreme Zone Analysis
          </p>
          <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-slate-100 relative">
            {(isLoading || noData) && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm gap-2">
                {isLoading ? (
                  <div className="w-6 h-6 rounded-full border-2 border-slate-200 border-t-slate-600 animate-spin" />
                ) : (
                  <>
                    <p className="text-sm font-black text-slate-500">No data available</p>
                    <p className="text-xs text-slate-400">Fetching historical data — check back shortly</p>
                  </>
                )}
              </div>
            )}
            <RocSplitChart
              niftyBars={niftyBars}
              rocBars={rocBars}
              extremeEvents={extremeEvents}
              currentRoc={currentRoc}
            />
          </div>

          {/* Zone legend */}
          <div className="flex-shrink-0 mt-2 flex gap-1.5 sm:gap-3 flex-wrap">
            {[
              { label: "< -25%", sub: "Extreme Bear", color: "#10b981" },
              { label: "-25–0%", sub: "Weak / Neg", color: "#f59e0b" },
              { label: "0–30%",  sub: "Moderate",   color: "#3b82f6" },
              { label: "30–80%", sub: "Strong Bull", color: "#f97316" },
              { label: "> 80%",  sub: "Extreme Bull",color: "#ef4444" },
            ].map((z) => (
              <div key={z.label} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg"
                style={{ background: z.color + "12", border: `1px solid ${z.color}30` }}>
                <div className="w-2 h-2 rounded-full" style={{ background: z.color }} />
                <span className="text-[9px] font-black" style={{ color: z.color }}>{z.label}</span>
                <span className="text-[9px] text-slate-400">{z.sub}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div className="w-full md:w-72 flex-shrink-0 border-t md:border-t-0 md:border-l border-slate-100 bg-slate-50/40 flex flex-col overflow-y-auto">

          {/* ROC gauge */}
          <div className="p-4 border-b border-slate-100">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2">18M ROC Gauge</p>
            <div className="relative h-3 rounded-full overflow-hidden flex">
              <div style={{ width: "20%", background: "#10b981" }} />
              <div style={{ width: "15%", background: "#f59e0b" }} />
              <div style={{ width: "20%", background: "#3b82f6" }} />
              <div style={{ width: "25%", background: "#f97316" }} />
              <div style={{ width: "20%", background: "#ef4444" }} />
            </div>
            <div className="flex justify-between text-[8px] text-slate-400 mt-1 font-bold">
              <span>-25%</span><span>0%</span><span>30%</span><span>80%</span><span>100%+</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs font-black" style={{ color: zone.color }}>
                {currentRoc >= 0 ? "+" : ""}{currentRoc.toFixed(1)}%
              </span>
              <span className="text-[9px] text-slate-400 font-bold">{percentileRank}th percentile</span>
            </div>
          </div>

          {/* Overbought outcome engine */}
          <div className="p-4 border-b border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[9px] font-black tracking-widest uppercase" style={{ color: "#ef4444" }}>
                After ROC · Forward Returns
              </p>
              <div className="flex gap-1">
                {(["ob80", "ob30"] as const).map((key) => (
                  <button key={key} onClick={() => setObTab(key)}
                    className="text-[8px] font-black px-2 py-0.5 rounded-full transition-all"
                    style={{
                      background: obTab === key ? "#ef4444" : "#ef444415",
                      color:      obTab === key ? "#fff"     : "#ef4444",
                    }}>
                    {key === "ob80" ? ">80%" : ">30%"}
                  </button>
                ))}
              </div>
            </div>
            {ob ? (
              <>
                <div className="space-y-2.5">
                  <WinRateBar wr={ob.winRate3m}  avg={ob.avgRet3m}  label="3 Months"  />
                  <WinRateBar wr={ob.winRate6m}  avg={ob.avgRet6m}  label="6 Months"  />
                  <WinRateBar wr={ob.winRate12m} avg={ob.avgRet12m} label="12 Months" />
                  <WinRateBar wr={ob.winRate18m} avg={ob.avgRet18m} label="18 Months" />
                </div>
                <div className="mt-2.5 pt-2 border-t border-slate-100">
                  <p className="text-[9px] text-slate-400">
                    <span className="font-black text-slate-600">{ob.totalEvents} events</span> · Avg max drawdown{" "}
                    <span className="font-black" style={{ color: "#ef4444" }}>{ob.avgMaxDrawdown.toFixed(1)}%</span>
                  </p>
                </div>
              </>
            ) : (
              <p className="text-[9px] text-slate-400">No events at this threshold yet.</p>
            )}
          </div>

          {/* Oversold outcome engine */}
          <div className="p-4 border-b border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[9px] font-black tracking-widest uppercase" style={{ color: "#10b981" }}>
                After ROC · Forward Returns
              </p>
              <div className="flex gap-1">
                {(["os_25", "os_10", "os0"] as const).map((key) => (
                  <button key={key} onClick={() => setOsTab(key)}
                    className="text-[8px] font-black px-2 py-0.5 rounded-full transition-all"
                    style={{
                      background: osTab === key ? "#10b981" : "#10b98115",
                      color:      osTab === key ? "#fff"     : "#10b981",
                    }}>
                    {key === "os_25" ? "<-25%" : key === "os_10" ? "<-10%" : "<0%"}
                  </button>
                ))}
              </div>
            </div>
            {os ? (
              <>
                <div className="space-y-2.5">
                  <WinRateBar wr={os.winRate3m}  avg={os.avgRet3m}  label="3 Months"  />
                  <WinRateBar wr={os.winRate6m}  avg={os.avgRet6m}  label="6 Months"  />
                  <WinRateBar wr={os.winRate12m} avg={os.avgRet12m} label="12 Months" />
                  <WinRateBar wr={os.winRate18m} avg={os.avgRet18m} label="18 Months" />
                </div>
                <div className="mt-2.5 pt-2 border-t border-slate-100">
                  <p className="text-[9px] text-slate-400">
                    <span className="font-black text-slate-600">{os.totalEvents} events</span> · Avg max drawdown{" "}
                    <span className="font-black" style={{ color: "#ef4444" }}>{os.avgMaxDrawdown.toFixed(1)}%</span>
                  </p>
                </div>
              </>
            ) : (
              <p className="text-[9px] text-slate-400">No events at this threshold yet.</p>
            )}
          </div>

          {/* All events list */}
          <div className="p-4">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2.5">
              All Extreme Events ({extremeEvents.length})
            </p>
            <div className="space-y-1.5 max-h-80 overflow-y-auto pr-0.5">
              {[...extremeEvents].reverse().map((e, i) => {
                const isOB = e.type === "overbought";
                const c    = isOB ? "#ef4444" : "#10b981";
                return (
                  <div key={i} className="rounded-lg px-2.5 py-2" style={{ background: c + "08", border: `1px solid ${c}20` }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[9px] font-black" style={{ color: c }}>
                        {e.startDate.slice(0, 7)} → {e.endDate.slice(0, 7)}
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-[8px] font-black px-1.5 py-0.5 rounded" style={{ background: c + "20", color: c }}>
                          {isOB ? "OB" : "OS"}
                        </span>
                        <span className="text-[8px] text-slate-400 font-bold">
                          {e.duration}mo · {e.kind === "sustained" ? "Sus" : "Brief"}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-3 text-[8px] text-slate-500 flex-wrap">
                      <span>Peak <span className="font-black" style={{ color: c }}>
                        {isOB ? "+" : ""}{e.peakRoc.toFixed(1)}%
                      </span></span>
                      {e.ret6m  !== null && <span>6M <span className="font-bold">{e.ret6m  >= 0 ? "+" : ""}{e.ret6m}%</span></span>}
                      {e.ret12m !== null && <span>12M <span className="font-bold">{e.ret12m >= 0 ? "+" : ""}{e.ret12m}%</span></span>}
                      {e.ret18m !== null && <span>18M <span className="font-bold">{e.ret18m >= 0 ? "+" : ""}{e.ret18m}%</span></span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Analyst note */}
          <div className="px-4 pb-4 mt-auto">
            <div className="rounded-xl p-3" style={{ background: zone.bgColor, border: `1px solid ${zone.color}30` }}>
              <p className="text-[9px] font-black tracking-widest uppercase mb-1.5" style={{ color: zone.color }}>
                Interpretation
              </p>
              <p className="text-[10px] text-slate-600 leading-relaxed">
                18M ROC measures how much Nifty moved over the past 18 months.
                When it exceeds <span className="font-bold">+80%</span>, markets have priced in a lot of good news —
                historically a zone of elevated mean-reversion risk.
                Below <span className="font-bold">-25%</span>, fear is extreme and often marks a multi-year buying opportunity.
                Current reading of <span className="font-bold" style={{ color: zone.color }}>
                  {currentRoc >= 0 ? "+" : ""}{currentRoc.toFixed(1)}%
                </span> puts Nifty in the <span className="font-bold" style={{ color: zone.color }}>{zone.label}</span> zone ({percentileRank}th percentile historically).
              </p>
            </div>
          </div>

        </div>
      </div>
    </motion.div>
  );
}

// ─── ROC Intelligence Card (compact) ─────────────────────────────────────────

function RocIntelligenceCard() {
  const { data } = useSWR<RocResponse>("/api/roc", fetcher, { refreshInterval: 600_000 });
  const [modalOpen, setModalOpen] = useState(false);

  if (!data) return null;
  if (!data.hasData) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 px-4 py-3 flex items-center gap-3 text-sm text-slate-400 bg-white">
        <TrendingUp size={14} />
        <span>ROC data unavailable</span>
      </div>
    );
  }

  const { zone, signal, currentRoc, change, summary, percentileRank } = data;
  const changeColor = change >= 0 ? "#ef4444" : "#10b981";
  const ob = summary.ob80;

  return (
    <>
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {modalOpen && <RocModal data={data} onClose={() => setModalOpen(false)} />}
        </AnimatePresence>,
        document.body
      )}

      <motion.button onClick={() => setModalOpen(true)}
        className="w-full rounded-xl text-left overflow-hidden bg-white shadow-sm"
        style={{ border: `1.5px solid ${zone.color}35` }}
        whileHover={{ scale: 1.004, boxShadow: `0 4px 20px ${zone.color}18` }}
        transition={{ duration: 0.15 }}>

        <div className="px-5 py-4 flex items-center gap-5 flex-wrap">
          {/* Icon */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: zone.bgColor, border: `1px solid ${zone.color}40` }}>
              <TrendingUp size={16} style={{ color: zone.color }} />
            </div>
            <div>
              <p className="text-[8px] font-black tracking-widest uppercase text-slate-400">18M ROC · Nifty 50</p>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span className="text-xl font-black tabular-nums leading-none" style={{ color: zone.color }}>
                  {currentRoc >= 0 ? "+" : ""}{currentRoc.toFixed(1)}%
                </span>
                <span className="text-[10px] font-bold tabular-nums" style={{ color: changeColor }}>
                  {change >= 0 ? "+" : ""}{change.toFixed(1)}
                </span>
              </div>
            </div>
          </div>

          {/* Zone + percentile */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-black px-2 py-0.5 rounded-full w-fit"
              style={{ background: zone.color + "20", color: zone.color }}>{zone.label}</span>
            <span className="text-[9px] text-slate-400 pl-0.5">{percentileRank}th percentile</span>
          </div>

          {/* Signal */}
          <div className="flex flex-col gap-0.5">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400">Signal</p>
            <p className="text-xs font-black" style={{ color: zone.color }}>{signal.label}</p>
            <p className="text-[9px] text-slate-400 max-w-[160px] leading-snug">{signal.signal}</p>
          </div>

          {/* OB stats if available */}
          {ob && (
            <div className="flex-shrink-0 px-3 py-1.5 rounded-lg border"
              style={{ borderColor: "#ef444430", background: "#ef444408" }}>
              <p className="text-[8px] font-black text-slate-400 mb-0.5">{ob.totalEvents} OB events · 18M avg</p>
              <p className="text-xs font-black tabular-nums"
                style={{ color: ob.avgRet18m >= 0 ? "#10b981" : "#ef4444" }}>
                {ob.avgRet18m >= 0 ? "+" : ""}{ob.avgRet18m}%
              </p>
            </div>
          )}

          {zone.label === "Extreme Bull" && (
            <div className="flex-shrink-0 px-3 py-1.5 rounded-lg border border-red-200 bg-red-50">
              <p className="text-[9px] font-black text-red-600">⚠ ROC &gt; 80% Active</p>
            </div>
          )}

          {/* Zone bar */}
          <div className="w-full h-1.5 rounded-full overflow-hidden flex mt-1">
            <div style={{ width: "20%", background: "#10b981" }} />
            <div style={{ width: "15%", background: "#f59e0b" }} />
            <div style={{ width: "20%", background: "#3b82f6" }} />
            <div style={{ width: "25%", background: "#f97316", opacity: zone.label === "Strong Bull" ? 1 : 0.4 }} />
            <div style={{ width: "20%", background: "#ef4444", opacity: zone.label === "Extreme Bull" ? 1 : 0.3 }} />
          </div>
        </div>
      </motion.button>
    </>
  );
}

// ─── BB Split Chart ───────────────────────────────────────────────────────────

const BB_INDICES = [
  { key: "nifty50",     label: "Nifty 50"           },
  { key: "nifty500",    label: "Nifty 500"           },
  { key: "smallcap100", label: "Nifty SmallCap 100"  },
] as const;

function BbSplitChart({ niftyBars, bbBars, touchEvents, currentPercentB }: {
  niftyBars:      BbResponse["niftyBars"];
  bbBars:         BbResponse["bbBars"];
  touchEvents:    BbTouchEvent[];
  currentPercentB: number;
}) {
  const niftyRef     = useRef<HTMLDivElement>(null);
  const pbRef        = useRef<HTMLDivElement>(null);
  const dividerRef   = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef   = useRef<(() => void) | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.65);
  const dragState = useRef({ dragging: false, startY: 0, startRatio: 0.65 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.dragging || !containerRef.current) return;
      const rect  = containerRef.current.getBoundingClientRect();
      const delta = (e.clientY - dragState.current.startY) / rect.height;
      setSplitRatio(Math.min(0.85, Math.max(0.15, dragState.current.startRatio + delta)));
    };
    const onUp = () => { dragState.current.dragging = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    if (!niftyRef.current || !pbRef.current || niftyBars.length < 2 || bbBars.length < 2) return;
    let removed = false;
    (async () => {
      const { createChart, CandlestickSeries, LineSeries, LineStyle, createSeriesMarkers } =
        await import("lightweight-charts");
      if (removed) return;

      const SCALE_W = 65;
      const LAYOUT = {
        layout:    { background: { color: "#ffffff" }, textColor: "#374151", fontFamily: "Inter,system-ui,sans-serif", fontSize: 11 },
        grid:      { vertLines: { color: "#f3f4f6", style: LineStyle.Solid }, horzLines: { color: "#f3f4f6", style: LineStyle.Solid } },
        crosshair: { mode: 1 },
        autoSize:  true,
      } as const;

      // ── Nifty chart (top) — candlesticks + BB bands ──
      const niftyChart = createChart(niftyRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.06, bottom: 0.02 }, minimumWidth: SCALE_W },
        timeScale: { visible: false },
      });

      const niftySeries = niftyChart.addSeries(CandlestickSeries, {
        upColor: "#10b981", downColor: "#ef4444",
        borderUpColor: "#10b981", borderDownColor: "#ef4444",
        wickUpColor: "#10b981", wickDownColor: "#ef4444",
        priceLineVisible: false,
      });
      niftySeries.setData(niftyBars.map((b) => ({
        time: b.date as `${number}-${number}-${number}`,
        open: b.open, high: b.high, low: b.low, close: b.close,
      })));

      // BB bands
      const upperSeries = niftyChart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const midSeries   = niftyChart.addSeries(LineSeries, { color: "#94a3b8", lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const lowerSeries = niftyChart.addSeries(LineSeries, { color: "#10b981", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

      upperSeries.setData(bbBars.map((b) => ({ time: b.date as `${number}-${number}-${number}`, value: b.upper })));
      midSeries.setData(bbBars.map((b) => ({ time: b.date as `${number}-${number}-${number}`, value: b.middle })));
      lowerSeries.setData(bbBars.map((b) => ({ time: b.date as `${number}-${number}-${number}`, value: b.lower })));

      // Touch event markers on price chart
      const touchDates = new Set(touchEvents.map((e) => e.date));
      const niftyMarkers: Parameters<typeof createSeriesMarkers>[1] = [];
      for (const b of niftyBars) {
        if (touchDates.has(b.date))
          niftyMarkers.push({ time: b.date as `${number}-${number}-${number}`, position: "belowBar", color: "#10b981", shape: "arrowUp", text: "BB Touch", size: 1.2 });
      }
      if (niftyMarkers.length) createSeriesMarkers(niftySeries as Parameters<typeof createSeriesMarkers>[0], niftyMarkers);

      // ── %B chart (bottom) ──
      const pbChart = createChart(pbRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: SCALE_W },
        timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false },
      });

      const pbSeries = pbChart.addSeries(LineSeries, {
        lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      });
      pbSeries.setData(bbBars.map((b) => ({
        time:  b.date as `${number}-${number}-${number}`,
        value: parseFloat((b.percentB * 100).toFixed(2)),
        color: b.percentB <= 0 ? "#10b981" : b.percentB < 20 ? "#f59e0b" : b.percentB > 100 ? "#ef4444" : b.percentB > 80 ? "#f97316" : "#3b82f6",
      })));

      // Reference lines on %B chart
      for (const { price, color, title, style } of [
        { price: 100, color: "#f59e0b", title: "Upper BB  ", style: LineStyle.Dashed },
        { price: 50,  color: "#94a3b8", title: "Mid  ",      style: LineStyle.Dotted },
        { price: 0,   color: "#10b981", title: "Lower BB  ", style: LineStyle.Solid  },
      ]) pbSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });

      // Touch markers on %B chart
      const pbMarkers: Parameters<typeof createSeriesMarkers>[1] = [];
      for (const e of touchEvents)
        pbMarkers.push({ time: e.date as `${number}-${number}-${number}`, position: "belowBar", color: "#10b981", shape: "circle", text: "▲", size: 1.2 });
      if (pbMarkers.length) createSeriesMarkers(pbSeries as Parameters<typeof createSeriesMarkers>[0], pbMarkers);

      niftyChart.timeScale().fitContent();
      pbChart.timeScale().fitContent();

      // ── Sync ──
      let syncing = false;
      niftyChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; pbChart.timeScale().setVisibleRange(r); syncing = false;
      });
      pbChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; niftyChart.timeScale().setVisibleRange(r); syncing = false;
      });
      niftyChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) pbChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, pbSeries as any);
        else        pbChart.clearCrosshairPosition();
      });
      pbChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) niftyChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, niftySeries as any);
        else        niftyChart.clearCrosshairPosition();
      });

      cleanupRef.current = () => { niftyChart.remove(); pbChart.remove(); };
    })();
    return () => { removed = true; cleanupRef.current?.(); cleanupRef.current = null; };
  }, [niftyBars, bbBars, touchEvents, currentPercentB]);

  const DIVIDER_HIT = 9;
  const topH = `calc(${(splitRatio * 100).toFixed(3)}% - ${Math.ceil(DIVIDER_HIT / 2)}px)`;
  const botH = `calc(${((1 - splitRatio) * 100).toFixed(3)}% - ${Math.floor(DIVIDER_HIT / 2)}px)`;
  const pbPct = (currentPercentB * 100).toFixed(1);
  const pbColor = currentPercentB <= 0 ? "#059669" : currentPercentB < 0.2 ? "#d97706" : "#3b82f6";

  return (
    <div ref={containerRef} className="flex flex-col h-full select-none overflow-hidden" style={{ background: "#ffffff" }}>
      <div className="relative flex-shrink-0" style={{ height: topH, overflow: "hidden" }}>
        <div ref={niftyRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10 flex items-center gap-3">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>Monthly · BB(20,2)</span>
          <span className="text-[9px] font-bold" style={{ color: "#f59e0b" }}>— Upper</span>
          <span className="text-[9px] font-bold" style={{ color: "#94a3b8" }}>- - Mid</span>
          <span className="text-[9px] font-bold" style={{ color: "#10b981" }}>— Lower</span>
        </div>
      </div>
      <div ref={dividerRef} className="relative flex-shrink-0 cursor-row-resize z-20"
        style={{ height: DIVIDER_HIT }}
        onMouseDown={(e) => { dragState.current = { dragging: true, startY: e.clientY, startRatio: splitRatio }; e.preventDefault(); }}>
        <div className="absolute left-0 right-0" style={{ top: "50%", height: 1, background: "#e5e7eb", transform: "translateY(-50%)" }} />
      </div>
      <div className="relative flex-shrink-0" style={{ height: botH, overflow: "hidden" }}>
        <div ref={pbRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10 flex items-center gap-2">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>%B</span>
          <span className="text-[9px] font-black tabular-nums" style={{ color: pbColor }}>{pbPct}%</span>
        </div>
      </div>
    </div>
  );
}

// ─── BB Modal ─────────────────────────────────────────────────────────────────

function BbModal({ data: initialData, onClose }: { data: BbResponse; onClose: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState<BbResponse["indexKey"]>("nifty50");
  const { data: fetched, isLoading } = useSWR<BbResponse>(
    `/api/bb?index=${selectedIndex}`,
    fetcher,
    { fallbackData: selectedIndex === "nifty50" ? initialData : undefined, revalidateOnFocus: false },
  );
  const noData = !isLoading && fetched && !fetched.hasData;
  const data   = (fetched?.hasData ? fetched : null) ?? initialData;
  const { niftyBars, bbBars, touchEvents, summary, currentPercentB, currentClose, currentLower, isTouching, isNearLower, lastTouchDate, indexLabel } = data;

  const pbColor = isTouching ? "#059669" : isNearLower ? "#d97706" : "#3b82f6";
  const pbLabel = isTouching ? "At Lower BB — Thesis Active" : isNearLower ? "Near Lower BB" : "Normal Range";

  return (
    <motion.div className="fixed inset-0 z-50 flex flex-col bg-white overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}>

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-3 sm:px-6 py-3 flex items-center gap-3 sm:gap-5 border-b border-slate-100 flex-wrap"
        style={{ background: isTouching ? "#f0fdf4" : isNearLower ? "#fffbeb" : "#f8fafc" }}>

        {/* Thesis badge */}
        <div className="flex-shrink-0">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex flex-col items-center justify-center shadow-sm bg-white"
            style={{ border: `2px solid ${pbColor}45` }}>
            {isLoading ? (
              <div className="w-5 h-5 rounded-full border-2 border-slate-200 border-t-slate-500 animate-spin" />
            ) : (
              <>
                <span className="text-xs font-black leading-none tabular-nums" style={{ color: pbColor }}>
                  {(currentPercentB * 100).toFixed(0)}%
                </span>
                <span className="text-[8px] font-bold text-slate-400 mt-0.5 tracking-wide">%B</span>
              </>
            )}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          {/* Index selector */}
          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
            {BB_INDICES.map((idx) => (
              <button key={idx.key} onClick={() => setSelectedIndex(idx.key)}
                className="px-2 sm:px-2.5 py-1 rounded-lg text-[10px] sm:text-[11px] font-black transition-all"
                style={selectedIndex === idx.key
                  ? { background: pbColor, color: "#fff" }
                  : { background: "#f1f5f9", color: "#64748b" }}>
                {idx.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-base sm:text-lg font-black text-slate-900">Lower BB Thesis</span>
            <span className="text-[11px] font-black px-2.5 py-0.5 rounded-full"
              style={{ background: pbColor, color: "#fff" }}>{pbLabel}</span>
          </div>
          <p className="hidden sm:block text-xs text-slate-500">
            Every lower Bollinger Band touch on monthly TF → {indexLabel} higher 18M+ later.
            {lastTouchDate && ` Last touch: ${lastTouchDate.slice(0, 7)}.`}
          </p>
        </div>

        {/* Thesis headline */}
        <div className="flex-shrink-0 text-center px-3 sm:px-4 py-2 rounded-xl"
          style={{ background: "#10b98115", border: "1px solid #10b98130" }}>
          <p className="text-[8px] font-black tracking-widest uppercase text-slate-400 mb-0.5">18M Win</p>
          <p className="text-xl sm:text-2xl font-black leading-none" style={{ color: "#10b981" }}>{summary.winRate18m}%</p>
          <p className="text-[9px] text-slate-400 mt-0.5">{summary.totalEvents} events</p>
        </div>

        <button onClick={onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/80 text-slate-400 hover:text-slate-900 transition-all flex-shrink-0">
          <X size={16} />
        </button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden min-h-0">

        {/* Chart */}
        <div className="h-[45vh] md:h-auto md:flex-1 flex-shrink-0 md:flex-shrink flex flex-col px-3 sm:px-5 pt-4 pb-3 min-w-0">
          <p className="text-[10px] font-black tracking-widest uppercase text-slate-400 mb-3 flex-shrink-0">
            {indexLabel} · Monthly · Bollinger Bands (20, 2) · Lower BB Touch Analysis
          </p>
          <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-slate-100 relative">
            {(isLoading || noData) && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm gap-2">
                {isLoading
                  ? <div className="w-6 h-6 rounded-full border-2 border-slate-200 border-t-slate-600 animate-spin" />
                  : <>
                      <p className="text-sm font-black text-slate-500">Insufficient data</p>
                      <p className="text-xs text-slate-400">Need 20+ monthly bars to compute BB</p>
                    </>
                }
              </div>
            )}
            <BbSplitChart
              niftyBars={niftyBars}
              bbBars={bbBars}
              touchEvents={touchEvents}
              currentPercentB={currentPercentB}
            />
          </div>

          {/* Band legend */}
          <div className="flex-shrink-0 mt-2 flex items-center gap-2 sm:gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-0.5" style={{ background: "#f59e0b" }} />
              <span className="text-[9px] text-slate-500 font-bold">Upper BB</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-0.5 border-t border-dashed" style={{ borderColor: "#94a3b8" }} />
              <span className="text-[9px] text-slate-500 font-bold">SMA(20)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-0.5" style={{ background: "#10b981" }} />
              <span className="text-[9px] text-slate-500 font-bold">Lower BB — thesis trigger</span>
            </div>
            <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded" style={{ background: "#f0fdf4", border: "1px solid #10b98130" }}>
              <span className="text-[9px] font-black" style={{ color: "#10b981" }}>▲ BB Touch</span>
              <span className="text-[9px] text-slate-400">= historical buy signal</span>
            </div>
          </div>
        </div>

        {/* ── Right panel ── */}
        <div className="w-full md:w-72 flex-shrink-0 border-t md:border-t-0 md:border-l border-slate-100 bg-slate-50/40 flex flex-col overflow-y-auto">

          {/* Thesis scorecard */}
          <div className="p-4 border-b border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[9px] font-black tracking-widest uppercase text-slate-400">Thesis Scorecard</p>
              <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                {summary.totalEvents} events
              </span>
            </div>
            <div className="space-y-2.5">
              <WinRateBar wr={summary.winRate3m}  avg={summary.avgRet3m}  label="3 Months"  />
              <WinRateBar wr={summary.winRate6m}  avg={summary.avgRet6m}  label="6 Months"  />
              <WinRateBar wr={summary.winRate12m} avg={summary.avgRet12m} label="12 Months" />
              <WinRateBar wr={summary.winRate18m} avg={summary.avgRet18m} label="18 Months" />
            </div>
            <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between">
              <span className="text-[9px] text-slate-400 font-bold">Avg max drawdown after touch</span>
              <span className="text-[10px] font-black" style={{ color: "#ef4444" }}>{summary.avgMaxDrawdown.toFixed(1)}%</span>
            </div>
          </div>

          {/* Current position */}
          <div className="p-4 border-b border-slate-100">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2">Current Position</p>
            <div className="relative h-3 rounded-full overflow-hidden bg-slate-100 mb-1">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${Math.max(0, Math.min(100, currentPercentB * 100)).toFixed(1)}%`, background: pbColor }} />
            </div>
            <div className="flex justify-between text-[8px] text-slate-400 font-bold mb-2">
              <span>Lower BB</span><span>Mid</span><span>Upper BB</span>
            </div>
            <div className="rounded-lg px-2.5 py-2" style={{ background: pbColor + "10", border: `1px solid ${pbColor}30` }}>
              <p className="text-[9px] font-black" style={{ color: pbColor }}>{pbLabel}</p>
              <p className="text-[9px] text-slate-500 mt-0.5">
                Close: <span className="font-bold">{currentClose.toLocaleString("en-IN")}</span>
                {" · "}Lower BB: <span className="font-bold">{currentLower.toLocaleString("en-IN")}</span>
              </p>
            </div>
          </div>

          {/* Historical touch events */}
          <div className="p-4">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2.5">
              All Lower BB Touches ({touchEvents.length})
            </p>
            {touchEvents.length === 0 ? (
              <p className="text-[10px] text-slate-400 italic">No touches detected in available data window</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {[...touchEvents].reverse().map((e, i) => (
                  <div key={i} className="rounded-lg px-2.5 py-2.5"
                    style={{ background: "#10b98108", border: "1px solid #10b98125" }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-black text-slate-700">{e.date.slice(0, 7)}</span>
                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded"
                        style={{ background: "#10b98120", color: "#059669" }}>
                        %B {(e.percentB * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
                      {[
                        { label: "3M",  val: e.ret3m  },
                        { label: "6M",  val: e.ret6m  },
                        { label: "12M", val: e.ret12m },
                        { label: "18M", val: e.ret18m },
                      ].map(({ label, val }) => (
                        <div key={label} className="flex items-center justify-between">
                          <span className="text-slate-400 font-bold">{label}</span>
                          {val !== null ? (
                            <span className="font-black" style={{ color: val >= 0 ? "#10b981" : "#ef4444" }}>
                              {val >= 0 ? "+" : ""}{val}%
                            </span>
                          ) : <span className="text-slate-300 font-bold">—</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Interpretation */}
          <div className="px-4 pb-4 mt-auto">
            <div className="rounded-xl p-3" style={{ background: "#f0fdf4", border: "1px solid #10b98130" }}>
              <p className="text-[9px] font-black tracking-widest uppercase mb-1.5" style={{ color: "#10b981" }}>
                The Thesis
              </p>
              <p className="text-[10px] text-slate-600 leading-relaxed">
                When {indexLabel} closes at or below the monthly Lower Bollinger Band,
                sentiment is typically <span className="font-bold italic">"markets can&apos;t recover"</span>.
                Yet historically, <span className="font-black" style={{ color: "#10b981" }}>{summary.winRate18m}% of the time</span>,
                {" "}markets were significantly higher within 18 months.
                Whatever happens this quarter — the 18M+ outlook favours the bulls.
              </p>
            </div>
          </div>

        </div>
      </div>
    </motion.div>
  );
}

// ─── Breadth Split Chart (lightweight-charts dual pane) ──────────────────────

function BreadthSplitChart({ nifty100Bars, adBars }: {
  nifty100Bars: BreadthResponse["nifty100Bars"];
  adBars:       AdBar[];
}) {
  const niftyRef     = useRef<HTMLDivElement>(null);
  const adRef        = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef   = useRef<(() => void) | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.62);
  const dragState = useRef({ dragging: false, startY: 0, startRatio: 0.62 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.dragging || !containerRef.current) return;
      const rect  = containerRef.current.getBoundingClientRect();
      const delta = (e.clientY - dragState.current.startY) / rect.height;
      setSplitRatio(Math.min(0.85, Math.max(0.15, dragState.current.startRatio + delta)));
    };
    const onUp = () => { dragState.current.dragging = false; };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // Aggregate daily A/D bars → monthly: sum advances & declines per month, ratio = sumAdv / max(sumDec,1)
  const monthlyAdBars = useMemo(() => {
    type M = { key: string; advances: number; declines: number };
    const map = new Map<string, M>();
    for (const b of adBars) {
      const key = b.date.slice(0, 7) + "-01";
      const m   = map.get(key);
      if (m) { m.advances += b.advances; m.declines += b.declines; }
      else   map.set(key, { key, advances: b.advances, declines: b.declines });
    }
    return Array.from(map.values())
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((m) => ({ date: m.key, ratio: parseFloat((m.advances / Math.max(m.declines, 1)).toFixed(3)) }));
  }, [adBars]);

  useEffect(() => {
    if (!niftyRef.current || !adRef.current || nifty100Bars.length < 2 || monthlyAdBars.length < 2) return;
    let removed = false;

    (async () => {
      const { createChart, CandlestickSeries, LineSeries, LineStyle } =
        await import("lightweight-charts");
      if (removed) return;

      const SCALE_W = 62;
      const LAYOUT = {
        layout:    { background: { color: "#ffffff" }, textColor: "#374151", fontFamily: "Inter,system-ui,sans-serif", fontSize: 11 },
        grid:      { vertLines: { color: "#f8fafc", style: LineStyle.Solid }, horzLines: { color: "#f3f4f6", style: LineStyle.Solid } },
        crosshair: { mode: 1 },
        autoSize:  true,
      } as const;

      // ── Top: Nifty 100 monthly candlesticks ──
      const niftyChart = createChart(niftyRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.06, bottom: 0.02 }, minimumWidth: SCALE_W },
        timeScale: { visible: false },
      });

      const niftySeries = niftyChart.addSeries(CandlestickSeries, {
        upColor: "#10b981", downColor: "#ef4444",
        borderUpColor: "#10b981", borderDownColor: "#ef4444",
        wickUpColor: "#10b981", wickDownColor: "#ef4444",
        priceLineVisible: false,
      });
      niftySeries.setData(nifty100Bars.map((b) => ({
        time: b.date as `${number}-${number}-${number}`,
        open: b.open, high: b.high, low: b.low, close: b.close,
      })));


      // ── Bottom: A/D Ratio monthly line (same time axis as top pane) ──
      const adChart = createChart(adRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: SCALE_W },
        timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false },
      });

      const adLineSeries = adChart.addSeries(LineSeries, {
        color: "#6366f1", lineWidth: 2,
        priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      });
      adLineSeries.setData(monthlyAdBars.map((b) => ({
        time:  b.date as `${number}-${number}-${number}`,
        value: b.ratio,
      })));

      // Zone reference lines
      for (const { price, color, title, style } of [
        { price: 1.5, color: "#059669", title: "Strong Bull  ", style: LineStyle.Dashed },
        { price: 1.3, color: "#10b981", title: "Bull  ",        style: LineStyle.Dashed },
        { price: 1.0, color: "#94a3b8", title: "Neutral  ",     style: LineStyle.Dotted },
        { price: 0.8, color: "#ef4444", title: "Bear  ",        style: LineStyle.Solid  },
      ]) adLineSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });

      niftyChart.timeScale().fitContent();
      adChart.timeScale().fitContent();

      // ── Sync: both charts share identical monthly time points → ranges map 1:1 ──
      let syncing = false;
      niftyChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; adChart.timeScale().setVisibleRange(r); syncing = false;
      });
      adChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; niftyChart.timeScale().setVisibleRange(r); syncing = false;
      });
      niftyChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) adChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, adLineSeries as any);
        else        adChart.clearCrosshairPosition();
      });
      adChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) niftyChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, niftySeries as any);
        else        niftyChart.clearCrosshairPosition();
      });

      cleanupRef.current = () => { niftyChart.remove(); adChart.remove(); };
    })();

    return () => { removed = true; cleanupRef.current?.(); cleanupRef.current = null; };
  }, [nifty100Bars, monthlyAdBars]);

  const DIVIDER_HIT = 9;
  const topH = `calc(${(splitRatio * 100).toFixed(3)}% - ${Math.ceil(DIVIDER_HIT / 2)}px)`;
  const botH = `calc(${((1 - splitRatio) * 100).toFixed(3)}% - ${Math.floor(DIVIDER_HIT / 2)}px)`;

  return (
    <div ref={containerRef} className="flex flex-col h-full select-none overflow-hidden bg-white">
      <div className="relative flex-shrink-0" style={{ height: topH, overflow: "hidden" }}>
        <div ref={niftyRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>
            Nifty 100 · Monthly
          </span>
        </div>
      </div>
      <div className="relative flex-shrink-0 cursor-row-resize z-20" style={{ height: DIVIDER_HIT }}
        onMouseDown={(e) => { dragState.current = { dragging: true, startY: e.clientY, startRatio: splitRatio }; e.preventDefault(); }}>
        <div className="absolute left-0 right-0" style={{ top: "50%", height: 1, background: "#e5e7eb", transform: "translateY(-50%)" }} />
      </div>
      <div className="relative flex-shrink-0" style={{ height: botH, overflow: "hidden" }}>
        <div ref={adRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>A/D Ratio · Monthly</span>
        </div>
      </div>
    </div>
  );
}

// ─── Weekly A/D Split Chart ───────────────────────────────────────────────────

function WeeklySplitChart({ nifty100Bars, weeklyAdBars }: {
  nifty100Bars: BreadthResponse["weeklyNifty100Bars"];
  weeklyAdBars: AdWeeklyBar[];
}) {
  const niftyRef     = useRef<HTMLDivElement>(null);
  const adRef        = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef   = useRef<(() => void) | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.62);
  const dragState = useRef({ dragging: false, startY: 0, startRatio: 0.62 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.dragging || !containerRef.current) return;
      const rect  = containerRef.current.getBoundingClientRect();
      const delta = (e.clientY - dragState.current.startY) / rect.height;
      setSplitRatio(Math.min(0.85, Math.max(0.15, dragState.current.startRatio + delta)));
    };
    const onUp = () => { dragState.current.dragging = false; };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    if (!niftyRef.current || !adRef.current || nifty100Bars.length < 2 || weeklyAdBars.length < 2) return;
    let removed = false;

    (async () => {
      const { createChart, CandlestickSeries, LineSeries, LineStyle } =
        await import("lightweight-charts");
      if (removed) return;

      const SCALE_W = 62;
      const LAYOUT = {
        layout:    { background: { color: "#ffffff" }, textColor: "#374151", fontFamily: "Inter,system-ui,sans-serif", fontSize: 11 },
        grid:      { vertLines: { color: "#f8fafc", style: LineStyle.Solid }, horzLines: { color: "#f3f4f6", style: LineStyle.Solid } },
        crosshair: { mode: 1 },
        autoSize:  true,
      } as const;

      const niftyChart = createChart(niftyRef.current!, { ...LAYOUT, rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.05 }, minimumWidth: SCALE_W } });
      const adChart    = createChart(adRef.current!,    { ...LAYOUT, rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.05 }, minimumWidth: SCALE_W }, timeScale: { borderVisible: false } });

      const niftySeries = niftyChart.addSeries(CandlestickSeries, {
        upColor: "#10b981", downColor: "#ef4444", borderUpColor: "#10b981", borderDownColor: "#ef4444",
        wickUpColor: "#10b981", wickDownColor: "#ef4444",
      });
      niftySeries.setData(nifty100Bars.map((b) => ({ time: b.date as `${number}-${number}-${number}`, open: b.open, high: b.high, low: b.low, close: b.close })));

      const adSeries = adChart.addSeries(LineSeries, { color: "#6366f1", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true });
      adSeries.setData(weeklyAdBars.map((b) => ({
        time:  b.date as `${number}-${number}-${number}`,
        value: b.ratio,
      })));

      for (const { price, color, title, style } of [
        { price: 1.8, color: "#059669", title: "Bull  ",  style: LineStyle.Dashed },
        { price: 1.0, color: "#94a3b8", title: "Neutral  ", style: LineStyle.Dotted },
        { price: 0.5, color: "#ef4444", title: "Bear  ",  style: LineStyle.Solid  },
      ]) adSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });

      niftyChart.timeScale().fitContent();
      adChart.timeScale().fitContent();

      let syncing = false;
      niftyChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; adChart.timeScale().setVisibleRange(r); syncing = false;
      });
      adChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; niftyChart.timeScale().setVisibleRange(r); syncing = false;
      });
      niftyChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) adChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, adSeries as any);
        else        adChart.clearCrosshairPosition();
      });
      adChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) niftyChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, niftySeries as any);
        else        niftyChart.clearCrosshairPosition();
      });

      cleanupRef.current = () => { niftyChart.remove(); adChart.remove(); };
    })();

    return () => { removed = true; cleanupRef.current?.(); cleanupRef.current = null; };
  }, [nifty100Bars, weeklyAdBars]);

  const DIVIDER_HIT = 9;
  const topH = `calc(${(splitRatio * 100).toFixed(3)}% - ${Math.ceil(DIVIDER_HIT / 2)}px)`;
  const botH = `calc(${((1 - splitRatio) * 100).toFixed(3)}% - ${Math.floor(DIVIDER_HIT / 2)}px)`;

  return (
    <div ref={containerRef} className="flex flex-col h-full select-none overflow-hidden bg-white">
      <div className="relative flex-shrink-0" style={{ height: topH, overflow: "hidden" }}>
        <div ref={niftyRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>Nifty 100 · Weekly</span>
        </div>
      </div>
      <div className="relative flex-shrink-0 cursor-row-resize z-20" style={{ height: DIVIDER_HIT }}
        onMouseDown={(e) => { dragState.current = { dragging: true, startY: e.clientY, startRatio: splitRatio }; e.preventDefault(); }}>
        <div className="absolute left-0 right-0" style={{ top: "50%", height: 1, background: "#e5e7eb", transform: "translateY(-50%)" }} />
      </div>
      <div className="relative flex-shrink-0" style={{ height: botH, overflow: "hidden" }}>
        <div ref={adRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>A/D Ratio · Weekly</span>
        </div>
      </div>
    </div>
  );
}

// ─── A/D Modal (full-screen, ROC-style) ───────────────────────────────────────

const AD_ZONES = [
  { key: "bear"       as const, label: "< 0.8",       color: "#ef4444", bg: "#fef2f2"  },
  { key: "bull"       as const, label: "1.3 – 1.5",   color: "#10b981", bg: "#f0fdf4"  },
  { key: "strongBull" as const, label: "> 1.5",       color: "#059669", bg: "#dcfce7"  },
];

const WEEKLY_AD_ZONES = [
  { key: "bear" as const, label: "< 0.5", color: "#ef4444", bg: "#fef2f2" },
  { key: "bull" as const, label: "> 1.8", color: "#059669", bg: "#ecfdf5" },
];

function AdModal({ data, onClose }: { data: BreadthResponse; onClose: () => void }) {
  const [viewMode,      setViewMode]      = useState<"monthly" | "weekly">("monthly");
  const [zoneTab,       setZoneTab]       = useState<"bear" | "bull" | "strongBull">("bear");
  const [weeklyZoneTab, setWeeklyZoneTab] = useState<"bear" | "bull">("bear");

  const statusColors: Record<string, string> = {
    "Strong Bull": "#059669", "Bull": "#10b981",
    "Neutral": "#94a3b8", "Bear": "#ef4444",
  };
  const sc     = statusColors[data.breadthStatus] ?? "#94a3b8";
  const trendC = data.breadthTrend === "Improving" ? "#10b981" : data.breadthTrend === "Deteriorating" ? "#ef4444" : "#d97706";

  const activeZoneCfg     = AD_ZONES.find((z) => z.key === zoneTab)!;
  const activeStats        = data.zoneStats[zoneTab];
  const activeWeeklyZone   = WEEKLY_AD_ZONES.find((z) => z.key === weeklyZoneTab)!;
  const activeWeeklyStats  = data.weeklyZoneStats[weeklyZoneTab];
  const weeklyZoneEvents   = data.weeklyEvents.filter((e) => e.zoneType === weeklyZoneTab);

  const total   = data.currentAdvances + data.currentDeclines + data.currentUnchanged;
  const advPct  = total > 0 ? (data.currentAdvances / total) * 100 : 50;
  const decPct  = total > 0 ? (data.currentDeclines / total) * 100 : 50;
  const unchPct = total > 0 ? (data.currentUnchanged / total) * 100 : 0;

  const zoneEvents = data.extremeEvents.filter((e) => e.zoneType === zoneTab);

  return (
    <motion.div className="fixed inset-0 z-50 flex flex-col bg-white overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}>

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-3 sm:px-6 py-3 flex items-center gap-3 sm:gap-5 border-b border-slate-100 flex-wrap"
        style={{ background: "#f8fafc" }}>

        {/* Value badge */}
        <div className="flex-shrink-0">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex flex-col items-center justify-center shadow-sm bg-white"
            style={{ border: `2px solid ${sc}45` }}>
            <span className="text-xs font-black leading-none tabular-nums" style={{ color: sc }}>
              {data.currentRatio.toFixed(2)}
            </span>
            <span className="text-[8px] font-bold text-slate-400 mt-0.5 tracking-wide">A/D</span>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-base sm:text-lg font-black text-slate-900">Advance / Decline Ratio</span>
            <span className="text-[11px] font-black px-2.5 py-0.5 rounded-full"
              style={{ background: sc, color: "#fff" }}>{data.breadthStatus}</span>
            <span className="text-[11px] font-black px-2 py-0.5 rounded-full"
              style={{ background: trendC + "20", color: trendC }}>
              {data.breadthTrend === "Improving" ? "↗" : data.breadthTrend === "Deteriorating" ? "↘" : "→"} {data.breadthTrend}
            </span>
          </div>
          <p className="hidden sm:block text-xs text-slate-500">
            {data.currentAdvances} advancing · {data.currentDeclines} declining · {data.currentUnchanged} unchanged
            {" "}out of {data.currentTotal} Nifty 100 stocks on {data.currentDate}.
            {" "}20d MA: {data.ratio20d.toFixed(2)} · {data.percentileRank}th percentile (1Y).
          </p>
        </div>

        {/* Advances/Declines quick stat */}
        <div className="flex-shrink-0 text-center px-3 sm:px-4 py-2 rounded-xl"
          style={{ background: sc + "12", border: `1px solid ${sc}30` }}>
          <p className="text-[8px] font-black tracking-widest uppercase text-slate-400 mb-0.5">Today</p>
          <p className="text-xl sm:text-2xl font-black leading-none tabular-nums" style={{ color: sc }}>
            {data.currentRatio.toFixed(2)}
          </p>
          <p className="text-[9px] text-slate-400 mt-0.5">{data.percentileRank}th pct</p>
        </div>

        <button onClick={onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/80 text-slate-400 hover:text-slate-900 transition-all flex-shrink-0">
          <X size={16} />
        </button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden min-h-0">

        {/* ── Left: Chart ── */}
        <div className="h-[45vh] md:h-auto md:flex-1 flex-shrink-0 md:flex-shrink flex flex-col px-3 sm:px-5 pt-4 pb-3 min-w-0">
          <div className="flex items-center justify-between mb-3 flex-shrink-0">
            <p className="text-[10px] font-black tracking-widest uppercase text-slate-400">
              {viewMode === "monthly"
                ? "Nifty 100 × A/D Ratio · Monthly · Zone Analysis"
                : "Nifty 100 × A/D Ratio · Weekly · Zone Analysis"}
            </p>
            <div className="flex gap-1">
              {(["monthly", "weekly"] as const).map((m) => (
                <button key={m} onClick={() => setViewMode(m)}
                  className="px-2.5 py-1 rounded-lg text-[10px] font-black transition-all capitalize"
                  style={viewMode === m
                    ? { background: "#1e293b", color: "#fff" }
                    : { background: "#f1f5f9", color: "#64748b" }}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-slate-100">
            {viewMode === "monthly"
              ? <BreadthSplitChart nifty100Bars={data.nifty100Bars} adBars={data.bars} />
              : <WeeklySplitChart  nifty100Bars={data.weeklyNifty100Bars} weeklyAdBars={data.weeklyBars} />}
          </div>
          {/* Legend */}
          <div className="flex-shrink-0 mt-2 flex items-center gap-3 sm:gap-4 flex-wrap">
            {viewMode === "monthly" ? (
              <>
                {[
                  { color: "#059669", label: "> 1.5  Strong Bull" },
                  { color: "#10b981", label: "1.3–1.5  Bull" },
                  { color: "#94a3b8", label: "0.8–1.3  Neutral" },
                  { color: "#ef4444", label: "< 0.8  Bear" },
                ].map(({ color, label }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <div className="w-3 h-2.5 rounded-sm" style={{ background: color }} />
                    <span className="text-[9px] text-slate-500 font-bold">{label}</span>
                  </div>
                ))}
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-0.5 rounded" style={{ background: "#6366f1" }} />
                  <span className="text-[9px] text-slate-500 font-bold">20d MA</span>
                </div>
              </>
            ) : (
              <>
                {[
                  { color: "#059669", label: "> 1.8  Bull" },
                  { color: "#94a3b8", label: "0.5–1.8  Neutral" },
                  { color: "#ef4444", label: "< 0.5  Bear" },
                ].map(({ color, label }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <div className="w-3 h-2.5 rounded-sm" style={{ background: color }} />
                    <span className="text-[9px] text-slate-500 font-bold">{label}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* ── Right: Stats panel ── */}
        <div className="w-full md:w-72 flex-shrink-0 border-t md:border-t-0 md:border-l border-slate-100 bg-slate-50/40 flex flex-col overflow-y-auto">

          {/* A/D Gauge — always shown */}
          <div className="p-4 border-b border-slate-100">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2">A/D Ratio Gauge</p>
            <div className="relative h-2 rounded-full overflow-hidden flex mb-1">
              <div style={{ width: "20%", background: "#ef4444" }} />
              <div style={{ width: "15%", background: "#f97316" }} />
              <div style={{ width: "25%", background: "#94a3b8" }} />
              <div style={{ width: "20%", background: "#10b981" }} />
              <div style={{ width: "20%", background: "#059669" }} />
            </div>
            <div style={{ marginLeft: `${Math.min(98, Math.max(1, data.percentileRank))}%`, transform: "translateX(-50%)", borderBottomColor: sc }}
              className="w-0 h-0 border-l-[5px] border-r-[5px] border-b-[7px] border-l-transparent border-r-transparent mb-1" />
            <div className="flex justify-between text-[8px] text-slate-400 font-bold mb-2">
              <span>0%</span><span>50%</span><span>100%</span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-lg font-black tabular-nums" style={{ color: sc }}>{data.percentileRank}th</span>
              <div className="text-right">
                <p className="text-[11px] font-black" style={{ color: sc }}>{data.breadthStatus}</p>
                <p className="text-[9px] text-slate-400">{data.breadthTrend}</p>
              </div>
            </div>
          </div>

          {/* Today breadth bar — always shown */}
          <div className="p-4 border-b border-slate-100">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2">
              Today · {data.currentTotal} Stocks
            </p>
            <div className="flex h-4 rounded-full overflow-hidden gap-[1px] mb-1">
              <div className="bg-emerald-500 flex items-center justify-center" style={{ width: `${advPct}%` }}>
                {advPct > 10 && <span className="text-[8px] font-black text-white">{data.currentAdvances}</span>}
              </div>
              {unchPct > 0 && <div className="bg-slate-300" style={{ width: `${unchPct}%` }} />}
              <div className="bg-red-500 flex-1 flex items-center justify-center">
                {decPct > 10 && <span className="text-[8px] font-black text-white">{data.currentDeclines}</span>}
              </div>
            </div>
            <div className="flex justify-between text-[9px]">
              <span className="text-emerald-600 font-black">↑ {data.currentAdvances}</span>
              <span className="text-slate-400">{data.currentUnchanged} unch</span>
              <span className="text-red-500 font-black">{data.currentDeclines} ↓</span>
            </div>
          </div>

          {viewMode === "monthly" ? (
            <>
              {/* Monthly zone forward returns */}
              <div className="p-4 border-b border-slate-100">
                <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2.5">After A/D · Forward Returns</p>
                <div className="flex gap-1 mb-3 flex-wrap">
                  {AD_ZONES.map((z) => (
                    <button key={z.key} onClick={() => setZoneTab(z.key)}
                      className="px-2 py-1 rounded-lg text-[10px] font-black transition-all"
                      style={zoneTab === z.key
                        ? { background: z.color, color: "#fff" }
                        : { background: z.color + "15", color: z.color }}>
                      {z.label}
                    </button>
                  ))}
                </div>
                {activeStats ? (
                  <div className="space-y-2.5">
                    <WinRateBar wr={activeStats.winRate3m}  avg={activeStats.avgRet3m}  label="3 Months"  />
                    <WinRateBar wr={activeStats.winRate6m}  avg={activeStats.avgRet6m}  label="6 Months"  />
                    <WinRateBar wr={activeStats.winRate12m} avg={activeStats.avgRet12m} label="12 Months" />
                    <WinRateBar wr={activeStats.winRate18m} avg={activeStats.avgRet18m} label="18 Months" />
                    <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-[9px] text-slate-400 font-bold">{activeStats.totalEvents} events · Avg max drawdown</span>
                      <span className="text-[10px] font-black" style={{ color: "#ef4444" }}>{activeStats.avgMaxDrawdown.toFixed(1)}%</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-[10px] text-slate-400 italic">No events in this zone yet</p>
                )}
              </div>

              {/* Monthly event list */}
              <div className="p-4">
                <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2.5">
                  {activeZoneCfg.label} Events ({zoneEvents.length})
                </p>
                {zoneEvents.length === 0 ? (
                  <p className="text-[10px] text-slate-400 italic">No events detected</p>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {[...zoneEvents].reverse().map((e, i) => (
                      <div key={i} className="rounded-lg px-2.5 py-2.5"
                        style={{ background: activeZoneCfg.bg, border: `1px solid ${activeZoneCfg.color}25` }}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[10px] font-black text-slate-700">{e.date}</span>
                          <span className="text-[9px] font-black px-1.5 py-0.5 rounded"
                            style={{ background: activeZoneCfg.color + "25", color: activeZoneCfg.color }}>
                            {e.adRatio.toFixed(2)}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
                          {([
                            { label: "3M", val: e.ret3m }, { label: "6M",  val: e.ret6m },
                            { label: "12M", val: e.ret12m }, { label: "18M", val: e.ret18m },
                          ] as { label: string; val: number | null }[]).map(({ label, val }) => (
                            <div key={label} className="flex items-center justify-between">
                              <span className="text-slate-400 font-bold">{label}</span>
                              {val !== null
                                ? <span className="font-black" style={{ color: val >= 0 ? "#10b981" : "#ef4444" }}>{val >= 0 ? "+" : ""}{val}%</span>
                                : <span className="text-slate-300 font-bold">—</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* Weekly zone forward returns */}
              <div className="p-4 border-b border-slate-100">
                <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2.5">After Weekly A/D · Forward Returns</p>
                <div className="flex gap-1 mb-3">
                  {WEEKLY_AD_ZONES.map((z) => (
                    <button key={z.key} onClick={() => setWeeklyZoneTab(z.key)}
                      className="px-2 py-1 rounded-lg text-[10px] font-black transition-all"
                      style={weeklyZoneTab === z.key
                        ? { background: z.color, color: "#fff" }
                        : { background: z.color + "15", color: z.color }}>
                      {z.label}
                    </button>
                  ))}
                </div>
                {activeWeeklyStats ? (
                  <div className="space-y-2.5">
                    <WinRateBar wr={activeWeeklyStats.winRate15d} avg={activeWeeklyStats.avgRet15d} label="15 Days" />
                    <WinRateBar wr={activeWeeklyStats.winRate1m}  avg={activeWeeklyStats.avgRet1m}  label="1 Month" />
                    <WinRateBar wr={activeWeeklyStats.winRate2m}  avg={activeWeeklyStats.avgRet2m}  label="2 Months" />
                    <WinRateBar wr={activeWeeklyStats.winRate3m}  avg={activeWeeklyStats.avgRet3m}  label="3 Months" />
                    <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-[9px] text-slate-400 font-bold">{activeWeeklyStats.totalEvents} events · Avg max drawdown</span>
                      <span className="text-[10px] font-black" style={{ color: "#ef4444" }}>{activeWeeklyStats.avgMaxDrawdown.toFixed(1)}%</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-[10px] text-slate-400 italic">No events in this zone yet</p>
                )}
              </div>

              {/* Weekly event list */}
              <div className="p-4">
                <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2.5">
                  {activeWeeklyZone.label} Events ({weeklyZoneEvents.length})
                </p>
                {weeklyZoneEvents.length === 0 ? (
                  <p className="text-[10px] text-slate-400 italic">No events detected</p>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {[...weeklyZoneEvents].reverse().map((e, i) => (
                      <div key={i} className="rounded-lg px-2.5 py-2.5"
                        style={{ background: activeWeeklyZone.bg, border: `1px solid ${activeWeeklyZone.color}25` }}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[10px] font-black text-slate-700">{e.date}</span>
                          <span className="text-[9px] font-black px-1.5 py-0.5 rounded"
                            style={{ background: activeWeeklyZone.color + "25", color: activeWeeklyZone.color }}>
                            {e.adRatio.toFixed(2)}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
                          {([
                            { label: "15D", val: e.ret15d }, { label: "1M",  val: e.ret1m  },
                            { label: "2M",  val: e.ret2m  }, { label: "3M",  val: e.ret3m  },
                          ] as { label: string; val: number | null }[]).map(({ label, val }) => (
                            <div key={label} className="flex items-center justify-between">
                              <span className="text-slate-400 font-bold">{label}</span>
                              {val !== null
                                ? <span className="font-black" style={{ color: val >= 0 ? "#10b981" : "#ef4444" }}>{val >= 0 ? "+" : ""}{val}%</span>
                                : <span className="text-slate-300 font-bold">—</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

        </div>
      </div>
    </motion.div>
  );
}

// ─── A/D Ratio Intelligence Card (compact) ────────────────────────────────────

function AdIntelligenceCard() {
  const { data } = useSWR<BreadthResponse>("/api/breadth", fetcher, { refreshInterval: 600_000 });
  const [modalOpen, setModalOpen] = useState(false);

  if (!data?.hasData) return null;

  const statusColors: Record<string, string> = {
    "Strong Bull": "#059669", "Bull": "#10b981",
    "Neutral": "#94a3b8", "Bear": "#f97316", "Strong Bear": "#ef4444",
  };
  const sc      = statusColors[data.breadthStatus] ?? "#94a3b8";
  const trendC  = data.breadthTrend === "Improving" ? "#10b981" : data.breadthTrend === "Deteriorating" ? "#ef4444" : "#d97706";
  const trendIcon = data.breadthTrend === "Improving" ? "↗" : data.breadthTrend === "Deteriorating" ? "↘" : "→";
  const total   = data.currentAdvances + data.currentDeclines + data.currentUnchanged;
  const advPct  = total > 0 ? (data.currentAdvances / total) * 100 : 50;
  const decPct  = total > 0 ? (data.currentDeclines / total) * 100 : 50;
  const unchPct = total > 0 ? (data.currentUnchanged / total) * 100 : 0;

  const bearStats = data.zoneStats.bear;

  return (
    <>
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {modalOpen && <AdModal data={data} onClose={() => setModalOpen(false)} />}
        </AnimatePresence>,
        document.body
      )}

      <motion.button onClick={() => setModalOpen(true)}
        className="w-full rounded-xl text-left overflow-hidden bg-white shadow-sm"
        style={{ border: `1.5px solid ${sc}35` }}
        whileHover={{ scale: 1.004, boxShadow: `0 4px 20px ${sc}18` }}
        transition={{ duration: 0.15 }}>

        <div className="px-5 py-4 flex items-center gap-5 flex-wrap">

          {/* Icon + value */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: sc + "15", border: `1px solid ${sc}40` }}>
              <Activity size={16} style={{ color: sc }} />
            </div>
            <div>
              <p className="text-[8px] font-black tracking-widest uppercase text-slate-400">A/D Ratio · Nifty 100</p>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span className="text-xl font-black tabular-nums leading-none" style={{ color: sc }}>
                  {data.currentRatio.toFixed(2)}
                </span>
                <span className="text-[10px] font-bold tabular-nums" style={{ color: trendC }}>
                  {trendIcon} {data.breadthTrend}
                </span>
              </div>
            </div>
          </div>

          {/* Status + percentile */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-black px-2 py-0.5 rounded-full w-fit"
              style={{ background: sc + "20", color: sc }}>{data.breadthStatus}</span>
            <span className="text-[9px] text-slate-400 pl-0.5">{data.percentileRank}th percentile (1Y)</span>
          </div>

          {/* Today count */}
          <div className="flex flex-col gap-0.5">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400">Signal</p>
            <div className="flex items-center gap-1.5 text-[10px] font-bold">
              <span className="text-emerald-600">↑{data.currentAdvances}</span>
              <span className="text-slate-300">/</span>
              <span className="text-red-500">↓{data.currentDeclines}</span>
            </div>
            <p className="text-[9px] text-slate-400">20d MA: {data.ratio20d.toFixed(2)}</p>
          </div>

          {/* Strong Bear stats if available */}
          {bearStats && (
            <div className="flex-shrink-0 px-3 py-1.5 rounded-lg border"
              style={{ borderColor: "#ef444430", background: "#ef444408" }}>
              <p className="text-[8px] font-black text-slate-400 mb-0.5">{bearStats.totalEvents} bear events · 12M avg</p>
              <p className="text-xs font-black tabular-nums"
                style={{ color: bearStats.avgRet12m >= 0 ? "#10b981" : "#ef4444" }}>
                {bearStats.avgRet12m >= 0 ? "+" : ""}{bearStats.avgRet12m}%
              </p>
            </div>
          )}

          {/* Zone bar */}
          <div className="w-full h-1.5 rounded-full overflow-hidden flex mt-1">
            <div style={{ width: "20%", background: "#ef4444" }} />
            <div style={{ width: "15%", background: "#f97316", opacity: data.breadthStatus === "Bear" ? 1 : 0.5 }} />
            <div style={{ width: "25%", background: "#94a3b8", opacity: data.breadthStatus === "Neutral" ? 1 : 0.4 }} />
            <div style={{ width: "20%", background: "#10b981", opacity: data.breadthStatus === "Bull" ? 1 : 0.5 }} />
            <div style={{ width: "20%", background: "#059669", opacity: data.breadthStatus === "Strong Bull" ? 1 : 0.3 }} />
          </div>
          <div className="w-full">
            <div className="flex h-1 rounded-full overflow-hidden gap-[1px]">
              <div className="bg-emerald-400 rounded-l-full" style={{ width: `${advPct}%` }} />
              {unchPct > 0 && <div className="bg-slate-200" style={{ width: `${unchPct}%` }} />}
              <div className="bg-red-400 rounded-r-full flex-1" />
            </div>
            <div className="flex justify-between text-[8px] text-slate-400 mt-0.5">
              <span className="font-bold text-emerald-600">{data.currentAdvances} adv</span>
              <span className="font-bold text-red-500">{data.currentDeclines} dec</span>
            </div>
          </div>

        </div>
      </motion.button>
    </>
  );
}

// ─── DMA200 Split Chart ───────────────────────────────────────────────────────

function Dma200SplitChart({ nifty100Bars, dmaBars }: {
  nifty100Bars: Dma200Response["nifty100Bars"];
  dmaBars:      Dma200Bar[];
}) {
  const niftyRef     = useRef<HTMLDivElement>(null);
  const dmaRef       = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef   = useRef<(() => void) | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.62);
  const dragState = useRef({ dragging: false, startY: 0, startRatio: 0.62 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.dragging || !containerRef.current) return;
      const rect  = containerRef.current.getBoundingClientRect();
      const delta = (e.clientY - dragState.current.startY) / rect.height;
      setSplitRatio(Math.min(0.85, Math.max(0.15, dragState.current.startRatio + delta)));
    };
    const onUp = () => { dragState.current.dragging = false; };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // Monthly aggregation: end-of-month % above 200 DMA (later dates overwrite)
  const monthlyDmaBars = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of dmaBars) map.set(b.date.slice(0, 7) + "-01", b.pctAbove);
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, pctAbove]) => ({ date, pctAbove }));
  }, [dmaBars]);

  useEffect(() => {
    if (!niftyRef.current || !dmaRef.current || nifty100Bars.length < 2 || monthlyDmaBars.length < 2) return;
    let removed = false;

    (async () => {
      const { createChart, CandlestickSeries, LineSeries, LineStyle } =
        await import("lightweight-charts");
      if (removed) return;

      const SCALE_W = 58;
      const LAYOUT = {
        layout:    { background: { color: "#ffffff" }, textColor: "#374151", fontFamily: "Inter,system-ui,sans-serif", fontSize: 11 },
        grid:      { vertLines: { color: "#f8fafc", style: LineStyle.Solid }, horzLines: { color: "#f3f4f6", style: LineStyle.Solid } },
        crosshair: { mode: 1 },
        autoSize:  true,
      } as const;

      // ── Top: Nifty 100 monthly candlesticks ──
      const niftyChart = createChart(niftyRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.06, bottom: 0.02 }, minimumWidth: SCALE_W },
        timeScale: { visible: false },
      });
      const niftySeries = niftyChart.addSeries(CandlestickSeries, {
        upColor: "#10b981", downColor: "#ef4444",
        borderUpColor: "#10b981", borderDownColor: "#ef4444",
        wickUpColor: "#10b981", wickDownColor: "#ef4444",
        priceLineVisible: false,
      });
      niftySeries.setData(nifty100Bars.map((b) => ({
        time: b.date as `${number}-${number}-${number}`,
        open: b.open, high: b.high, low: b.low, close: b.close,
      })));

      // ── Bottom: % above 200 DMA line ──
      const dmaChart = createChart(dmaRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: SCALE_W },
        timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false },
      });
      const dmaSeries = dmaChart.addSeries(LineSeries, {
        color: "#8b5cf6", lineWidth: 2,
        priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      });
      dmaSeries.setData(monthlyDmaBars.map((b) => ({
        time:  b.date as `${number}-${number}-${number}`,
        value: b.pctAbove,
      })));

      // Zone reference lines at 20 / 40 / 60 / 80
      for (const { price, color, title, style } of [
        { price: 80, color: "#059669", title: "Strong Bull  ", style: LineStyle.Dashed },
        { price: 60, color: "#10b981", title: "Bull  ",        style: LineStyle.Dashed },
        { price: 40, color: "#94a3b8", title: "Bear  ",        style: LineStyle.Dashed },
        { price: 20, color: "#ef4444", title: "Strong Bear  ", style: LineStyle.Solid  },
      ]) dmaSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });

      niftyChart.timeScale().fitContent();
      dmaChart.timeScale().fitContent();

      // ── Sync ──
      let syncing = false;
      niftyChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; dmaChart.timeScale().setVisibleRange(r); syncing = false;
      });
      dmaChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; niftyChart.timeScale().setVisibleRange(r); syncing = false;
      });
      niftyChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) dmaChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, dmaSeries as any);
        else        dmaChart.clearCrosshairPosition();
      });
      dmaChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) niftyChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, niftySeries as any);
        else        niftyChart.clearCrosshairPosition();
      });

      cleanupRef.current = () => { niftyChart.remove(); dmaChart.remove(); };
    })();

    return () => { removed = true; cleanupRef.current?.(); cleanupRef.current = null; };
  }, [nifty100Bars, monthlyDmaBars]);

  const DIVIDER_HIT = 9;
  const topH = `calc(${(splitRatio * 100).toFixed(3)}% - ${Math.ceil(DIVIDER_HIT / 2)}px)`;
  const botH = `calc(${((1 - splitRatio) * 100).toFixed(3)}% - ${Math.floor(DIVIDER_HIT / 2)}px)`;

  return (
    <div ref={containerRef} className="flex flex-col h-full select-none overflow-hidden bg-white">
      <div className="relative flex-shrink-0" style={{ height: topH, overflow: "hidden" }}>
        <div ref={niftyRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>Nifty 100 · Monthly</span>
        </div>
      </div>
      <div className="relative flex-shrink-0 cursor-row-resize z-20" style={{ height: DIVIDER_HIT }}
        onMouseDown={(e) => { dragState.current = { dragging: true, startY: e.clientY, startRatio: splitRatio }; e.preventDefault(); }}>
        <div className="absolute left-0 right-0" style={{ top: "50%", height: 1, background: "#e5e7eb", transform: "translateY(-50%)" }} />
      </div>
      <div className="relative flex-shrink-0" style={{ height: botH, overflow: "hidden" }}>
        <div ref={dmaRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>% Above 200 DMA · Monthly</span>
        </div>
      </div>
    </div>
  );
}

// ─── DMA200 Zone config ───────────────────────────────────────────────────────

const DMA_ZONES = [
  { key: "strongBear" as const, label: "< 20%",    color: "#ef4444", bg: "#fef2f2" },
  { key: "bear"       as const, label: "20%–40%",  color: "#f97316", bg: "#fff7ed" },
  { key: "bull"       as const, label: "60%–80%",  color: "#10b981", bg: "#f0fdf4" },
  { key: "strongBull" as const, label: "> 80%",    color: "#059669", bg: "#dcfce7" },
];

// ─── DMA200 Modal (full-screen) ───────────────────────────────────────────────

function Dma200Modal({ data, onClose }: { data: Dma200Response; onClose: () => void }) {
  const [zoneTab, setZoneTab] = useState<"strongBear" | "bear" | "bull" | "strongBull">("strongBear");

  const STATUS_COLORS: Record<string, string> = {
    "Strong Bull": "#059669", "Bull": "#10b981",
    "Neutral": "#94a3b8",    "Bear": "#f97316", "Strong Bear": "#ef4444",
  };
  const sc     = STATUS_COLORS[data.dmaStatus] ?? "#94a3b8";
  const trendC = data.dmaTrend === "Improving" ? "#10b981" : data.dmaTrend === "Deteriorating" ? "#ef4444" : "#d97706";

  const activeZone  = DMA_ZONES.find((z) => z.key === zoneTab)!;
  const activeStats = data.zoneStats[zoneTab];
  const zoneEvents  = data.extremeEvents.filter((e) => e.zoneType === zoneTab);

  return (
    <motion.div className="fixed inset-0 z-50 flex flex-col bg-white overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}>

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-3 sm:px-6 py-3 flex items-center gap-3 sm:gap-5 border-b border-slate-100 flex-wrap"
        style={{ background: "#f8fafc" }}>

        <div className="flex-shrink-0">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex flex-col items-center justify-center shadow-sm bg-white"
            style={{ border: `2px solid ${sc}45` }}>
            <span className="text-xs font-black leading-none tabular-nums" style={{ color: sc }}>
              {data.currentPctAbove.toFixed(1)}%
            </span>
            <span className="text-[8px] font-bold text-slate-400 mt-0.5 tracking-wide">200d</span>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-base sm:text-lg font-black text-slate-900">% Above 200 DMA</span>
            <span className="text-[11px] font-black px-2.5 py-0.5 rounded-full"
              style={{ background: sc, color: "#fff" }}>{data.dmaStatus}</span>
            <span className="text-[11px] font-black px-2 py-0.5 rounded-full"
              style={{ background: trendC + "20", color: trendC }}>
              {data.dmaTrend === "Improving" ? "↗" : data.dmaTrend === "Deteriorating" ? "↘" : "→"} {data.dmaTrend}
            </span>
          </div>
          <p className="hidden sm:block text-xs text-slate-500">
            {data.currentAbove} of {data.currentTotal} Nifty 100 stocks above their 200-day SMA on {data.currentDate}.
            {" "}{data.percentileRank}th percentile (all-time monthly).
          </p>
        </div>

        <div className="flex-shrink-0 text-center px-3 sm:px-4 py-2 rounded-xl"
          style={{ background: sc + "12", border: `1px solid ${sc}30` }}>
          <p className="text-[8px] font-black tracking-widest uppercase text-slate-400 mb-0.5">Today</p>
          <p className="text-xl sm:text-2xl font-black leading-none tabular-nums" style={{ color: sc }}>
            {data.currentPctAbove.toFixed(1)}%
          </p>
          <p className="text-[9px] text-slate-400 mt-0.5">{data.percentileRank}th pct</p>
        </div>

        <button onClick={onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/80 text-slate-400 hover:text-slate-900 transition-all flex-shrink-0">
          <X size={16} />
        </button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden min-h-0">

        {/* ── Left: Chart ── */}
        <div className="h-[45vh] md:h-auto md:flex-1 flex-shrink-0 md:flex-shrink flex flex-col px-3 sm:px-5 pt-4 pb-3 min-w-0">
          <p className="text-[10px] font-black tracking-widest uppercase text-slate-400 mb-3 flex-shrink-0">
            Nifty 100 × % Above 200 DMA · Monthly · Zone Analysis
          </p>
          <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-slate-100">
            <Dma200SplitChart nifty100Bars={data.nifty100Bars} dmaBars={data.bars} />
          </div>
          {/* Legend */}
          <div className="flex-shrink-0 mt-2 flex items-center gap-3 sm:gap-4 flex-wrap">
            {[
              { color: "#059669", label: "> 80%  Strong Bull" },
              { color: "#10b981", label: "60–80%  Bull" },
              { color: "#94a3b8", label: "40–60%  Neutral" },
              { color: "#f97316", label: "20–40%  Bear" },
              { color: "#ef4444", label: "< 20%  Strong Bear" },
            ].map(({ color, label }) => (
              <div key={label} className="flex items-center gap-1.5">
                <div className="w-3 h-2.5 rounded-sm" style={{ background: color }} />
                <span className="text-[9px] text-slate-500 font-bold">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right: Stats panel ── */}
        <div className="md:w-72 flex-shrink-0 border-t md:border-t-0 md:border-l border-slate-100 flex flex-col overflow-y-auto">

          {/* Percentile gauge */}
          <div className="p-4 border-b border-slate-100">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-3">Percentile Rank (All-Time Monthly)</p>
            <div className="flex h-3 rounded-full overflow-hidden gap-[1px]">
              <div style={{ width: "20%", background: "#ef4444" }} />
              <div style={{ width: "20%", background: "#f97316" }} />
              <div style={{ width: "20%", background: "#94a3b8" }} />
              <div style={{ width: "20%", background: "#10b981" }} />
              <div style={{ width: "20%", background: "#059669" }} />
            </div>
            <div style={{ marginLeft: `${Math.min(98, Math.max(1, data.percentileRank))}%`, transform: "translateX(-50%)", borderBottomColor: sc }}
              className="w-0 h-0 border-l-[5px] border-r-[5px] border-b-[7px] border-l-transparent border-r-transparent mb-1" />
            <div className="flex justify-between text-[8px] text-slate-400 font-bold mb-2">
              <span>0%</span><span>50%</span><span>100%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-slate-400">PERCENTILE</span>
              <span className="text-[9px] text-slate-400">STATUS</span>
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-sm font-black tabular-nums" style={{ color: sc }}>{data.percentileRank}th</span>
              <span className="text-xs font-black px-2 py-0.5 rounded-full"
                style={{ background: sc + "20", color: sc }}>{data.dmaStatus}</span>
            </div>
          </div>

          {/* Today stocks count */}
          <div className="p-4 border-b border-slate-100">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2">
              Today · {data.currentTotal} Stocks Tracked
            </p>
            {/* Progress bar 0-100% */}
            <div className="flex h-4 rounded-full overflow-hidden bg-slate-100 mb-1">
              <div className="rounded-full flex items-center justify-center transition-all duration-700"
                style={{ width: `${data.currentPctAbove}%`, background: sc }}>
                {data.currentPctAbove > 15 && (
                  <span className="text-[8px] font-black text-white">{data.currentAbove}</span>
                )}
              </div>
            </div>
            <div className="flex justify-between text-[9px]">
              <span className="font-black" style={{ color: sc }}>↑ {data.currentAbove} above</span>
              <span className="text-slate-400">{data.currentTotal - data.currentAbove} below</span>
            </div>
          </div>

          {/* Zone forward returns */}
          <div className="p-4 border-b border-slate-100">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2.5">After Zone Entry · Forward Returns</p>
            <div className="flex gap-1 mb-3 flex-wrap">
              {DMA_ZONES.map((z) => (
                <button key={z.key} onClick={() => setZoneTab(z.key)}
                  className="px-2 py-1 rounded-lg text-[10px] font-black transition-all"
                  style={zoneTab === z.key
                    ? { background: z.color, color: "#fff" }
                    : { background: z.color + "15", color: z.color }}>
                  {z.label}
                </button>
              ))}
            </div>

            {activeStats ? (
              <div className="space-y-2.5">
                <WinRateBar wr={activeStats.winRate15d} avg={activeStats.avgRet15d} label="15 Days"   />
                <WinRateBar wr={activeStats.winRate1m}  avg={activeStats.avgRet1m}  label="1 Month"   />
                <WinRateBar wr={activeStats.winRate2m}  avg={activeStats.avgRet2m}  label="2 Months"  />
                <WinRateBar wr={activeStats.winRate3m}  avg={activeStats.avgRet3m}  label="3 Months"  />
                <WinRateBar wr={activeStats.winRate6m}  avg={activeStats.avgRet6m}  label="6 Months"  />
                <WinRateBar wr={activeStats.winRate12m} avg={activeStats.avgRet12m} label="12 Months" />
                <WinRateBar wr={activeStats.winRate18m} avg={activeStats.avgRet18m} label="18 Months" />
                <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-[9px] text-slate-400">Avg Max Drawdown</span>
                  <span className="text-[11px] font-black text-red-500">
                    {activeStats.avgMaxDrawdown >= 0 ? "+" : ""}{activeStats.avgMaxDrawdown}%
                  </span>
                </div>
                <p className="text-[8px] text-slate-400">{activeStats.totalEvents} zone entries in dataset</p>
              </div>
            ) : (
              <p className="text-[10px] text-slate-400 italic">No events detected for this zone.</p>
            )}
          </div>

          {/* Extreme events list */}
          {zoneEvents.length > 0 && (
            <div className="p-4">
              <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2">
                All {activeZone.label} Events ({zoneEvents.length})
              </p>
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {[...zoneEvents].reverse().map((e, i) => (
                  <div key={i} className="flex items-start justify-between gap-2 py-1.5 border-b border-slate-50 last:border-0">
                    <div>
                      <p className="text-[10px] font-black text-slate-700">{e.date.slice(0, 7)}</p>
                      <p className="text-[9px] text-slate-400">{e.pctAbove.toFixed(1)}% above · ₹{Math.round(e.nifty100Close).toLocaleString("en-IN")}</p>
                    </div>
                    <div className="text-right flex-shrink-0 space-y-0.5">
                      {e.ret15d !== null && (
                        <p className="text-[9px] font-black" style={{ color: e.ret15d >= 0 ? "#10b981" : "#ef4444" }}>
                          {e.ret15d >= 0 ? "+" : ""}{e.ret15d}% <span className="text-slate-400 font-normal">15d</span>
                        </p>
                      )}
                      {e.ret3m !== null ? (
                        <p className="text-[9px] font-black" style={{ color: e.ret3m >= 0 ? "#10b981" : "#ef4444" }}>
                          {e.ret3m >= 0 ? "+" : ""}{e.ret3m}% <span className="text-slate-400 font-normal">3m</span>
                        </p>
                      ) : <p className="text-[9px] text-slate-300">—</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── DMA200 Intelligence Card (compact) ───────────────────────────────────────

function Dma200IntelligenceCard() {
  const { data } = useSWR<Dma200Response>("/api/dma200", fetcher, { refreshInterval: 600_000 });
  const [modalOpen, setModalOpen] = useState(false);

  if (!data?.hasData) return null;

  const STATUS_COLORS: Record<string, string> = {
    "Strong Bull": "#059669", "Bull": "#10b981",
    "Neutral": "#94a3b8",    "Bear": "#f97316", "Strong Bear": "#ef4444",
  };
  const sc        = STATUS_COLORS[data.dmaStatus] ?? "#94a3b8";
  const trendC    = data.dmaTrend === "Improving" ? "#10b981" : data.dmaTrend === "Deteriorating" ? "#ef4444" : "#d97706";
  const trendIcon = data.dmaTrend === "Improving" ? "↗" : data.dmaTrend === "Deteriorating" ? "↘" : "→";
  const bullStats  = data.zoneStats.strongBull;

  return (
    <>
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {modalOpen && <Dma200Modal data={data} onClose={() => setModalOpen(false)} />}
        </AnimatePresence>,
        document.body
      )}

      <motion.button onClick={() => setModalOpen(true)}
        className="w-full rounded-xl text-left overflow-hidden bg-white shadow-sm"
        style={{ border: `1.5px solid ${sc}35` }}
        whileHover={{ scale: 1.004, boxShadow: `0 4px 20px ${sc}18` }}
        transition={{ duration: 0.15 }}>

        <div className="px-5 py-4 flex items-center gap-5 flex-wrap">

          {/* Icon + value */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: sc + "15", border: `1px solid ${sc}40` }}>
              <TrendingUp size={16} style={{ color: sc }} />
            </div>
            <div>
              <p className="text-[8px] font-black tracking-widest uppercase text-slate-400">% Above 200 DMA · Nifty 100</p>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span className="text-xl font-black tabular-nums leading-none" style={{ color: sc }}>
                  {data.currentPctAbove.toFixed(1)}%
                </span>
                <span className="text-[10px] font-bold tabular-nums" style={{ color: trendC }}>
                  {trendIcon} {data.dmaTrend}
                </span>
              </div>
            </div>
          </div>

          {/* Status + percentile */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-black px-2 py-0.5 rounded-full w-fit"
              style={{ background: sc + "20", color: sc }}>{data.dmaStatus}</span>
            <span className="text-[9px] text-slate-400 pl-0.5">{data.percentileRank}th percentile</span>
          </div>

          {/* Stocks count */}
          <div className="flex flex-col gap-0.5">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400">Stocks Above</p>
            <p className="text-sm font-black tabular-nums leading-none" style={{ color: sc }}>
              {data.currentAbove} <span className="text-slate-400 text-[9px] font-medium">/ {data.currentTotal}</span>
            </p>
          </div>

          {/* Strong Bull stats if available */}
          {bullStats && (
            <div className="flex-shrink-0 px-3 py-1.5 rounded-lg border"
              style={{ borderColor: "#05996930", background: "#05996908" }}>
              <p className="text-[8px] font-black text-slate-400 mb-0.5">{bullStats.totalEvents} bull events · 12M avg</p>
              <p className="text-xs font-black tabular-nums"
                style={{ color: bullStats.avgRet12m >= 0 ? "#10b981" : "#ef4444" }}>
                {bullStats.avgRet12m >= 0 ? "+" : ""}{bullStats.avgRet12m}%
              </p>
            </div>
          )}

          {/* % above progress bar */}
          <div className="w-full">
            <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-100">
              <div className="rounded-full transition-all duration-700"
                style={{ width: `${data.currentPctAbove}%`, background: sc }} />
            </div>
            <div className="flex justify-between text-[8px] text-slate-400 mt-0.5">
              <span>0%</span>
              <span className="font-bold" style={{ color: sc }}>{data.currentPctAbove.toFixed(1)}% above 200 DMA</span>
              <span>100%</span>
            </div>
          </div>

        </div>
      </motion.button>
    </>
  );
}

// ─── LC Split Chart ───────────────────────────────────────────────────────────

function LcSplitChart({
  lcBars,
  nifty100Bars,
}: {
  lcBars:        LcBar[];
  nifty100Bars:  { date: string; open: number; high: number; low: number; close: number }[];
}) {
  const niftyRef    = useRef<HTMLDivElement>(null);
  const lcRef       = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef  = useRef<(() => void) | null>(null);
  const dragState   = useRef<{ dragging: boolean; startY: number; startRatio: number }>({
    dragging: false, startY: 0, startRatio: 0.55,
  });
  const [splitRatio, setSplitRatio] = useState(0.55);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.dragging || !containerRef.current) return;
      const rect  = containerRef.current.getBoundingClientRect();
      const delta = e.clientY - dragState.current.startY;
      const newR  = Math.min(0.85, Math.max(0.25, dragState.current.startRatio + delta / rect.height));
      setSplitRatio(newR);
    };
    const onUp = () => { dragState.current.dragging = false; };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    if (!niftyRef.current || !lcRef.current || nifty100Bars.length < 2 || lcBars.length < 2) return;
    let removed = false;

    (async () => {
      const { createChart, CandlestickSeries, LineSeries, LineStyle } =
        await import("lightweight-charts");
      if (removed) return;

      const SCALE_W = 58;
      const LAYOUT = {
        layout:    { background: { color: "#ffffff" }, textColor: "#374151", fontFamily: "Inter,system-ui,sans-serif", fontSize: 11 },
        grid:      { vertLines: { color: "#f8fafc", style: LineStyle.Solid }, horzLines: { color: "#f3f4f6", style: LineStyle.Solid } },
        crosshair: { mode: 1 },
        autoSize:  true,
      } as const;

      // ── Top: Nifty 100 monthly candlesticks ──
      const niftyChart = createChart(niftyRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.06, bottom: 0.02 }, minimumWidth: SCALE_W },
        timeScale: { visible: false },
      });
      const niftySeries = niftyChart.addSeries(CandlestickSeries, {
        upColor: "#10b981", downColor: "#ef4444",
        borderUpColor: "#10b981", borderDownColor: "#ef4444",
        wickUpColor: "#10b981", wickDownColor: "#ef4444",
        priceLineVisible: false,
      });
      niftySeries.setData(nifty100Bars.map((b) => ({
        time: b.date as `${number}-${number}-${number}`,
        open: b.open, high: b.high, low: b.low, close: b.close,
      })));

      // ── Bottom: % LC daily line ──
      const lcChart = createChart(lcRef.current!, {
        ...LAYOUT,
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: SCALE_W },
        timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false },
      });
      const lcSeries = lcChart.addSeries(LineSeries, {
        color: "#ef4444", lineWidth: 2,
        priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      });
      lcSeries.setData(lcBars.map((b) => ({
        time:  b.date as `${number}-${number}-${number}`,
        value: b.pctLc,
      })));

      // Zone reference lines
      for (const { price, color, title, style } of [
        { price: 10, color: "#dc2626", title: "Extreme  ", style: LineStyle.Solid  },
        { price: 3,  color: "#f97316", title: "Stress  ",  style: LineStyle.Dashed },
        { price: 1,  color: "#d97706", title: "Elevated  ", style: LineStyle.Dashed },
      ]) lcSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });

      niftyChart.timeScale().fitContent();
      lcChart.timeScale().fitContent();

      // ── Sync ──
      let syncing = false;
      niftyChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; lcChart.timeScale().setVisibleRange(r); syncing = false;
      });
      lcChart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return; syncing = true; niftyChart.timeScale().setVisibleRange(r); syncing = false;
      });
      niftyChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) lcChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, lcSeries as any);
        else        lcChart.clearCrosshairPosition();
      });
      lcChart.subscribeCrosshairMove((p) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.time) niftyChart.setCrosshairPosition(0, p.time as `${number}-${number}-${number}`, niftySeries as any);
        else        niftyChart.clearCrosshairPosition();
      });

      cleanupRef.current = () => { niftyChart.remove(); lcChart.remove(); };
    })();

    return () => { removed = true; cleanupRef.current?.(); cleanupRef.current = null; };
  }, [nifty100Bars, lcBars]);

  const DIVIDER_HIT = 9;
  const topH = `calc(${(splitRatio * 100).toFixed(3)}% - ${Math.ceil(DIVIDER_HIT / 2)}px)`;
  const botH = `calc(${((1 - splitRatio) * 100).toFixed(3)}% - ${Math.floor(DIVIDER_HIT / 2)}px)`;

  return (
    <div ref={containerRef} className="flex flex-col h-full select-none overflow-hidden bg-white">
      <div className="relative flex-shrink-0" style={{ height: topH, overflow: "hidden" }}>
        <div ref={niftyRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>Nifty 100 · Daily</span>
        </div>
      </div>
      <div className="relative flex-shrink-0 cursor-row-resize z-20" style={{ height: DIVIDER_HIT }}
        onMouseDown={(e) => { dragState.current = { dragging: true, startY: e.clientY, startRatio: splitRatio }; e.preventDefault(); }}>
        <div className="absolute left-0 right-0" style={{ top: "50%", height: 1, background: "#e5e7eb", transform: "translateY(-50%)" }} />
      </div>
      <div className="relative flex-shrink-0" style={{ height: botH, overflow: "hidden" }}>
        <div ref={lcRef} className="absolute inset-0" />
        <div className="absolute top-1.5 left-2 pointer-events-none z-10">
          <span className="text-[9px] font-semibold tracking-widest uppercase" style={{ color: "#9ca3af" }}>% Stocks Hitting LC · Daily</span>
        </div>
      </div>
    </div>
  );
}

// ─── LC Zone config ───────────────────────────────────────────────────────────

const LC_ZONES = [
  { key: "extremePanic" as const, label: "≥ 2.5%",   color: "#dc2626", bg: "#fef2f2" },
  { key: "highStress"   as const, label: "1%–2.5%",  color: "#f97316", bg: "#fff7ed" },
];

// ─── LC Modal (full-screen) ────────────────────────────────────────────────────

function LcModal({ data, onClose }: { data: LcResponse; onClose: () => void }) {
  const [zoneTab, setZoneTab] = useState<"extremePanic" | "highStress">("extremePanic");

  const LC_STATUS_COLORS: Record<string, string> = {
    "Extreme Panic": "#dc2626", "High Stress": "#f97316",
    "Elevated":      "#d97706", "Normal":      "#10b981",
  };
  const sc = LC_STATUS_COLORS[data.lcStatus] ?? "#94a3b8";

  const activeZone  = LC_ZONES.find((z) => z.key === zoneTab)!;
  const activeStats = data.zoneStats[zoneTab];
  const zoneEvents  = data.extremeEvents.filter((e) => e.zoneType === zoneTab);

  return (
    <motion.div className="fixed inset-0 z-50 flex flex-col bg-white overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}>

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-3 sm:px-6 py-3 flex items-center gap-3 sm:gap-5 border-b border-slate-100 flex-wrap"
        style={{ background: "#f8fafc" }}>

        <div className="flex-shrink-0">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex flex-col items-center justify-center shadow-sm bg-white"
            style={{ border: `2px solid ${sc}45` }}>
            <span className="text-xs font-black leading-none tabular-nums" style={{ color: sc }}>
              {data.currentPctLc.toFixed(1)}%
            </span>
            <span className="text-[8px] font-bold text-slate-400 mt-0.5 tracking-wide">LC</span>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-base sm:text-lg font-black text-slate-900">% Stocks Hitting LC</span>
            <span className="text-[11px] font-black px-2.5 py-0.5 rounded-full"
              style={{ background: sc, color: "#fff" }}>{data.lcStatus}</span>
          </div>
          <p className="hidden sm:block text-xs text-slate-500">
            {data.currentLcCount} of {data.currentTotal} Nifty 100 stocks hit Lower Circuit on {data.currentDate}.
            When this spike, markets are in acute panic — historically a contrarian buy signal.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="hidden sm:flex gap-3">
            {[
              { label: "LC Stocks", val: `${data.currentLcCount}`, sub: `of ${data.currentTotal}`, color: sc },
              { label: "% LC",      val: `${data.currentPctLc.toFixed(1)}%`, sub: data.lcStatus, color: sc },
            ].map(({ label, val, sub, color }) => (
              <div key={label} className="text-center px-3 py-1.5 rounded-xl border"
                style={{ borderColor: `${color}30`, background: `${color}08` }}>
                <p className="text-[8px] font-black uppercase tracking-wide text-slate-400">{label}</p>
                <p className="text-sm font-black tabular-nums mt-0.5" style={{ color }}>{val}</p>
                <p className="text-[8px] text-slate-400">{sub}</p>
              </div>
            ))}
          </div>
          <button onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* Chart (left) */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <LcSplitChart lcBars={data.bars} nifty100Bars={data.nifty100Bars} />
        </div>

        {/* Right panel */}
        <div className="w-56 sm:w-64 flex-shrink-0 border-l border-slate-100 overflow-y-auto flex flex-col">

          {/* Zone tabs */}
          <div className="p-4 border-b border-slate-100">
            <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2">Panic Zone Analysis</p>
            <p className="text-[9px] text-slate-500 mb-3 leading-relaxed">
              High LC % = acute panic selling. Contrarian signal — Nifty historically recovers.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {LC_ZONES.map((z) => (
                <button key={z.key} onClick={() => setZoneTab(z.key)}
                  className="px-2 py-1 rounded-lg text-[10px] font-black transition-all"
                  style={zoneTab === z.key
                    ? { background: z.color, color: "#fff" }
                    : { background: z.color + "15", color: z.color }}>
                  {z.label}
                </button>
              ))}
            </div>
          </div>

          {/* Win-rate bars */}
          <div className="p-4 border-b border-slate-100">
            <p className="text-[9px] font-black tracking-widest uppercase mb-2"
              style={{ color: activeZone.color }}>{activeZone.label} → Forward Returns</p>

            {activeStats ? (
              <div className="space-y-2.5">
                <WinRateBar wr={activeStats.winRate5d}  avg={activeStats.avgRet5d}  label="5 Days"  />
                <WinRateBar wr={activeStats.winRate10d} avg={activeStats.avgRet10d} label="10 Days" />
                <WinRateBar wr={activeStats.winRate20d} avg={activeStats.avgRet20d} label="20 Days" />
                <WinRateBar wr={activeStats.winRate1m}  avg={activeStats.avgRet1m}  label="1 Month" />
                <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-[9px] text-slate-400">Avg Max Drawdown</span>
                  <span className="text-[11px] font-black text-red-500">
                    {activeStats.avgMaxDrawdown >= 0 ? "+" : ""}{activeStats.avgMaxDrawdown}%
                  </span>
                </div>
                <p className="text-[8px] text-slate-400">{activeStats.totalEvents} events in dataset</p>
              </div>
            ) : (
              <p className="text-[10px] text-slate-400 italic">No events detected for this zone.</p>
            )}
          </div>

          {/* Event list */}
          {zoneEvents.length > 0 && (
            <div className="p-4">
              <p className="text-[9px] font-black tracking-widest uppercase text-slate-400 mb-2">
                All {activeZone.label} Events ({zoneEvents.length})
              </p>
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {[...zoneEvents].reverse().map((e, i) => (
                  <div key={i} className="flex items-start justify-between gap-2 py-1.5 border-b border-slate-50 last:border-0">
                    <div>
                      <p className="text-[10px] font-black text-slate-700">{e.date}</p>
                      <p className="text-[9px] text-slate-400">{e.pctLc.toFixed(1)}% LC · ₹{Math.round(e.nifty100Close).toLocaleString("en-IN")}</p>
                    </div>
                    <div className="text-right flex-shrink-0 space-y-0.5">
                      {e.ret5d !== null && (
                        <p className="text-[9px] font-black" style={{ color: e.ret5d >= 0 ? "#10b981" : "#ef4444" }}>
                          {e.ret5d >= 0 ? "+" : ""}{e.ret5d}% <span className="text-slate-400 font-normal">5d</span>
                        </p>
                      )}
                      {e.ret1m !== null ? (
                        <p className="text-[9px] font-black" style={{ color: e.ret1m >= 0 ? "#10b981" : "#ef4444" }}>
                          {e.ret1m >= 0 ? "+" : ""}{e.ret1m}% <span className="text-slate-400 font-normal">1m</span>
                        </p>
                      ) : <p className="text-[9px] text-slate-300">—</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── LC Intelligence Card (compact) ───────────────────────────────────────────

function LcIntelligenceCard() {
  const { data } = useSWR<LcResponse>("/api/lc", fetcher, { refreshInterval: 600_000 });
  const [modalOpen, setModalOpen] = useState(false);

  if (!data?.hasData) return null;

  const LC_STATUS_COLORS: Record<string, string> = {
    "Extreme Panic": "#dc2626", "High Stress": "#f97316",
    "Elevated":      "#d97706", "Normal":      "#10b981",
  };
  const sc         = LC_STATUS_COLORS[data.lcStatus] ?? "#10b981";
  const panicStats = data.zoneStats.extremePanic;

  return (
    <>
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {modalOpen && <LcModal data={data} onClose={() => setModalOpen(false)} />}
        </AnimatePresence>,
        document.body
      )}

      <motion.button onClick={() => setModalOpen(true)}
        className="w-full rounded-xl text-left overflow-hidden bg-white shadow-sm"
        style={{ border: `1.5px solid ${sc}35` }}
        whileHover={{ scale: 1.004, boxShadow: `0 4px 20px ${sc}18` }}
        transition={{ duration: 0.15 }}>

        <div className="px-5 py-4 flex items-center gap-5 flex-wrap">

          {/* Icon + value */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: sc + "15", border: `1px solid ${sc}40` }}>
              <ArrowDownRight size={16} style={{ color: sc }} />
            </div>
            <div>
              <p className="text-[8px] font-black tracking-widest uppercase text-slate-400">% Hitting LC · Nifty 100</p>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span className="text-xl font-black tabular-nums leading-none" style={{ color: sc }}>
                  {data.currentPctLc.toFixed(1)}%
                </span>
                <span className="text-[10px] font-bold" style={{ color: sc }}>
                  {data.currentLcCount} stocks
                </span>
              </div>
            </div>
          </div>

          {/* Status badge */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-black px-2 py-0.5 rounded-full w-fit"
              style={{ background: sc + "20", color: sc }}>{data.lcStatus}</span>
            <span className="text-[9px] text-slate-400 pl-0.5">{data.currentLcCount} / {data.currentTotal} stocks</span>
          </div>

          {/* Panic stats if available */}
          {panicStats && (
            <div className="flex-shrink-0 px-3 py-1.5 rounded-lg border"
              style={{ borderColor: "#dc262630", background: "#dc262608" }}>
              <p className="text-[8px] font-black text-slate-400 mb-0.5">{panicStats.totalEvents} panic events · 1M avg</p>
              <p className="text-xs font-black tabular-nums"
                style={{ color: panicStats.avgRet1m >= 0 ? "#10b981" : "#ef4444" }}>
                {panicStats.avgRet1m >= 0 ? "+" : ""}{panicStats.avgRet1m}%
              </p>
            </div>
          )}

          {/* LC gauge bar */}
          <div className="w-full">
            <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-100">
              <div className="rounded-full transition-all duration-700"
                style={{ width: `${Math.min(data.currentPctLc / 4 * 100, 100)}%`, background: sc }} />
            </div>
            <div className="flex justify-between text-[8px] text-slate-400 mt-0.5">
              <span>Normal</span>
              <span className="font-bold" style={{ color: sc }}>{data.currentPctLc.toFixed(1)}% stocks hitting LC</span>
              <span>Extreme ≥4%</span>
            </div>
          </div>

        </div>
      </motion.button>
    </>
  );
}

// ─── BB Intelligence Card (compact) ──────────────────────────────────────────

function BbIntelligenceCard() {
  const { data } = useSWR<BbResponse>("/api/bb?index=nifty50", fetcher, { refreshInterval: 600_000 });
  const [modalOpen, setModalOpen] = useState(false);

  if (!data) return null;
  if (!data.hasData) return null;

  const { summary, currentPercentB, isTouching, isNearLower, indexLabel } = data;
  const pbColor = isTouching ? "#059669" : isNearLower ? "#d97706" : "#3b82f6";
  const pbLabel = isTouching ? "At Lower BB" : isNearLower ? "Near Lower BB" : "Normal Range";

  return (
    <>
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {modalOpen && <BbModal data={data} onClose={() => setModalOpen(false)} />}
        </AnimatePresence>,
        document.body
      )}

      <motion.button onClick={() => setModalOpen(true)}
        className="w-full rounded-xl text-left overflow-hidden bg-white shadow-sm"
        style={{ border: `1.5px solid ${pbColor}35` }}
        whileHover={{ scale: 1.004, boxShadow: `0 4px 20px ${pbColor}18` }}
        transition={{ duration: 0.15 }}>

        <div className="px-5 py-4 flex items-center gap-5 flex-wrap">

          {/* Icon */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: pbColor + "15", border: `1px solid ${pbColor}40` }}>
              <Layers size={16} style={{ color: pbColor }} />
            </div>
            <div>
              <p className="text-[8px] font-black tracking-widest uppercase text-slate-400">Lower BB Thesis · {indexLabel}</p>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span className="text-xl font-black tabular-nums leading-none" style={{ color: pbColor }}>
                  {(currentPercentB * 100).toFixed(0)}%B
                </span>
                <span className="text-[10px] font-black px-1.5 py-0.5 rounded"
                  style={{ background: pbColor + "20", color: pbColor }}>{pbLabel}</span>
              </div>
            </div>
          </div>

          {/* Thesis headline */}
          <div className="flex flex-col gap-0.5">
            <p className="text-[8px] font-black tracking-widest uppercase text-slate-400">18M after BB touch</p>
            <p className="text-2xl font-black leading-none" style={{ color: "#10b981" }}>{summary.winRate18m}%</p>
            <p className="text-[9px] text-slate-400">win rate · {summary.totalEvents} events</p>
          </div>

          {/* Avg returns */}
          <div className="flex flex-col gap-0.5">
            <p className="text-[8px] font-black tracking-widest uppercase text-slate-400">Avg 18M return</p>
            <p className="text-lg font-black leading-none" style={{ color: summary.avgRet18m >= 0 ? "#10b981" : "#ef4444" }}>
              {summary.avgRet18m >= 0 ? "+" : ""}{summary.avgRet18m}%
            </p>
            <p className="text-[9px] text-slate-400">post lower-BB touch</p>
          </div>

          {/* Alert if touching */}
          {(isTouching || isNearLower) && (
            <div className="flex-shrink-0 px-3 py-2 rounded-lg border"
              style={{ borderColor: pbColor + "50", background: pbColor + "0d" }}>
              <p className="text-[9px] font-black" style={{ color: pbColor }}>
                {isTouching ? "⚡ Lower BB Touch — Thesis Active" : "⚠ Approaching Lower BB"}
              </p>
              <p className="text-[8px] text-slate-500 mt-0.5">Historical 18M avg: +{summary.avgRet18m}%</p>
            </div>
          )}

          {/* %B progress bar */}
          <div className="w-full">
            <div className="h-1.5 rounded-full overflow-hidden bg-slate-100">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${Math.max(0, Math.min(100, currentPercentB * 100)).toFixed(1)}%`, background: pbColor }} />
            </div>
            <div className="flex justify-between text-[8px] text-slate-400 mt-0.5">
              <span>Lower BB</span><span>Middle</span><span>Upper BB</span>
            </div>
          </div>

        </div>
      </motion.button>
    </>
  );
}

// ─── Class list view (Level 1) ─────────────────────────────────────────────────

function ClassView({ cls, onSelect }: { cls: AssetClassData; onSelect: (a: AssetData) => void }) {
  const s = sig(cls.aggregate.signal);
  const isIndiaEquities = cls.id === "indian-equities";

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-slate-100 px-4 sm:px-6 py-4 sm:py-5 shadow-sm">
        <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
          <span className="text-2xl">{cls.icon}</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-black text-slate-900">{cls.name}</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {cls.assets?.filter((a) => a.hasData).length ?? 0} assets with live data
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Pill signal={cls.aggregate.signal} />
            <Arc value={cls.aggregate.composite} size={44} color={s.hex} />
          </div>
        </div>
      </div>

      {/* Intelligence Panels — Indian Equities only */}
      {isIndiaEquities && (
        <div className="space-y-3">
          <VixIntelligenceCard />
          <RsiIntelligenceCard />
          <RocIntelligenceCard />
          <BbIntelligenceCard />
          <AdIntelligenceCard />
          <Dma200IntelligenceCard />
          <LcIntelligenceCard />
        </div>
      )}

      <div className="space-y-2">
        {cls.assets?.map((a, i) => (
          <AssetRow key={a.ticker} asset={a} idx={i} onClick={() => onSelect(a)} />
        ))}
      </div>
    </div>
  );
}

// ─── Refresh hook + drawer ────────────────────────────────────────────────────

type RefreshStatus = "idle" | "running" | "done" | "error";

function useRefresh(onDone: () => void) {
  const [status,   setStatus]   = useState<RefreshStatus>("idle");
  const [logs,     setLogs]     = useState<string[]>([]);
  const [lastAt,   setLastAt]   = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async () => {
    if (status === "running") return;
    setStatus("running"); setLogs([]); setShowLogs(true);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.body) throw new Error("No body");
      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
        for (const p of parts) {
          const line = p.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const m = JSON.parse(line) as { line?: string; done?: boolean; code?: number };
            if (m.line) setLogs((x) => [...x, m.line!]);
            if (m.done) {
              const ok = m.code === 0;
              setStatus(ok ? "done" : "error");
              if (ok) { setLastAt(new Date().toLocaleTimeString()); onDone(); }
            }
          } catch { /* ignore */ }
        }
      }
    } catch (e) { setLogs((x) => [...x, `❌ ${e}`]); setStatus("error"); }
  }, [status, onDone]);

  useEffect(() => {
    timer.current = setTimeout(() => run(), 6 * 60 * 60 * 1000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [lastAt, run]);

  return { status, logs, lastAt, showLogs, setShowLogs, run };
}

function RefreshDrawer({ logs, status, onClose }: { logs: string[]; status: RefreshStatus; onClose: () => void }) {
  const bot = useRef<HTMLDivElement>(null);
  useEffect(() => { bot.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
      className="fixed bottom-4 right-4 left-4 sm:left-auto sm:bottom-6 sm:right-6 z-50 sm:w-96 bg-slate-950 rounded-2xl shadow-2xl border border-slate-800 overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Database size={12} className="text-indigo-400" />
          <span className="text-xs font-bold text-white">Indicator Refresh</span>
          {status === "running" && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping" />}
          {status === "done"    && <CheckCircle2 size={12} className="text-emerald-400" />}
          {status === "error"   && <AlertCircle  size={12} className="text-red-400" />}
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
          <X size={13} />
        </button>
      </div>
      <div className="h-40 overflow-y-auto px-4 py-3 font-mono text-[10px] space-y-0.5">
        {logs.map((l, i) => (
          <div key={i} className={
            l.startsWith("✅") ? "text-emerald-400"
            : l.startsWith("❌") ? "text-red-400"
            : l.startsWith("  ✓") ? "text-slate-300"
            : "text-slate-500"
          }>{l}</div>
        ))}
        {status === "running" && <div className="text-slate-600 animate-pulse">▌</div>}
        <div ref={bot} />
      </div>
    </motion.div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function SignalsPage() {
  const { data, isLoading, error, mutate } = useSWR<SignalsV2Response>(
    "/api/signals/v2", fetcher, { refreshInterval: 120_000 }
  );
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [selectedTicker,  setSelectedTicker]  = useState<string | null>(null);

  const selectedClass = data?.assetClasses?.find((c) => c.id === selectedClassId) ?? null;
  const selectedAsset = selectedClass?.assets?.find((a) => a.ticker === selectedTicker) ?? null;
  const level = selectedTicker ? 2 : selectedClassId ? 1 : 0;

  const { status: rs, logs, lastAt, showLogs, setShowLogs, run: refresh } = useRefresh(() => mutate());

  return (
    <div className="min-h-full -m-6 bg-slate-50">

      <AnimatePresence>
        {showLogs && <RefreshDrawer logs={logs} status={rs} onClose={() => setShowLogs(false)} />}
      </AnimatePresence>

      {/* Sticky header */}
      <div className="bg-white/90 backdrop-blur-sm border-b border-slate-200/70 px-3 sm:px-6 py-3 sm:py-4 sticky top-0 z-20">
        <div className="flex items-center justify-between gap-2 sm:gap-4">

          {/* Breadcrumb */}
          <div className="flex items-center gap-2 min-w-0">
            {level > 0 && (
              <button
                onClick={() => { if (level === 2) setSelectedTicker(null); else { setSelectedClassId(null); setSelectedTicker(null); } }}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg transition-all flex-shrink-0">
                <ArrowLeft size={11} /> Back
              </button>
            )}
            <nav className="flex items-center gap-1.5 text-sm min-w-0">
              <button onClick={() => { setSelectedClassId(null); setSelectedTicker(null); }}
                className={`font-black truncate transition-colors ${level === 0 ? "text-slate-900" : "text-slate-400 hover:text-slate-700"}`}>
                Capital Signals
              </button>
              {selectedClass && (
                <>
                  <ChevronRight size={13} className="text-slate-300 flex-shrink-0" />
                  <button onClick={() => setSelectedTicker(null)}
                    className={`font-bold truncate transition-colors ${level === 1 ? "text-slate-900" : "text-slate-400 hover:text-slate-700"}`}>
                    {selectedClass.name}
                  </button>
                </>
              )}
              {selectedAsset && (
                <>
                  <ChevronRight size={13} className="text-slate-300 flex-shrink-0" />
                  <span className="font-black text-slate-900 truncate">{selectedAsset.name}</span>
                </>
              )}
            </nav>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {level === 0 && data?.assetClasses && (
              <span className="text-[10px] text-slate-400 hidden sm:block font-medium">
                {data.assetClasses.length} classes · {data.assetClasses.reduce((s, c) => s + (c.assets?.filter((a) => a.hasData).length ?? 0), 0)} live
              </span>
            )}
            {lastAt && (
              <span className="hidden sm:flex items-center gap-1 text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-100 px-2.5 py-1.5 rounded-lg font-medium">
                <Clock size={9} /> {lastAt}
              </span>
            )}
            <button onClick={refresh} disabled={rs === "running"}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
                rs === "running" ? "bg-indigo-50 border-indigo-200 text-indigo-500 cursor-wait"
                : rs === "done"  ? "bg-emerald-50 border-emerald-200 text-emerald-600"
                : rs === "error" ? "bg-red-50 border-red-200 text-red-600"
                : "bg-white border-slate-200 text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
              }`}>
              <Database size={11} className={rs === "running" ? "animate-pulse" : ""} />
              {rs === "running" ? "Refreshing…" : rs === "done" ? "Refreshed" : rs === "error" ? "Retry" : "Refresh"}
            </button>
            <button onClick={() => mutate()} disabled={isLoading}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-700 bg-white border border-slate-200 hover:border-slate-300 px-3 py-1.5 rounded-lg transition-all disabled:opacity-50">
              <RefreshCw size={11} className={isLoading ? "animate-spin" : ""} />
              Reload
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-3 sm:p-6">

        {error && (
          <div className="flex items-center gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-5 font-medium">
            <AlertCircle size={15} /> Failed to load signals. Make sure prices are ingested.
          </div>
        )}

        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 animate-pulse">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-60 rounded-2xl bg-white border border-slate-100" />
            ))}
          </div>
        )}

        {/* Level 0 — class grid */}
        {!isLoading && level === 0 && data?.assetClasses && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.assetClasses.map((cls, i) => (
              <ClassCard key={cls.id} cls={cls} idx={i} onClick={() => setSelectedClassId(cls.id)} />
            ))}
          </div>
        )}

        {/* Level 1 — asset list */}
        {!isLoading && level === 1 && selectedClass && (
          <ClassView cls={selectedClass} onSelect={(a) => setSelectedTicker(a.ticker)} />
        )}

        {/* Level 2 — asset dashboard */}
        {!isLoading && level === 2 && selectedClass && selectedAsset && (
          <AssetDashboard asset={selectedAsset} cls={selectedClass} allAssets={selectedClass.assets} />
        )}
      </div>
    </div>
  );
}
