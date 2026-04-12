"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  Tooltip,
} from "recharts";

interface SparklineChartProps {
  data: number[];
  color?: string;
  height?: number;
  area?: boolean;
  showTooltip?: boolean;
}

export default function SparklineChart({
  data,
  color = "#2563eb",
  height = 40,
  area = true,
  showTooltip = false,
}: SparklineChartProps) {
  if (!data?.length) return <div style={{ height }} />;
  const chartData = data.map((value, index) => ({ value, index }));
  const gradientId = `sg-${color.replace("#", "")}`;

  if (area) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {showTooltip && (
            <Tooltip
              content={({ payload }) => {
                if (!payload?.length) return null;
                return (
                  <div className="bg-gray-900 text-white text-[10px] px-2 py-1 rounded shadow">
                    {Number(payload[0].value).toFixed(2)}
                  </div>
                );
              }}
            />
          )}
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.8}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
