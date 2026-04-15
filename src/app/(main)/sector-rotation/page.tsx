"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import useSWR from "swr";
import {
  TrendingUp, TrendingDown, Minus,
  RefreshCw, AlertCircle, ArrowUpRight,
  ArrowDownRight, Activity, ChevronRight,
  BarChart2, Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SectorNode } from "@/components/charts/SectorFlowMap";

const SectorFlowMap = dynamic(
  () => import("@/components/charts/SectorFlowMap"),
  { ssr: false, loading: () => <div className="h-[480px] rounded-2xl bg-[#0f1629] animate-pulse" /> }
);

// ─── Types ────────────────────────────────────────────────────────────────────
interface SectorData {
  id: string; name: string; ticker: string;
  cycleSector: "Cyclical" | "Defensive" | "Sensitive";
  color: string;
  price: number; change1D: number; change1M: number; change3M: number;
  rsi: number; macdHistogram: number; relStrength: number;
  flowScore: number; flowDirection: "Inflow" | "Outflow" | "Neutral";
  flowStrength: "Strong" | "Moderate" | "Weak";
  momentum5D: number[];
}

interface CyclePhaseInfo {
  phase: string; description: string;
  prevPhase: string; nextPhase: string;
  confidence: number;
  leadingSectors: string[]; laggingSectors: string[];
  color: string; bgColor: string;
}

interface SectorRotationResponse {
  sectors: SectorData[];
  cycle: CyclePhaseInfo;
  topInflow: string[]; topOutflow: string[];
  rotationTheme: string; timestamp: string;
}

const fetcher = (url: string) => fetch(url).then(r => r.json());

// ─── Cycle phases in clock order ─────────────────────────────────────────────
const CYCLE_ORDER = [
  "Early Recovery", "Early Expansion", "Mid Expansion",
  "Late Expansion", "Early Contraction", "Late Contraction",
];
const CYCLE_META: Record<string, { color: string; bg: string; icon: string }> = {
  "Early Recovery":    { color: "#22c55e", bg: "#052e16", icon: "↗" },
  "Early Expansion":   { color: "#3b82f6", bg: "#0c1a2e", icon: "⬆" },
  "Mid Expansion":     { color: "#8b5cf6", bg: "#1a0d2e", icon: "⬆" },
  "Late Expansion":    { color: "#f59e0b", bg: "#2d1a00", icon: "→" },
  "Early Contraction": { color: "#ef4444", bg: "#2d0808", icon: "↘" },
  "Late Contraction":  { color: "#dc2626", bg: "#1a0404", icon: "⬇" },
};

// ─── Mini sparkline ───────────────────────────────────────────────────────────
function Spark({ data, color, h = 24, w = 56 }: { data: number[]; color: string; h?: number; w?: number }) {
  if (data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 2) - 1}`
  ).join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Cycle Clock SVG ─────────────────────────────────────────────────────────
function CycleClock({ phase, confidence }: { phase: string; confidence: number }) {
  const n = CYCLE_ORDER.length;
  const activeIdx = CYCLE_ORDER.indexOf(phase);
  const cx = 100, cy = 100, R = 72, rIn = 44, rMid = 58;

  return (
    <svg viewBox="0 0 200 200" className="w-full max-w-[200px]">
      {CYCLE_ORDER.map((p, i) => {
        const gap = 0.04;
        const start = (i / n) * 2 * Math.PI - Math.PI / 2 + gap;
        const end   = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2 - gap;
        const x1 = cx + R * Math.cos(start), y1 = cy + R * Math.sin(start);
        const x2 = cx + R * Math.cos(end),   y2 = cy + R * Math.sin(end);
        const x3 = cx + rIn * Math.cos(end), y3 = cy + rIn * Math.sin(end);
        const x4 = cx + rIn * Math.cos(start), y4 = cy + rIn * Math.sin(start);
        const d = `M${x1},${y1} A${R},${R} 0 0 1 ${x2},${y2} L${x3},${y3} A${rIn},${rIn} 0 0 0 ${x4},${y4} Z`;
        const mid = (start + end) / 2;
        const lx = cx + rMid * Math.cos(mid), ly = cy + rMid * Math.sin(mid);
        const isActive = i === activeIdx;
        const meta = CYCLE_META[p];
        return (
          <g key={p}>
            <motion.path d={d} fill={isActive ? meta.color : "#1e2535"}
              stroke="#0f1629" strokeWidth={1.5}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ delay: i * 0.07 }} />
            <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
              fontSize={isActive ? 6.5 : 5.5}
              fontWeight={isActive ? "800" : "500"}
              fill={isActive ? "white" : "rgba(255,255,255,0.3)"}>
              {p.split(" ").map((w, wi) => (
                <tspan key={wi} x={lx} dy={wi === 0 ? (p.split(" ").length > 1 ? "-3.5" : "0") : "8"}>{w}</tspan>
              ))}
            </text>
          </g>
        );
      })}
      {/* Centre */}
      <circle cx={cx} cy={cy} r={38} fill="#0f1629" stroke="#1e2535" strokeWidth={1} />
      {/* Confidence arc */}
      <circle cx={cx} cy={cy} r={34} fill="none" stroke="#1e2535" strokeWidth={3.5} />
      <motion.circle cx={cx} cy={cy} r={34} fill="none"
        stroke={CYCLE_META[phase]?.color ?? "#6366f1"} strokeWidth={3.5}
        strokeLinecap="round"
        strokeDasharray={`${2 * Math.PI * 34}`}
        initial={{ strokeDashoffset: 2 * Math.PI * 34 }}
        animate={{ strokeDashoffset: 2 * Math.PI * 34 * (1 - confidence) }}
        transition={{ duration: 1.4, ease: "easeOut" }}
        transform={`rotate(-90 ${cx} ${cy})`} />
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize={8} fill="rgba(255,255,255,0.4)" fontWeight="600">PHASE</text>
      <text x={cx} y={cy + 3} textAnchor="middle" fontSize={8.5} fontWeight="800"
        fill={CYCLE_META[phase]?.color ?? "#fff"}>
        {phase.split(" ")[0]}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize={8.5} fontWeight="800"
        fill={CYCLE_META[phase]?.color ?? "#fff"}>
        {phase.split(" ").slice(1).join(" ")}
      </text>
      <text x={cx} y={cy + 26} textAnchor="middle" fontSize={7}
        fill="rgba(255,255,255,0.35)">{Math.round(confidence * 100)}% conf.</text>
    </svg>
  );
}

// ─── Flow score horizontal bar ────────────────────────────────────────────────
function HorizBar({ sector, rank }: { sector: SectorData; rank: number }) {
  const isIn  = sector.flowDirection === "Inflow";
  const isOut = sector.flowDirection === "Outflow";
  const barColor = isIn ? "#22c55e" : isOut ? "#ef4444" : "#6b7280";
  const pct = Math.abs(sector.flowScore);  // 0–100

  return (
    <motion.div
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: rank * 0.05 }}
      className="flex items-center gap-3 group"
    >
      {/* Rank */}
      <span className="w-5 text-[10px] font-bold text-muted-foreground text-right shrink-0">
        #{rank + 1}
      </span>
      {/* Color dot */}
      <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: sector.color }} />
      {/* Name */}
      <span className="text-xs font-semibold text-foreground w-36 truncate shrink-0">{sector.name}</span>
      {/* Bar */}
      <div className="flex-1 relative h-5 flex items-center">
        <div className="absolute inset-0 rounded-full bg-[#F0EDE6]" />
        <motion.div
          className="absolute left-0 top-0 h-full rounded-full"
          style={{ backgroundColor: barColor + "30", width: "100%" }}
        />
        <motion.div
          className="absolute left-0 top-0 h-full rounded-full"
          style={{ backgroundColor: barColor }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: "easeOut", delay: rank * 0.04 }}
        />
        <span className="absolute right-2 text-[10px] font-bold tabular-nums" style={{ color: barColor }}>
          {sector.flowScore > 0 ? "+" : ""}{sector.flowScore.toFixed(0)}
        </span>
      </div>
      {/* 1M */}
      <span className={cn(
        "text-xs font-semibold tabular-nums w-16 text-right shrink-0",
        sector.change1M > 0 ? "text-emerald-600" : sector.change1M < 0 ? "text-red-600" : "text-muted-foreground"
      )}>
        {sector.change1M > 0 ? "+" : ""}{sector.change1M.toFixed(2)}%
      </span>
      {/* Direction badge */}
      <span className={cn(
        "shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide w-14 text-center",
        isIn  ? "bg-emerald-50 text-emerald-700 border border-emerald-200" :
        isOut ? "bg-red-50 text-red-700 border border-red-200" :
                "bg-stone-50 text-stone-500 border border-stone-200"
      )}>
        {isIn ? "Inflow" : isOut ? "Outflow" : "Neutral"}
      </span>
    </motion.div>
  );
}

// ─── Sector tile for heatmap ──────────────────────────────────────────────────
function HeatTile({ sector, index }: { sector: SectorData; index: number }) {
  const isIn  = sector.flowDirection === "Inflow";
  const isOut = sector.flowDirection === "Outflow";
  const intensity = Math.abs(sector.flowScore) / 100;

  const bg = isIn
    ? `rgba(34,197,94,${0.08 + intensity * 0.45})`
    : isOut
    ? `rgba(239,68,68,${0.08 + intensity * 0.45})`
    : "rgba(107,114,128,0.08)";

  const border = isIn
    ? `rgba(34,197,94,${0.25 + intensity * 0.45})`
    : isOut
    ? `rgba(239,68,68,${0.25 + intensity * 0.45})`
    : "rgba(107,114,128,0.2)";

  const textColor = isIn ? "#15803d" : isOut ? "#b91c1c" : "#78716c";

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.04, type: "spring", stiffness: 260, damping: 20 }}
      className="rounded-xl border p-3 flex flex-col gap-1.5"
      style={{ backgroundColor: bg, borderColor: border }}
    >
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: sector.color }} />
          <span className="text-[10px] font-bold text-foreground leading-tight truncate">{sector.name}</span>
        </div>
        <span className="text-[9px] font-semibold shrink-0" style={{ color: textColor }}>
          {sector.cycleSector[0]}
        </span>
      </div>
      <div className="flex items-end justify-between">
        <p className="text-xl font-black tabular-nums leading-none" style={{ color: textColor }}>
          {sector.flowScore > 0 ? "+" : ""}{sector.flowScore.toFixed(0)}
        </p>
        <Spark data={sector.momentum5D} color={sector.color} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">1M</span>
        <span className={cn("text-[10px] font-bold tabular-nums",
          sector.change1M > 0 ? "text-emerald-700" : sector.change1M < 0 ? "text-red-700" : "text-muted-foreground"
        )}>
          {sector.change1M > 0 ? "+" : ""}{sector.change1M.toFixed(1)}%
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">RSI</span>
        <span className={cn("text-[10px] font-bold tabular-nums",
          sector.rsi > 70 ? "text-red-600" : sector.rsi < 30 ? "text-emerald-600" : "text-foreground"
        )}>
          {sector.rsi.toFixed(0)}
        </span>
      </div>
    </motion.div>
  );
}

// ─── Flow detail row ──────────────────────────────────────────────────────────
function SectorDetailRow({ s, i }: { s: SectorData; i: number }) {
  const isIn  = s.flowDirection === "Inflow";
  const isOut = s.flowDirection === "Outflow";
  return (
    <motion.tr
      initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
      transition={{ delay: i * 0.03 }}
      className="border-b border-[#F0EDE6] hover:bg-[#FAFAF8] transition-colors"
    >
      <td className="py-2.5 pl-4 pr-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
          <div>
            <p className="text-xs font-semibold text-foreground">{s.name}</p>
            <p className="text-[9px] font-mono text-muted-foreground">{s.ticker}</p>
          </div>
        </div>
      </td>
      <td className="py-2.5 pr-2">
        <span className={cn("rounded-md px-1.5 py-0.5 text-[9px] font-semibold",
          s.cycleSector === "Cyclical"  && "bg-blue-50 text-blue-700",
          s.cycleSector === "Defensive" && "bg-green-50 text-green-700",
          s.cycleSector === "Sensitive" && "bg-orange-50 text-orange-700",
        )}>{s.cycleSector}</span>
      </td>
      {[s.change1D, s.change1M, s.change3M].map((v, j) => (
        <td key={j} className="py-2.5 pr-3 text-right">
          <span className={cn("text-xs font-semibold tabular-nums",
            v > 0 ? "text-emerald-600" : v < 0 ? "text-red-600" : "text-muted-foreground"
          )}>{v > 0 ? "+" : ""}{v.toFixed(2)}%</span>
        </td>
      ))}
      <td className="py-2.5 pr-3 text-right">
        <span className={cn("text-xs font-medium tabular-nums",
          s.rsi > 70 ? "text-red-600" : s.rsi < 30 ? "text-emerald-600" : "text-foreground"
        )}>{s.rsi.toFixed(1)}</span>
      </td>
      <td className="py-2.5 pr-3 text-right">
        <span className={cn("text-xs font-medium tabular-nums",
          s.relStrength > 105 ? "text-emerald-600" : s.relStrength < 95 ? "text-red-600" : "text-foreground"
        )}>{s.relStrength.toFixed(1)}</span>
      </td>
      <td className="py-2.5 pr-3">
        <Spark data={s.momentum5D} color={s.color} />
      </td>
      <td className="py-2.5 pr-4 text-right">
        <span className={cn(
          "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold",
          isIn  ? "bg-emerald-50 border-emerald-200 text-emerald-700" :
          isOut ? "bg-red-50 border-red-200 text-red-700" :
                  "bg-stone-50 border-stone-200 text-stone-500"
        )}>
          {isIn ? <ArrowUpRight size={9} /> : isOut ? <ArrowDownRight size={9} /> : <Minus size={9} />}
          {s.flowStrength} {s.flowDirection}
        </span>
      </td>
    </motion.tr>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function SectorRotationPage() {
  const [tableFilter, setTableFilter] = useState<"all" | "Cyclical" | "Defensive" | "Sensitive">("all");

  const { data, error, isLoading, isValidating, mutate } =
    useSWR<SectorRotationResponse>("/api/sector-rotation", fetcher, {
      refreshInterval: 5 * 60 * 1000,
    });

  const isFetching = isLoading || isValidating;

  // Sorted sectors for rankings chart
  const sortedSectors = useMemo(() =>
    [...(data?.sectors ?? [])].sort((a, b) => b.flowScore - a.flowScore),
    [data]
  );

  // For the D3 map
  const sectorNodes: SectorNode[] = useMemo(() =>
    (data?.sectors ?? []).map(s => ({
      id:            s.id,
      name:          s.name,
      color:         s.color,
      flowScore:     s.flowScore,
      flowDirection: s.flowDirection,
      rsi:           s.rsi,
      change1M:      s.change1M,
      relStrength:   s.relStrength,
    })),
    [data]
  );

  const filteredSectors = useMemo(() =>
    tableFilter === "all"
      ? sortedSectors
      : sortedSectors.filter(s => s.cycleSector === tableFilter),
    [sortedSectors, tableFilter]
  );

  const cycle = data?.cycle;
  const cycleMeta = cycle ? (CYCLE_META[cycle.phase] ?? CYCLE_META["Early Contraction"]) : null;

  const stats = useMemo(() => {
    const all = data?.sectors ?? [];
    return {
      inflow:  all.filter(s => s.flowDirection === "Inflow").length,
      outflow: all.filter(s => s.flowDirection === "Outflow").length,
      neutral: all.filter(s => s.flowDirection === "Neutral").length,
    };
  }, [data]);

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertCircle size={15} />
        Failed to load sector data. Run <code className="mx-1 font-mono bg-red-100 px-1 rounded">python3 scripts/fetch_prices.py --history</code> first.
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── 1. Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">Sector Rotation</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Live capital inflow / outflow across NSE sector indices · Powered by real price data
          </p>
        </div>
        <button
          onClick={() => mutate()}
          disabled={isFetching}
          className="flex items-center gap-1.5 rounded-lg border border-[#DDD9D0] bg-white px-3 py-1.5 text-xs text-muted-foreground hover:bg-[#F0EDE6] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={11} className={cn(isFetching && "animate-spin")} />
          {isFetching ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* ── 2. Cycle Phase Banner ──────────────────────────────────────────── */}
      <AnimatePresence>
        {cycle && cycleMeta && (
          <motion.div
            key="cycle-banner"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative overflow-hidden rounded-2xl border px-5 py-4"
            style={{ borderColor: cycleMeta.color + "40", background: `linear-gradient(135deg, ${cycleMeta.bg} 0%, #0f1629 100%)` }}
          >
            <div className="flex flex-wrap items-center gap-4">
              {/* Phase badge */}
              <div className="flex items-center gap-3 shrink-0">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-xl font-black"
                  style={{ background: cycleMeta.color + "25", color: cycleMeta.color }}
                >
                  {cycleMeta.icon}
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: cycleMeta.color + "aa" }}>
                    Economic Cycle
                  </p>
                  <p className="text-base font-black leading-tight" style={{ color: cycleMeta.color }}>
                    {cycle.phase}
                  </p>
                </div>
              </div>
              {/* Divider */}
              <div className="h-10 w-px bg-white/10 hidden sm:block" />
              {/* Theme */}
              <p className="flex-1 text-sm text-white/70 leading-relaxed">{data?.rotationTheme}</p>
              {/* Confidence */}
              <div className="shrink-0 text-right">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Confidence</p>
                <p className="text-2xl font-black" style={{ color: cycleMeta.color }}>
                  {Math.round(cycle.confidence * 100)}%
                </p>
              </div>
              {/* Inflow/Outflow/Neutral pills */}
              <div className="flex gap-2 shrink-0">
                <div className="rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-3 py-1.5 text-center">
                  <p className="text-[9px] text-emerald-400/70 uppercase tracking-wider">Inflow</p>
                  <p className="text-lg font-black text-emerald-400">{stats.inflow}</p>
                </div>
                <div className="rounded-lg bg-red-500/15 border border-red-500/30 px-3 py-1.5 text-center">
                  <p className="text-[9px] text-red-400/70 uppercase tracking-wider">Outflow</p>
                  <p className="text-lg font-black text-red-400">{stats.outflow}</p>
                </div>
                <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-1.5 text-center">
                  <p className="text-[9px] text-white/40 uppercase tracking-wider">Neutral</p>
                  <p className="text-lg font-black text-white/50">{stats.neutral}</p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 3. Main zone: Flow Map + Cycle Info + Rankings ─────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-5">

        {/* Left: D3 sector flow map */}
        <div className="rounded-2xl overflow-hidden"
          style={{ background: "linear-gradient(135deg, #0f1629 0%, #1a2744 100%)", border: "1px solid rgba(255,255,255,0.08)" }}>
          <div className="px-5 pt-4 pb-2 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-white">Capital Flow Network</p>
              <p className="text-[11px] text-white/40">Animated flows show capital moving from outflow → inflow sectors</p>
            </div>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1.5 text-emerald-400/80">
                <span className="h-1.5 w-4 rounded-full bg-emerald-500" />Inflow
              </span>
              <span className="flex items-center gap-1.5 text-red-400/80">
                <span className="h-1.5 w-4 rounded-full bg-red-500" />Outflow
              </span>
            </div>
          </div>
          {isLoading ? (
            <div className="h-[480px] animate-pulse" style={{ background: "rgba(255,255,255,0.03)" }} />
          ) : sectorNodes.length > 0 ? (
            <SectorFlowMap sectors={sectorNodes} width={640} height={480} animated />
          ) : (
            <div className="h-[480px] flex items-center justify-center">
              <p className="text-white/30 text-sm">No sector data — run fetch_prices.py --history</p>
            </div>
          )}
        </div>

        {/* Right: Cycle + Top Inflow/Outflow */}
        <div className="flex flex-col gap-4">

          {/* Cycle navigator */}
          <div className="rounded-2xl border border-[#DDD9D0] bg-white p-4">
            {isLoading ? (
              <div className="h-48 animate-pulse rounded-lg bg-[#F0EDE6]" />
            ) : cycle ? (
              <>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-bold text-foreground uppercase tracking-wide">Economic Cycle Clock</p>
                  <span className="text-[10px] font-semibold rounded-full px-2 py-0.5"
                    style={{ backgroundColor: cycleMeta?.color + "15", color: cycleMeta?.color }}>
                    {Math.round(cycle.confidence * 100)}% conf.
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <CycleClock phase={cycle.phase} confidence={cycle.confidence} />
                  <div className="flex-1 space-y-3">
                    {/* Prev → Current → Next */}
                    {[
                      { label: "Prev", phase: cycle.prevPhase, dim: true },
                      { label: "Now",  phase: cycle.phase,     dim: false },
                      { label: "Next", phase: cycle.nextPhase, dim: true },
                    ].map(({ label, phase: p, dim }) => (
                      <div key={label} className="flex items-center gap-2">
                        <span className="w-7 text-[9px] font-bold text-muted-foreground uppercase">{label}</span>
                        <span
                          className="rounded-lg px-2 py-1 text-[10px] font-bold leading-tight"
                          style={{
                            backgroundColor: (CYCLE_META[p]?.color ?? "#6b7280") + (dim ? "15" : "20"),
                            color: dim ? (CYCLE_META[p]?.color ?? "#6b7280") + "aa" : (CYCLE_META[p]?.color ?? "#6b7280"),
                          }}
                        >
                          {p}
                        </span>
                      </div>
                    ))}
                    <p className="text-[10px] text-muted-foreground leading-relaxed border-t border-[#F0EDE6] pt-2">
                      {cycle.description}
                    </p>
                  </div>
                </div>
                {/* Leading / Lagging */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-2.5">
                    <p className="text-[9px] font-bold text-emerald-700 uppercase tracking-wider mb-1.5">Leading</p>
                    <div className="flex flex-wrap gap-1">
                      {cycle.leadingSectors.map(s => (
                        <span key={s} className="rounded-md bg-emerald-100 border border-emerald-200 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-800">{s}</span>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl bg-red-50 border border-red-100 p-2.5">
                    <p className="text-[9px] font-bold text-red-700 uppercase tracking-wider mb-1.5">Lagging</p>
                    <div className="flex flex-wrap gap-1">
                      {cycle.laggingSectors.map(s => (
                        <span key={s} className="rounded-md bg-red-100 border border-red-200 px-1.5 py-0.5 text-[9px] font-semibold text-red-800">{s}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          {/* Top Inflow */}
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="flex items-center gap-1.5 text-xs font-bold text-emerald-800 mb-3 uppercase tracking-wide">
              <ArrowUpRight size={13} /> Capital Inflow — Top Sectors
            </p>
            <div className="space-y-2">
              {isLoading ? [1,2,3].map(i => <div key={i} className="h-10 animate-pulse rounded-lg bg-emerald-100" />) :
                (data?.topInflow ?? []).slice(0, 3).map((name, i) => {
                  const s = data?.sectors.find(x => x.name === name);
                  if (!s) return null;
                  return (
                    <div key={i} className="flex items-center gap-2.5 rounded-xl bg-white border border-emerald-100 px-3 py-2">
                      <span className="text-sm font-black text-emerald-600">#{i + 1}</span>
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                      <span className="text-xs font-semibold text-foreground flex-1 truncate">{s.name}</span>
                      <Spark data={s.momentum5D} color={s.color} h={20} w={44} />
                      <span className="text-xs font-bold text-emerald-700 tabular-nums">
                        +{s.flowScore.toFixed(0)}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Top Outflow */}
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
            <p className="flex items-center gap-1.5 text-xs font-bold text-red-800 mb-3 uppercase tracking-wide">
              <ArrowDownRight size={13} /> Capital Outflow — Top Sectors
            </p>
            <div className="space-y-2">
              {isLoading ? [1,2,3].map(i => <div key={i} className="h-10 animate-pulse rounded-lg bg-red-100" />) :
                (data?.topOutflow ?? []).slice(0, 3).map((name, i) => {
                  const s = data?.sectors.find(x => x.name === name);
                  if (!s) return null;
                  return (
                    <div key={i} className="flex items-center gap-2.5 rounded-xl bg-white border border-red-100 px-3 py-2">
                      <span className="text-sm font-black text-red-600">#{i + 1}</span>
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                      <span className="text-xs font-semibold text-foreground flex-1 truncate">{s.name}</span>
                      <Spark data={s.momentum5D} color={s.color} h={20} w={44} />
                      <span className="text-xs font-bold text-red-700 tabular-nums">
                        {s.flowScore.toFixed(0)}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>

      {/* ── 4. Flow Score Heatmap ──────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <BarChart2 size={14} className="text-muted-foreground" />
          <p className="text-sm font-bold text-foreground">Flow Score Heatmap</p>
          <span className="text-xs text-muted-foreground">· Sorted by capital momentum (–100 = max outflow, +100 = max inflow)</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-11 gap-2">
          {isLoading
            ? Array.from({ length: 11 }).map((_, i) => (
                <div key={i} className="h-24 rounded-xl bg-[#F0EDE6] animate-pulse" />
              ))
            : sortedSectors.map((s, i) => <HeatTile key={s.id} sector={s} index={i} />)
          }
        </div>
      </div>

      {/* ── 5. Rankings chart ─────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-[#DDD9D0] bg-white">
        <div className="px-5 py-4 border-b border-[#F0EDE6]">
          <p className="text-sm font-bold text-foreground flex items-center gap-2">
            <Layers size={14} />
            Sector Flow Rankings
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">Composite score from RSI, MACD momentum, relative strength vs Nifty50</p>
        </div>
        <div className="px-5 py-4 space-y-2.5">
          {isLoading
            ? Array.from({ length: 11 }).map((_, i) => <div key={i} className="h-7 animate-pulse rounded-lg bg-[#F0EDE6]" />)
            : sortedSectors.map((s, i) => <HorizBar key={s.id} sector={s} rank={i} />)
          }
        </div>
      </div>

      {/* ── 6. Full detail table ──────────────────────────────────────────── */}
      <div className="rounded-2xl border border-[#DDD9D0] bg-white overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0EDE6]">
          <p className="text-sm font-bold text-foreground flex items-center gap-2">
            <Activity size={14} />
            Sector Detail
          </p>
          <div className="flex gap-1 rounded-lg border border-[#DDD9D0] bg-white p-0.5">
            {(["all", "Cyclical", "Defensive", "Sensitive"] as const).map(v => (
              <button key={v} onClick={() => setTableFilter(v)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-all",
                  tableFilter === v ? "bg-[#1B3A5C] text-white shadow-sm" : "text-muted-foreground hover:bg-[#F0EDE6]"
                )}>
                {v === "all" ? "All" : v}
              </button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-[#F0EDE6]" />)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#EAE8E2]">
                  {["Sector", "Type", "1D", "1M", "3M", "RSI", "RS vs N50", "5D", "Direction"].map(h => (
                    <th key={h} className={cn(
                      "pb-2 pt-3 px-3 text-[9px] font-bold uppercase tracking-widest text-muted-foreground",
                      ["1D","1M","3M","RSI","RS vs N50"].includes(h) ? "text-right" : "text-left"
                    )}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredSectors.map((s, i) => <SectorDetailRow key={s.id} s={s} i={i} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footer */}
      <p className="text-[10px] text-muted-foreground text-center pb-2">
        Data from NSE via Yahoo Finance · Indicators computed server-side · No estimated/proxy data used
        {data?.timestamp && ` · Last updated ${new Date(data.timestamp).toLocaleTimeString()}`}
      </p>
    </div>
  );
}
