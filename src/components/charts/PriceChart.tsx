"use client";

import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
} from "recharts";

interface PricePoint {
  date: string;
  close: number;
  sma20?: number;
  sma50?: number;
  bbUpper?: number;
  bbLower?: number;
  rsi?: number;
}

interface PriceChartProps {
  data: PricePoint[];
  ticker?: string;
  height?: number;
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────────
const CustomTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-3 text-xs min-w-[160px]">
      <p className="font-semibold text-gray-700 mb-2">{label}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: entry.color }}
            />
            <span className="text-gray-500">{entry.name}</span>
          </span>
          <span className="font-mono font-medium" style={{ color: entry.color }}>
            {typeof entry.value === "number" ? entry.value.toFixed(2) : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
};

const RSITooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  const rsi = payload[0]?.value;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-2 text-xs">
      <p className="text-gray-500">{label}</p>
      <p
        className="font-semibold font-mono"
        style={{
          color:
            rsi > 70 ? "#ef4444" : rsi < 30 ? "#22c55e" : "#6b7280",
        }}
      >
        RSI: {rsi?.toFixed(1)}
      </p>
    </div>
  );
};

export default function PriceChart({ data, ticker = "Asset", height = 380 }: PriceChartProps) {
  // Tick formatter for dates
  const tickFmt = (v: string) => {
    if (!v) return "";
    const d = new Date(v);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  };

  return (
    <div className="flex flex-col gap-1">
      {/* ── Price + Bollinger + SMA panel ────────────────────────────────── */}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="bbFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.08} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#f0eeea" vertical={false} />

          <XAxis
            dataKey="date"
            tickFormatter={tickFmt}
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            axisLine={false}
            tickLine={false}
            width={60}
            tickFormatter={(v) =>
              v >= 1000
                ? (v / 1000).toFixed(1) + "k"
                : v.toFixed(2)
            }
          />

          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
            iconType="line"
          />

          {/* Bollinger Band shading area */}
          <Area
            type="monotone"
            dataKey="bbUpper"
            stroke="none"
            fill="url(#bbFill)"
            legendType="none"
            name="BB Upper"
          />
          <Area
            type="monotone"
            dataKey="bbLower"
            stroke="none"
            fill="white"
            legendType="none"
            name="BB Lower"
          />

          {/* BB Upper line */}
          <Line
            type="monotone"
            dataKey="bbUpper"
            stroke="#93c5fd"
            strokeWidth={1}
            dot={false}
            strokeDasharray="4 2"
            name="BB Upper"
          />
          {/* BB Lower line */}
          <Line
            type="monotone"
            dataKey="bbLower"
            stroke="#93c5fd"
            strokeWidth={1}
            dot={false}
            strokeDasharray="4 2"
            name="BB Lower"
          />

          {/* SMA 50 */}
          <Line
            type="monotone"
            dataKey="sma50"
            stroke="#f59e0b"
            strokeWidth={1.5}
            dot={false}
            name="SMA 50"
          />
          {/* SMA 20 */}
          <Line
            type="monotone"
            dataKey="sma20"
            stroke="#8b5cf6"
            strokeWidth={1.5}
            dot={false}
            name="SMA 20"
          />

          {/* Close price — drawn last to be on top */}
          <Line
            type="monotone"
            dataKey="close"
            stroke="#1d4ed8"
            strokeWidth={2}
            dot={false}
            name={ticker}
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* ── RSI panel ─────────────────────────────────────────────────────── */}
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          {/* OB/OS reference lines rendered as areas */}
          <defs>
            <linearGradient id="rsiOb" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity={0.12} />
              <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="rsiOs" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#22c55e" stopOpacity={0.12} />
              <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#f0eeea" vertical={false} />
          <XAxis dataKey="date" hide />
          <YAxis
            domain={[0, 100]}
            ticks={[30, 50, 70]}
            tick={{ fontSize: 9, fill: "#9ca3af" }}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <Tooltip content={<RSITooltip />} />

          <Line
            type="monotone"
            dataKey="rsi"
            stroke="#6366f1"
            strokeWidth={1.5}
            dot={false}
            name="RSI"
          />
        </LineChart>
      </ResponsiveContainer>

      {/* RSI legend labels */}
      <div className="flex items-center gap-4 px-1 text-[10px] text-gray-400">
        <span className="text-red-400">OB &gt; 70</span>
        <span className="text-indigo-400">RSI (14)</span>
        <span className="text-green-400">OS &lt; 30</span>
      </div>
    </div>
  );
}
