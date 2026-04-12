"use client"

import { usePathname } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import { RefreshCw, Clock, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useMarketStore } from "@/store/useMarketStore"
import type { RegimeType } from "@/types"

// ─────────────────────────────────────────────────────────────────────────────
// Route → title / subtitle mapping
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_META: Record<
  string,
  { title: string; subtitle: string; breadcrumb?: string[] }
> = {
  "/": {
    title: "Dashboard",
    subtitle: "Real-time market overview & capital flow summary",
    breadcrumb: ["Home"],
  },
  "/rotation": {
    title: "Rotation Map",
    subtitle: "Visualise capital flows across asset classes and regimes",
    breadcrumb: ["Home", "Rotation Map"],
  },
  "/signals": {
    title: "Signals",
    subtitle: "Active directional signals ranked by strength & confidence",
    breadcrumb: ["Home", "Signals"],
  },
  "/assets": {
    title: "Assets",
    subtitle: "Tracked instruments, price data and technical profiles",
    breadcrumb: ["Home", "Assets"],
  },
  "/portfolio": {
    title: "Portfolio",
    subtitle: "Current allocation, target weights and rebalance recommendations",
    breadcrumb: ["Home", "Portfolio"],
  },
  "/copilot": {
    title: "AI Copilot",
    subtitle: "Claude-powered market intelligence and scenario analysis",
    breadcrumb: ["Home", "AI Copilot"],
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Regime display config
// ─────────────────────────────────────────────────────────────────────────────

const REGIME_CONFIG: Record<
  RegimeType,
  { label: string; color: string; bg: string; border: string }
> = {
  RISK_ON: {
    label: "Risk-On",
    color: "text-emerald-700",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
  },
  RISK_OFF: {
    label: "Risk-Off",
    color: "text-red-700",
    bg: "bg-red-50",
    border: "border-red-200",
  },
  STAGFLATION: {
    label: "Stagflation",
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
  },
  DEFLATION: {
    label: "Deflation",
    color: "text-sky-700",
    bg: "bg-sky-50",
    border: "border-sky-200",
  },
  RECOVERY: {
    label: "Recovery",
    color: "text-teal-700",
    bg: "bg-teal-50",
    border: "border-teal-200",
  },
  EXPANSION: {
    label: "Expansion",
    color: "text-emerald-800",
    bg: "bg-emerald-50",
    border: "border-emerald-300",
  },
  CONTRACTION: {
    label: "Contraction",
    color: "text-red-800",
    bg: "bg-red-50",
    border: "border-red-300",
  },
  UNKNOWN: {
    label: "Analysing…",
    color: "text-muted-foreground",
    bg: "bg-muted",
    border: "border-border",
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Timestamp formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Never"
  const d = new Date(iso)
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Header component
// ─────────────────────────────────────────────────────────────────────────────

export function Header() {
  const pathname = usePathname()

  // Resolve meta for the current route (fall back to first matching prefix)
  const meta =
    ROUTE_META[pathname] ??
    Object.entries(ROUTE_META).find(([k]) => k !== "/" && pathname.startsWith(k))?.[1] ??
    ROUTE_META["/"]

  const { isRefreshing, lastUpdated, currentRegime, refreshMarketData } =
    useMarketStore()

  const regime = REGIME_CONFIG[currentRegime] ?? REGIME_CONFIG.UNKNOWN

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-[#DDD9D0] bg-[#F7F6F2]/90 px-6 backdrop-blur-md">
      {/* ── Breadcrumb / title ─────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Breadcrumb */}
        {meta.breadcrumb && meta.breadcrumb.length > 1 && (
          <motion.nav
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-1"
          >
            {meta.breadcrumb.map((crumb, i) => (
              <span key={crumb} className="flex items-center gap-1">
                {i > 0 && (
                  <ChevronRight
                    size={11}
                    className="text-muted-foreground/50 shrink-0"
                  />
                )}
                <span
                  className={cn(
                    "text-[11px] leading-none",
                    i === meta.breadcrumb!.length - 1
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  {crumb}
                </span>
              </span>
            ))}
          </motion.nav>
        )}

        {/* Page title */}
        <AnimatePresence mode="wait">
          <motion.h1
            key={pathname}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="text-base font-semibold text-foreground leading-tight truncate"
          >
            {meta.title}
          </motion.h1>
        </AnimatePresence>
      </div>

      {/* ── Right-side controls ────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-3">
        {/* Market Regime badge */}
        <AnimatePresence mode="wait">
          <motion.div
            key={currentRegime}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.2 }}
          >
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1",
                regime.bg,
                regime.border
              )}
            >
              {/* Pulsing regime dot */}
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span
                  className={cn(
                    "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                    currentRegime === "RISK_ON" || currentRegime === "EXPANSION"
                      ? "bg-emerald-500"
                      : currentRegime === "RISK_OFF" || currentRegime === "CONTRACTION"
                      ? "bg-red-500"
                      : "bg-amber-500"
                  )}
                  style={{ animationDuration: "2s" }}
                />
                <span
                  className={cn(
                    "relative inline-flex h-1.5 w-1.5 rounded-full",
                    currentRegime === "RISK_ON" || currentRegime === "EXPANSION"
                      ? "bg-emerald-500"
                      : currentRegime === "RISK_OFF" || currentRegime === "CONTRACTION"
                      ? "bg-red-500"
                      : "bg-amber-500"
                  )}
                />
              </span>
              <span className={cn("text-xs font-semibold", regime.color)}>
                {regime.label}
              </span>
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Separator */}
        <div className="h-5 w-px bg-[#DDD9D0]" />

        {/* Last updated timestamp */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock size={12} className="shrink-0" />
          <AnimatePresence mode="wait">
            <motion.span
              key={lastUpdated ?? "never"}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.15 }}
              className="tabular-nums font-mono text-[11px]"
            >
              {formatTimestamp(lastUpdated)}
            </motion.span>
          </AnimatePresence>
        </div>

        {/* Refresh button */}
        <Button
          variant="outline"
          size="icon-sm"
          onClick={refreshMarketData}
          disabled={isRefreshing}
          title="Refresh market data"
          className="rounded-lg"
        >
          <motion.span
            animate={isRefreshing ? { rotate: 360 } : { rotate: 0 }}
            transition={
              isRefreshing
                ? { duration: 0.8, repeat: Infinity, ease: "linear" }
                : { duration: 0 }
            }
            className="flex items-center justify-center"
          >
            <RefreshCw
              size={14}
              className={cn(
                "transition-colors",
                isRefreshing ? "text-[#1B3A5C]" : "text-muted-foreground"
              )}
            />
          </motion.span>
        </Button>
      </div>
    </header>
  )
}
