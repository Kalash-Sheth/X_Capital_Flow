"use client";

import { motion } from "framer-motion";
import {
  TrendingUp,
  ShieldAlert,
  Activity,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";

type RegimeType = "Risk-On" | "Risk-Off" | "Neutral" | "Transitioning";

interface RegimeBadgeProps {
  regime: RegimeType;
  confidence?: number; // 0-1
  size?: "sm" | "md" | "lg";
}

// ─── Config per regime ───────────────────────────────────────────────────────
const REGIME_CONFIG: Record<
  RegimeType,
  {
    label: string;
    icon: React.ElementType;
    bg: string;
    border: string;
    text: string;
    glow: string;
    pulse: string;
    ring: string;
  }
> = {
  "Risk-On": {
    label: "RISK-ON MODE",
    icon: TrendingUp,
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    text: "text-emerald-800",
    glow: "shadow-emerald-100",
    pulse: "bg-emerald-500",
    ring: "ring-emerald-300",
  },
  "Risk-Off": {
    label: "RISK-OFF MODE",
    icon: ShieldAlert,
    bg: "bg-red-50",
    border: "border-red-200",
    text: "text-red-800",
    glow: "shadow-red-100",
    pulse: "bg-red-500",
    ring: "ring-red-300",
  },
  Neutral: {
    label: "NEUTRAL REGIME",
    icon: Activity,
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-800",
    glow: "shadow-amber-100",
    pulse: "bg-amber-500",
    ring: "ring-amber-300",
  },
  Transitioning: {
    label: "TRANSITIONING",
    icon: RefreshCw,
    bg: "bg-blue-50",
    border: "border-blue-200",
    text: "text-blue-800",
    glow: "shadow-blue-100",
    pulse: "bg-blue-500",
    ring: "ring-blue-300",
  },
};

const SIZE = {
  sm: {
    pill: "px-3 py-1.5 text-xs gap-2",
    icon: 14,
    dot: "w-2 h-2",
    sub: "text-[10px] mt-1",
    bar: "h-1",
  },
  md: {
    pill: "px-4 py-2 text-sm gap-2.5",
    icon: 16,
    dot: "w-2.5 h-2.5",
    sub: "text-xs mt-1.5",
    bar: "h-1.5",
  },
  lg: {
    pill: "px-6 py-3 text-base gap-3",
    icon: 20,
    dot: "w-3 h-3",
    sub: "text-sm mt-2",
    bar: "h-2",
  },
};

export default function RegimeBadge({
  regime,
  confidence,
  size = "lg",
}: RegimeBadgeProps) {
  const cfg = REGIME_CONFIG[regime] ?? REGIME_CONFIG["Neutral"];
  const sz = SIZE[size];
  const Icon = cfg.icon;
  const pct = confidence != null ? Math.round(confidence * 100) : null;

  return (
    <div className="flex flex-col items-start">
      {/* ── Animated pill ─────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className={[
          "inline-flex items-center font-semibold tracking-widest rounded-full border shadow-lg",
          cfg.bg,
          cfg.border,
          cfg.text,
          `shadow-${cfg.glow}`,
          sz.pill,
        ].join(" ")}
      >
        {/* Pulsing dot */}
        <span className="relative flex items-center justify-center">
          <motion.span
            className={["absolute rounded-full opacity-50", cfg.pulse, sz.dot].join(" ")}
            animate={{ scale: [1, 1.8, 1], opacity: [0.5, 0, 0.5] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
          <span className={["relative rounded-full z-10", cfg.pulse, sz.dot].join(" ")} />
        </span>

        <Icon size={sz.icon} strokeWidth={2.2} />
        <span>{cfg.label}</span>
      </motion.div>

      {/* ── Confidence bar + label ───────────────────────────────────── */}
      {pct != null && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.35 }}
          className={["w-full", sz.sub].join(" ")}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-gray-400 font-medium uppercase tracking-wide">
              Confidence
            </span>
            <span className={["font-bold", cfg.text].join(" ")}>{pct}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full overflow-hidden">
            <motion.div
              className={[cfg.pulse, sz.bar, "rounded-full"].join(" ")}
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ delay: 0.35, duration: 0.8, ease: "easeOut" }}
            />
          </div>
        </motion.div>
      )}
    </div>
  );
}
