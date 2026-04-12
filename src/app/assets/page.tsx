"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Search,
  RefreshCw,
  AlertCircle,
  Clock,
} from "lucide-react";
import SparklineChart from "@/components/charts/SparklineChart";
import { cn, formatPercent } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LiveAsset {
  symbol:     string;
  name:       string;
  assetClass: string;
  currency:   string;
  flag:       string;
  price:      number;
  change1D:   number;
  change1M:   number;
  sparkline:  number[];
  lastUpdated: string | null;
}

interface LiveResponse {
  assets: LiveAsset[];
  meta: {
    count:             number;
    lastUpdated:       string | null;
    ageHours:          number;
    ageMin:            number;
    isStale:           boolean;
    nextRefreshIn:     number;
    ingestInProgress:  boolean;
  };
}

const CLASS_FILTERS = ["All", "Equity Index", "Commodity", "Currency", "Fixed Income"];

const CLASS_COLORS: Record<string, string> = {
  "Equity Index": "#1B3A5C",
  "Commodity":    "#B45309",
  "Currency":     "#7C3AED",
  "Fixed Income": "#2D7D46",
};

// ─── Fetcher ──────────────────────────────────────────────────────────────────

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ─── Asset Card ───────────────────────────────────────────────────────────────

function AssetCard({ asset, index }: { asset: LiveAsset; index: number }) {
  const router    = useRouter();
  const isPositive = asset.change1D > 0;
  const isNegative = asset.change1D < 0;
  const classColor = CLASS_COLORS[asset.assetClass] ?? "#1B3A5C";
  const sparkColor = isPositive ? "#22c55e" : isNegative ? "#ef4444" : "#94a3b8";

  const priceDisplay = asset.price.toLocaleString("en-IN", {
    minimumFractionDigits: asset.price < 10 ? 4 : asset.price < 1000 ? 2 : 2,
    maximumFractionDigits: asset.price < 10 ? 4 : 2,
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.04, ease: "easeOut" }}
      onClick={() => router.push(`/assets/${asset.symbol}`)}
      className="group cursor-pointer rounded-xl border border-[#DDD9D0] bg-white p-4 hover:border-[#B8B3A8] hover:shadow-lg transition-all duration-200 hover:-translate-y-0.5"
    >
      {/* Header */}
      <div className="mb-3 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl leading-none">{asset.flag}</span>
          <div>
            <p className="text-sm font-bold text-foreground font-mono">
              {asset.symbol.replace("_", " ")}
            </p>
            <p className="text-[11px] text-muted-foreground truncate max-w-[120px]">
              {asset.name}
            </p>
          </div>
        </div>
        <span
          className="rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
          style={{ backgroundColor: classColor + "18", color: classColor }}
        >
          {asset.assetClass}
        </span>
      </div>

      {/* Mini sparkline */}
      <div className="mb-3 h-12 w-full">
        <SparklineChart
          data={asset.sparkline.length > 1 ? asset.sparkline : [asset.price, asset.price]}
          color={sparkColor}
          height={48}
        />
      </div>

      {/* Price & 1D change */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-lg font-bold text-foreground">
            {asset.currency === "INR" ? "₹" : "$"}{priceDisplay}
          </p>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold",
              isPositive
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : isNegative
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-[#DDD9D0] bg-[#F7F6F2] text-muted-foreground"
            )}
          >
            {isPositive ? <TrendingUp size={10} /> : isNegative ? <TrendingDown size={10} /> : <Minus size={10} />}
            {formatPercent(asset.change1D)}
          </span>
          <span className="text-[10px] text-muted-foreground">1D change</span>
        </div>
      </div>

      {/* 1M performance */}
      <div className="mt-2.5 flex items-center justify-between border-t border-[#F0EDE6] pt-2">
        <span className="text-[10px] text-muted-foreground">1-Month</span>
        <span className={cn(
          "text-[11px] font-semibold",
          asset.change1M > 0 ? "text-emerald-600" : asset.change1M < 0 ? "text-red-600" : "text-muted-foreground"
        )}>
          {formatPercent(asset.change1M)}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity duration-150">
        <span className="text-[10px] font-medium text-[#1B3A5C]">Deep Dive →</span>
      </div>
    </motion.div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-[#DDD9D0] bg-white p-4 animate-pulse">
      <div className="mb-3 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-[#F0EDE6]" />
          <div>
            <div className="h-3 w-20 rounded bg-[#F0EDE6] mb-1" />
            <div className="h-2 w-28 rounded bg-[#F0EDE6]" />
          </div>
        </div>
        <div className="h-4 w-16 rounded bg-[#F0EDE6]" />
      </div>
      <div className="mb-3 h-12 rounded bg-[#F0EDE6]" />
      <div className="flex items-end justify-between">
        <div className="h-5 w-24 rounded bg-[#F0EDE6]" />
        <div className="h-5 w-16 rounded bg-[#F0EDE6]" />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AssetsPage() {
  const [search,      setSearch]      = useState("");
  const [classFilter, setClassFilter] = useState("All");
  const [refreshing,  setRefreshing]  = useState(false);
  const [countdown,   setCountdown]   = useState<number>(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, error, isLoading, mutate } = useSWR<LiveResponse>(
    "/api/prices/live",
    fetcher,
    { refreshInterval: 3 * 60 * 1000 } // auto-refresh every 3 min
  );

  // Sync countdown from API meta
  useEffect(() => {
    if (data?.meta?.nextRefreshIn !== undefined) {
      setCountdown(data.meta.nextRefreshIn);
    }
  }, [data?.meta?.nextRefreshIn]);

  // Tick countdown every second
  useEffect(() => {
    countdownRef.current = setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      // Trigger live data refresh (Dhan for NSE indices, Yahoo for rest) then reload
      await fetch("/api/ingest", { method: "POST" });
      await mutate();
    } finally {
      setRefreshing(false);
    }
  }

  const assets = data?.assets ?? [];
  const filtered = assets.filter((a) => {
    const matchClass  = classFilter === "All" || a.assetClass === classFilter;
    const matchSearch = !search
      || a.symbol.toLowerCase().includes(search.toLowerCase())
      || a.name.toLowerCase().includes(search.toLowerCase());
    return matchClass && matchSearch;
  });

  const lastUpdated = data?.meta?.lastUpdated
    ? new Date(data.meta.lastUpdated).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : null;

  const isStale = data?.meta?.isStale;

  return (
    <div className="space-y-5">
      {/* Top bar */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="flex flex-wrap items-center gap-3"
      >
        {/* Class filter tabs */}
        <div className="flex items-center gap-1 rounded-xl border border-[#DDD9D0] bg-white p-1">
          {CLASS_FILTERS.map((cls) => (
            <button
              key={cls}
              onClick={() => setClassFilter(cls)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150",
                classFilter === cls
                  ? "bg-[#1B3A5C] text-white shadow-sm"
                  : "text-muted-foreground hover:bg-[#F0EDE6] hover:text-foreground"
              )}
            >
              {cls}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex items-center">
          <Search size={14} className="absolute left-3 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search assets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 rounded-lg border border-[#DDD9D0] bg-white pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:border-[#1B3A5C] focus:outline-none focus:ring-1 focus:ring-[#1B3A5C]/30 transition-colors w-48"
          />
        </div>

        {/* Meta info + refresh */}
        <div className="ml-auto flex items-center gap-3">
          {lastUpdated && (
            <div className={cn(
              "flex items-center gap-1.5 text-xs",
              isStale ? "text-amber-600" : "text-muted-foreground"
            )}>
              {isStale ? <AlertCircle size={12} /> : <Clock size={12} />}
              <span>Updated {lastUpdated}</span>
              {isStale && <span className="font-medium">(stale)</span>}
            </div>
          )}
          {!isStale && data && (
            <span className="text-xs text-muted-foreground">
              {data.meta.ingestInProgress
                ? "Fetching fresh data..."
                : countdown > 0
                ? `Next refresh in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, "0")}`
                : "Refreshing..."}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{filtered.length} assets</span>
          <button
            onClick={handleRefresh}
            disabled={refreshing || isLoading}
            title="Refresh live prices"
            className="flex items-center gap-1.5 rounded-lg border border-[#DDD9D0] bg-white px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-[#F0EDE6] hover:text-foreground disabled:opacity-40 transition-all"
          >
            <RefreshCw size={12} className={cn(refreshing && "animate-spin")} />
            {refreshing ? "Fetching..." : "Refresh"}
          </button>
        </div>
      </motion.div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle size={16} />
          Failed to load prices. Click Refresh to retry.
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {isLoading
          ? Array.from({ length: 16 }).map((_, i) => <SkeletonCard key={i} />)
          : filtered.map((asset, i) => (
              <AssetCard key={asset.symbol} asset={asset} index={i} />
            ))}
      </div>

      {!isLoading && filtered.length === 0 && (
        <div className="py-20 text-center">
          <p className="text-sm text-muted-foreground">No assets match your search.</p>
        </div>
      )}
    </div>
  );
}
