"use client";

import { useMemo, useState, Fragment } from "react";
import { motion } from "framer-motion";
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronRight } from "lucide-react";
import SignalBadge, { SignalVerdict } from "@/components/signals/SignalBadge";
import { cn } from "@/lib/utils";

export type SignalCategory =
  | "All"
  | "Momentum"
  | "Trend"
  | "Volatility"
  | "Volume"
  | "Macro"
  | "Breadth"
  | "Relative Strength"
  | "Composite";

export interface SignalDetail {
  formula:        string;
  computation:    string;
  affectedAssets: string[];
  interpretation: string;
  timeframe:      string;
  thresholds?:    { label: string; value: string }[];
}

export interface SignalRow {
  id:           string;
  name:         string;
  asset:        string;
  category:     Exclude<SignalCategory, "All">;
  currentValue: string;
  verdict:      SignalVerdict;
  strength:     "Strong" | "Moderate" | "Weak";
  description:  string;
  detail?:      SignalDetail;
}

const STRENGTH_STYLES = {
  Strong:   { dot: "bg-emerald-500", text: "text-emerald-700" },
  Moderate: { dot: "bg-amber-500",   text: "text-amber-700" },
  Weak:     { dot: "bg-[#C4BFB4]",   text: "text-muted-foreground" },
};

const CATEGORY_COLORS: Record<string, string> = {
  Momentum:          "bg-blue-50 text-blue-700 border-blue-200",
  Trend:             "bg-violet-50 text-violet-700 border-violet-200",
  Volatility:        "bg-orange-50 text-orange-700 border-orange-200",
  Volume:            "bg-teal-50 text-teal-700 border-teal-200",
  Macro:             "bg-slate-50 text-slate-700 border-slate-200",
  Breadth:           "bg-pink-50 text-pink-700 border-pink-200",
  "Relative Strength": "bg-amber-50 text-amber-700 border-amber-200",
  Composite:         "bg-indigo-50 text-indigo-700 border-indigo-200",
};

type SortKey = "name" | "asset" | "verdict" | "strength";
type SortDir = "asc" | "desc";

interface SignalsTableProps {
  signals:        SignalRow[];
  totalCount:     number;
  activeCategory: SignalCategory;
  searchQuery:    string;
  isLoading?:     boolean;
}

// ─── Detail expand panel ──────────────────────────────────────────────────────
function DetailPanel({ detail }: { detail: SignalDetail }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Left: Formula + Computation */}
      <div className="space-y-3">
        <div>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Formula
          </p>
          <div className="rounded-lg border border-[#DDD9D0] bg-[#F7F6F2] px-3 py-2.5">
            <code className="whitespace-pre-wrap text-[11px] font-mono text-[#1B3A5C] leading-relaxed">
              {detail.formula}
            </code>
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            How it&apos;s Computed
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">{detail.computation}</p>
        </div>
      </div>

      {/* Right: Assets + Timeframe + Thresholds + Interpretation */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Affects
            </p>
            <div className="flex flex-wrap gap-1">
              {detail.affectedAssets.map((a) => (
                <span
                  key={a}
                  className="rounded-md border border-[#DDD9D0] bg-white px-2 py-0.5 text-[10px] font-mono font-semibold text-[#1B3A5C]"
                >
                  {a}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Timeframe
            </p>
            <span className="rounded-full border border-[#DDD9D0] bg-white px-2.5 py-1 text-[10px] font-medium text-foreground">
              {detail.timeframe}
            </span>
          </div>
        </div>

        {detail.thresholds && detail.thresholds.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Key Levels
            </p>
            <div className="space-y-1">
              {detail.thresholds.map((t) => (
                <div key={t.label} className="flex items-center justify-between rounded-md border border-[#ECEAE4] bg-white px-2.5 py-1.5">
                  <span className="text-[11px] text-muted-foreground">{t.label}</span>
                  <span className="text-[11px] font-mono font-semibold text-foreground">{t.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            How to Interpret
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">{detail.interpretation}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Main table ───────────────────────────────────────────────────────────────
export default function SignalsTable({
  signals,
  totalCount,
  activeCategory,
  searchQuery,
  isLoading,
}: SignalsTableProps) {
  const [sortKey, setSortKey]     = useState<SortKey>("name");
  const [sortDir, setSortDir]     = useState<SortDir>("asc");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const toggleExpand = (id: string) =>
    setExpandedId((prev) => (prev === id ? null : id));

  const filtered = useMemo(() => {
    let rows = signals;
    if (activeCategory !== "All") rows = rows.filter((r) => r.category === activeCategory);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.asset.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      );
    }
    return [...rows].sort((a, b) => {
      const aVal = a[sortKey as keyof SignalRow] as string;
      const bVal = b[sortKey as keyof SignalRow] as string;
      const cmp  = aVal.localeCompare(bVal);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [signals, activeCategory, searchQuery, sortKey, sortDir]);

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ChevronsUpDown size={12} className="text-muted-foreground/50" />;
    return sortDir === "asc"
      ? <ChevronUp size={12} className="text-[#1B3A5C]" />
      : <ChevronDown size={12} className="text-[#1B3A5C]" />;
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[#DDD9D0] bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#ECEAE4] bg-[#F7F6F2]">
              {/* Expand chevron column */}
              <th className="w-8 px-2 py-3" />
              {[
                { key: "name"  as SortKey, label: "Signal Name" },
                { key: "asset" as SortKey, label: "Asset" },
              ].map(({ key, label }) => (
                <th key={key} onClick={() => handleSort(key)} className="cursor-pointer px-4 py-3 text-left">
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
                    <SortIcon col={key} />
                  </div>
                </th>
              ))}
              <th className="px-4 py-3 text-left">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Value</span>
              </th>
              {[
                { key: "verdict"  as SortKey, label: "Verdict" },
                { key: "strength" as SortKey, label: "Strength" },
              ].map(({ key, label }) => (
                <th key={key} onClick={() => handleSort(key)} className="cursor-pointer px-4 py-3 text-left">
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
                    <SortIcon col={key} />
                  </div>
                </th>
              ))}
              <th className="px-4 py-3 text-left">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Description</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-[#F0EDE6]">
                  {Array.from({ length: 7 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-3 rounded bg-[#F0EDE6] animate-pulse" style={{ width: `${50 + j * 12}%` }} />
                    </td>
                  ))}
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                  No signals match your filters.
                </td>
              </tr>
            ) : (
                filtered.map((row, i) => {
                  const isExpanded = expandedId === row.id;
                  const catColor   = CATEGORY_COLORS[row.category] ?? "bg-gray-50 text-gray-600 border-gray-200";
                  return (
                    <Fragment key={row.id}>
                      {/* ── Main row ── */}
                      <tr
                        onClick={() => toggleExpand(row.id)}
                        className={cn(
                          "group cursor-pointer border-b border-[#F0EDE6] transition-colors duration-100",
                          isExpanded ? "bg-[#F0EDE6]/70" : "hover:bg-[#F7F6F2]/80",
                        )}
                      >
                        {/* Expand indicator */}
                        <td className="px-2 py-3 text-center">
                          <motion.div
                            animate={{ rotate: isExpanded ? 90 : 0 }}
                            transition={{ duration: 0.18 }}
                          >
                            <ChevronRight size={14} className={cn("text-muted-foreground/40 transition-colors", isExpanded && "text-[#1B3A5C]")} />
                          </motion.div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-sm font-medium text-foreground">{row.name}</span>
                            <span className={cn("inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider", catColor)}>
                              {row.category}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center rounded-md border border-[#DDD9D0] bg-[#F7F6F2] px-2 py-0.5 text-xs font-mono font-semibold text-[#1B3A5C]">
                            {row.asset}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-sm font-mono text-foreground">{row.currentValue}</span>
                        </td>
                        <td className="px-4 py-3">
                          <SignalBadge verdict={row.verdict} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className={cn("h-2 w-2 rounded-full", STRENGTH_STYLES[row.strength].dot)} />
                            <span className={cn("text-xs font-medium", STRENGTH_STYLES[row.strength].text)}>
                              {row.strength}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                            {row.description}
                          </p>
                        </td>
                      </tr>

                      {/* ── Expanded detail row ── */}
                      {isExpanded && row.detail && (
                        <tr className="border-b border-[#ECEAE4]">
                          <td colSpan={7} className="px-0 py-0">
                            <div className="overflow-hidden border-l-2 border-[#1B3A5C]/30 bg-[#F7F6F2]/60 px-6 py-4 ml-8">
                              <DetailPanel detail={row.detail} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[#ECEAE4] bg-[#F7F6F2]/60 px-4 py-2.5">
        <p className="text-xs text-muted-foreground">
          Showing <span className="font-medium text-foreground">{filtered.length}</span> of{" "}
          <span className="font-medium text-foreground">{totalCount}</span> signals
          {expandedId && <span className="ml-2 text-[#1B3A5C]">· Click any row to see formula & computation</span>}
        </p>
        <p className="text-[10px] text-muted-foreground">
          Updated: {new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}
        </p>
      </div>
    </div>
  );
}
