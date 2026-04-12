"use client";

import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell, Legend,
} from "recharts";
import type { FiiDiiDay } from "@/app/api/fii-dii/route";

interface Props {
  days: FiiDiiDay[];
  height?: number;
}

const fmt = (d: string) =>
  new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-[#E8E6DF] rounded-xl shadow-xl p-3 text-xs min-w-[180px]">
      <p className="font-bold text-foreground mb-2 pb-1.5 border-b border-[#F0EDE6]">
        {label ? fmt(label) : ""}
      </p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
            {p.name}
          </span>
          <span
            className="font-bold tabular-nums"
            style={{ color: p.value >= 0 ? "#16a34a" : "#dc2626" }}
          >
            {p.value >= 0 ? "+" : ""}₹{Math.abs(p.value).toLocaleString("en-IN")} Cr
          </span>
        </div>
      ))}
    </div>
  );
}

export default function FiiDiiChart({ days, height = 180 }: Props) {
  if (!days.length) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={days} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#F0EDE6" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={fmt}
          tick={{ fontSize: 9, fill: "#9ca3af" }}
          axisLine={false} tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 9, fill: "#9ca3af" }}
          axisLine={false} tickLine={false}
          width={52}
          tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}K`}
        />
        <Tooltip content={<CustomTooltip />} />
        <ReferenceLine y={0} stroke="#DDD9D0" strokeWidth={1} />
        <Legend
          wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
          iconType="circle" iconSize={7}
        />

        {/* FII net bars */}
        <Bar dataKey="fiiNet" name="FII Net" maxBarSize={14} radius={[2, 2, 0, 0]}>
          {days.map((d, i) => (
            <Cell key={i} fill={d.fiiNet >= 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.85} />
          ))}
        </Bar>

        {/* DII net bars (offset, smaller) */}
        <Bar dataKey="diiNet" name="DII Net" maxBarSize={10} radius={[2, 2, 0, 0]}>
          {days.map((d, i) => (
            <Cell key={i} fill={d.diiNet >= 0 ? "#3b82f6" : "#f97316"} fillOpacity={0.7} />
          ))}
        </Bar>

        {/* Combined net line */}
        <Line
          type="monotone"
          dataKey="combined"
          name="Combined"
          stroke="#8b5cf6"
          strokeWidth={1.8}
          dot={false}
          strokeDasharray="4 2"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
