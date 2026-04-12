"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface AllocationBarProps {
  label: string;
  symbol: string;
  currentPct: number;
  suggestedPct: number;
  color?: string;
  rationale?: string;
  assetClass?: string;
  index?: number;
}

const ASSET_COLORS: Record<string, string> = {
  EQUITY: "#1B3A5C",
  FIXED_INCOME: "#2D7D46",
  COMMODITY: "#B45309",
  CURRENCY: "#7C3AED",
  CRYPTO: "#0891B2",
  REAL_ESTATE: "#BE185D",
  ALTERNATIVE: "#6B7280",
};

export default function AllocationBar({
  label,
  symbol,
  currentPct,
  suggestedPct,
  color,
  rationale,
  assetClass = "EQUITY",
  index = 0,
}: AllocationBarProps) {
  const barColor = color ?? ASSET_COLORS[assetClass] ?? "#1B3A5C";
  const diff = suggestedPct - currentPct;
  const isIncrease = diff > 0;
  const isDecrease = diff < 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.06, ease: "easeOut" }}
      className="group relative rounded-xl border border-[#DDD9D0] bg-white p-4 hover:border-[#B8B3A8] hover:shadow-md transition-all duration-200"
    >
      {/* Header row */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg text-white text-[10px] font-bold"
            style={{ backgroundColor: barColor }}
          >
            {symbol.slice(0, 2)}
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{label}</p>
            <p className="text-[11px] text-muted-foreground">{symbol}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Change indicator */}
          {diff !== 0 && (
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                isIncrease
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-red-200 bg-red-50 text-red-700"
              )}
            >
              {isIncrease ? "+" : ""}
              {diff.toFixed(1)}%
            </span>
          )}
          {diff === 0 && (
            <span className="inline-flex items-center rounded-full border border-[#DDD9D0] bg-[#F7F6F2] px-2 py-0.5 text-[11px] text-muted-foreground">
              No change
            </span>
          )}

          {/* Current vs Suggested labels */}
          <div className="text-right">
            <p className="text-[11px] text-muted-foreground">
              {currentPct.toFixed(1)}% → {suggestedPct.toFixed(1)}%
            </p>
          </div>
        </div>
      </div>

      {/* Bars */}
      <div className="space-y-2">
        {/* Current allocation bar */}
        <div className="flex items-center gap-2">
          <span className="w-16 text-right text-[10px] text-muted-foreground">Current</span>
          <div className="relative flex-1 overflow-hidden rounded-full bg-[#F0EDE6] h-2">
            <motion.div
              className="h-full rounded-full bg-[#C4BFB4]"
              initial={{ width: 0 }}
              animate={{ width: `${currentPct}%` }}
              transition={{ duration: 0.7, delay: index * 0.06 + 0.2, ease: "easeOut" }}
            />
          </div>
          <span className="w-10 text-[11px] font-medium text-foreground">
            {currentPct.toFixed(1)}%
          </span>
        </div>

        {/* Suggested allocation bar */}
        <div className="flex items-center gap-2">
          <span className="w-16 text-right text-[10px] text-muted-foreground">Suggested</span>
          <div className="relative flex-1 overflow-hidden rounded-full bg-[#F0EDE6] h-2">
            <motion.div
              className="h-full rounded-full"
              style={{ backgroundColor: barColor }}
              initial={{ width: 0 }}
              animate={{ width: `${suggestedPct}%` }}
              transition={{ duration: 0.8, delay: index * 0.06 + 0.35, ease: "easeOut" }}
            />
          </div>
          <span className="w-10 text-[11px] font-medium text-foreground">
            {suggestedPct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Rationale tooltip on hover */}
      {rationale && (
        <div className="mt-2.5 overflow-hidden">
          <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
            {rationale}
          </p>
        </div>
      )}

      {/* Visual change indicator stripe */}
      {diff !== 0 && (
        <div
          className={cn(
            "absolute left-0 top-0 bottom-0 w-0.5 rounded-l-xl",
            isIncrease ? "bg-emerald-500" : "bg-red-500"
          )}
        />
      )}
    </motion.div>
  );
}
