"use client";

/**
 * LightweightChart — TradingView Lightweight Charts v5 wrapper
 * Renders a candlestick chart with volume histogram + SMA overlays.
 * Dynamic-imported in page components to avoid SSR issues.
 */

import { useEffect, useRef } from "react";

export interface OHLCVBar {
  date: string;   // "YYYY-MM-DD"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface LightweightChartProps {
  data: OHLCVBar[];
  sma20?: (number | null)[];
  sma50?: (number | null)[];
  height?: number;
}

export default function LightweightChart({
  data,
  sma20,
  sma50,
  height = 380,
}: LightweightChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef   = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current || data.length < 2) return;

    let cancelled = false;

    import("lightweight-charts").then((lc) => {
      if (cancelled || !containerRef.current) return;

      const { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries, LineSeries } = lc as any;

      const chart = createChart(containerRef.current, {
        width:  containerRef.current.clientWidth,
        height,
        layout: {
          background:  { type: ColorType.Solid, color: "#FFFFFF" },
          textColor:   "#9A9590",
          fontSize:    11,
          fontFamily:  "ui-monospace, SFMono-Regular, Menlo, monospace",
        },
        grid: {
          vertLines: { color: "#F5F4F0" },
          horzLines: { color: "#F5F4F0" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: "#1B3A5C",
            width: 1,
            style: 2,
            labelBackgroundColor: "#1B3A5C",
          },
          horzLine: {
            color: "#1B3A5C",
            width: 1,
            style: 2,
            labelBackgroundColor: "#1B3A5C",
          },
        },
        rightPriceScale: {
          borderColor:   "#ECEAE4",
          scaleMargins:  { top: 0.06, bottom: 0.22 },
          ticksVisible:  true,
        },
        timeScale: {
          borderColor:      "#ECEAE4",
          timeVisible:      false,
          fixLeftEdge:      true,
          fixRightEdge:     true,
          barSpacing:       8,
          rightBarStaysOnScroll: true,
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale:  { mouseWheel: true, pinch: true },
      });

      // ── Candlestick series ──────────────────────────────────────────────
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor:         "#22c55e",
        downColor:       "#ef4444",
        borderUpColor:   "#22c55e",
        borderDownColor: "#ef4444",
        wickUpColor:     "#86EFAC",
        wickDownColor:   "#FCA5A5",
      });

      const candleData = data.map((d) => ({
        time:  d.date,
        open:  d.open,
        high:  d.high,
        low:   d.low,
        close: d.close,
      }));
      candleSeries.setData(candleData);

      // ── Volume histogram (bottom 20% of same pane) ──────────────────────
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat:  { type: "volume" },
        priceScaleId: "volume",
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });

      const volData = data.map((d) => ({
        time:  d.date,
        value: d.volume,
        color: d.close >= d.open ? "#86EFAC80" : "#FCA5A580",
      }));
      volumeSeries.setData(volData);

      // ── SMA 20 (blue) ───────────────────────────────────────────────────
      if (sma20?.length) {
        const sma20Points = data
          .map((d, i) => (sma20[i] != null ? { time: d.date, value: sma20[i]! } : null))
          .filter(Boolean);

        if (sma20Points.length > 0) {
          const sma20Series = chart.addSeries(LineSeries, {
            color:                "#60A5FA",
            lineWidth:            1,
            priceLineVisible:     false,
            lastValueVisible:     false,
            crosshairMarkerVisible: false,
          });
          sma20Series.setData(sma20Points as any);
        }
      }

      // ── SMA 50 (orange) ─────────────────────────────────────────────────
      if (sma50?.length) {
        const sma50Points = data
          .map((d, i) => (sma50[i] != null ? { time: d.date, value: sma50[i]! } : null))
          .filter(Boolean);

        if (sma50Points.length > 0) {
          const sma50Series = chart.addSeries(LineSeries, {
            color:                "#FB923C",
            lineWidth:            1,
            priceLineVisible:     false,
            lastValueVisible:     false,
            crosshairMarkerVisible: false,
          });
          sma50Series.setData(sma50Points as any);
        }
      }

      chart.timeScale().fitContent();

      // ── Responsive resize ───────────────────────────────────────────────
      const ro = new ResizeObserver(() => {
        if (containerRef.current) {
          chart.resize(containerRef.current.clientWidth, height);
        }
      });
      ro.observe(containerRef.current!);

      cleanupRef.current = () => {
        ro.disconnect();
        chart.remove();
      };
    });

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // Stringify to avoid re-render on every parent render cycle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(data.map((d) => d.date + d.close)), height]);

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="w-full"
    />
  );
}
