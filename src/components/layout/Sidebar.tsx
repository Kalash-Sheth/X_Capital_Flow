"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import {
  LayoutDashboard,
  GitBranch,
  Activity,
  TrendingUp,
  PieChart,
  Brain,
  Zap,
  BarChart3,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────────────────────────
// Nav item definitions
// ─────────────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  // {
  //   label: "Dashboard",
  //   href: "/",
  //   icon: LayoutDashboard,
  //   description: "Market overview",
  // },
  // {
  //   label: "Rotation Map",
  //   href: "/rotation",
  //   icon: GitBranch,
  //   description: "Capital flow analysis",
  // },
  // {
  //   label: "Sector Rotation",
  //   href: "/sector-rotation",
  //   icon: BarChart3,
  //   description: "Sector inflow / outflow",
  // },
  {
    label: "Signals",
    href: "/signals",
    icon: Activity,
    description: "Active trade signals",
  },
  // {
  //   label: "Assets",
  //   href: "/assets",
  //   icon: TrendingUp,
  //   description: "Instruments & data",
  // },
  // {
  //   label: "Portfolio",
  //   href: "/portfolio",
  //   icon: PieChart,
  //   description: "Allocation & drift",
  // },
  // {
  //   label: "AI Copilot",
  //   href: "/copilot",
  //   icon: Brain,
  //   description: "Market intelligence",
  // },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar
// ─────────────────────────────────────────────────────────────────────────────

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 flex w-[240px] flex-col"
      style={{
        background: "linear-gradient(180deg, #1B3A5C 0%, #162E4A 100%)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* ── Brand / Logo ────────────────────────────────────────────────── */}
      <div className="flex h-14 shrink-0 items-center gap-3 px-5 border-b border-white/[0.07]">
        {/* Stylised "X" mark */}
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
          style={{
            background:
              "linear-gradient(135deg, #4A7FA5 0%, #2D5F8A 50%, #1B3A5C 100%)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.12) inset",
          }}
        >
          <span className="text-white font-bold text-sm tracking-tighter select-none">
            X
          </span>
        </div>

        <div className="flex flex-col min-w-0">
          <span className="text-white text-sm font-semibold leading-tight tracking-tight truncate">
            Capital Flow
          </span>
          <span className="text-white/40 text-[10px] leading-tight tracking-widest uppercase font-medium">
            Institutional
          </span>
        </div>
      </div>

      {/* ── Navigation ──────────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto py-3 px-2.5 space-y-0.5">
        {/* Section label */}
        <p className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/30 select-none">
          Navigation
        </p>

        {NAV_ITEMS.map((item) => {
          const isActive =
            (item.href as string) === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(item.href + "/")

          return (
            <Link key={item.href} href={item.href} className="block group">
              <motion.div
                className={cn(
                  "relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150",
                  isActive
                    ? "bg-white/[0.12] text-white"
                    : "text-white/60 hover:bg-white/[0.06] hover:text-white/90"
                )}
                whileTap={{ scale: 0.98 }}
              >
                {/* Active indicator bar */}
                <AnimatePresence>
                  {isActive && (
                    <motion.span
                      layoutId="sidebar-active-bar"
                      className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-full bg-[#4A7FA5]"
                      initial={{ opacity: 0, scaleY: 0 }}
                      animate={{ opacity: 1, scaleY: 1 }}
                      exit={{ opacity: 0, scaleY: 0 }}
                      transition={{ duration: 0.2 }}
                    />
                  )}
                </AnimatePresence>

                {/* Icon */}
                <item.icon
                  className={cn(
                    "shrink-0 transition-colors",
                    isActive
                      ? "text-[#C8DCF0]"
                      : "text-white/40 group-hover:text-white/70"
                  )}
                  size={16}
                  strokeWidth={isActive ? 2 : 1.75}
                />

                {/* Label */}
                <span
                  className={cn(
                    "text-sm leading-none truncate",
                    isActive ? "font-semibold" : "font-medium"
                  )}
                >
                  {item.label}
                </span>

                {/* Active dot */}
                {isActive && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#4A7FA5] shrink-0" />
                )}
              </motion.div>
            </Link>
          )
        })}
      </nav>

      {/* ── Bottom: Market Status ───────────────────────────────────────── */}
      <div className="shrink-0 px-3 py-3 border-t border-white/[0.07]">
        <MarketStatusBadge />

        {/* Version tag */}
        <p className="mt-2.5 px-1 text-[10px] text-white/20 font-mono tracking-wide">
          v0.1.0 · X-Capital Flow
        </p>
      </div>
    </aside>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Market status indicator
// ─────────────────────────────────────────────────────────────────────────────

function MarketStatusBadge() {
  // Determine live/closed based on IST market hours (09:15 – 15:30, Mon–Fri)
  const now = new Date()
  const istOffset = 5.5 * 60 * 60 * 1000
  const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60000)
  const day = ist.getDay()       // 0 = Sun, 6 = Sat
  const hour = ist.getHours()
  const minute = ist.getMinutes()
  const timeInMins = hour * 60 + minute
  const isOpen =
    day >= 1 && day <= 5 &&
    timeInMins >= 9 * 60 + 15 &&
    timeInMins <= 15 * 60 + 30

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-white/[0.06] px-3 py-2.5">
      {/* Pulsing dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            isOpen ? "bg-emerald-400" : "bg-slate-400"
          )}
          style={{ animationDuration: isOpen ? "1.5s" : "3s" }}
        />
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            isOpen ? "bg-emerald-400" : "bg-slate-500"
          )}
        />
      </span>

      {/* Text */}
      <div className="flex flex-col">
        <span
          className={cn(
            "text-xs font-semibold leading-tight",
            isOpen ? "text-emerald-400" : "text-white/50"
          )}
        >
          {isOpen ? "Markets Open" : "Markets Closed"}
        </span>
        <span className="text-[10px] text-white/30 leading-tight">
          {isOpen ? "NSE · BSE · Live" : "Next: Mon 09:15 IST"}
        </span>
      </div>

      {/* Live pill */}
      {isOpen && (
        <span className="ml-auto flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400 uppercase tracking-widest">
          <Zap size={9} className="shrink-0" />
          Live
        </span>
      )}
    </div>
  )
}
