"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ChartData } from "@/app/api/chart/[ticker]/route";

// ─── Overlay toggle state ─────────────────────────────────────────────────────

export interface ChartOverlays {
  vwap:  boolean;
  aVwap: boolean;
  ma50:  boolean;
  ma200: boolean;
  bb:    boolean;
  ob:    boolean;
  vp:    boolean;
  opt:   boolean;
}

interface Props {
  data:     ChartData;
  overlays: ChartOverlays;
  chartType: "candle" | "ha";
  height?:  number;
}

// ─── Color constants ──────────────────────────────────────────────────────────

const C = {
  up:       "#16a34a",
  down:     "#dc2626",
  wick_up:  "#16a34a",
  wick_dn:  "#dc2626",
  ma50:     "#6366f1",
  ma200:    "#f59e0b",
  bbUp:     "#94a3b8",
  bbMid:    "#64748b",
  bbLow:    "#94a3b8",
  vwap:     "#10b981",
  aVwap:    "#0ea5e9",
  vol_up:   "#86efac",
  vol_dn:   "#fca5a5",
  poc:      "#dc2626",
  vah:      "#f59e0b",
  val:      "#f59e0b",
  demand:   "#10b981",
  supply:   "#ef4444",
  opt_mp:   "#8b5cf6",
  opt_sr:   "#0ea5e9",
  grid:     "#f1f5f9",
  text:     "#374151",
  bg:       "#ffffff",
  border:   "#e2e8f0",
};

// ─── Chart component ──────────────────────────────────────────────────────────

export default function TradingChart({ data, overlays, chartType, height = 420 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<unknown>(null);
  const seriesRef    = useRef<Record<string, unknown>>({});
  const [ready, setReady] = useState(false);

  const destroy = useCallback(() => {
    if (chartRef.current) {
      (chartRef.current as { remove: () => void }).remove();
      chartRef.current = null;
      seriesRef.current = {};
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current || !data?.candles?.length) return;

    let chart: unknown;
    let removed = false;

    (async () => {
      const { createChart, CandlestickSeries, LineSeries, HistogramSeries, LineStyle, createSeriesMarkers } =
        await import("lightweight-charts");

      if (removed || !containerRef.current) return;

      destroy();

      const container = containerRef.current;
      chart = createChart(container, {
        layout:    { background: { color: C.bg }, textColor: C.text, fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
        grid:      { vertLines: { color: C.grid, style: LineStyle.Solid }, horzLines: { color: C.grid, style: LineStyle.Solid } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.06, bottom: 0.2 } },
        timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false },
        width:  container.clientWidth,
        height: height,
      });
      chartRef.current = chart;

      type SeriesApi = {
        setData: (d: unknown[]) => void;
        createPriceLine: (opts: unknown) => unknown;
        removePriceLine: (line: unknown) => void;
        options: () => Record<string, unknown>;
        applyOptions: (o: unknown) => void;
      };
      const api = chart as {
        addSeries: (type: unknown, opts?: unknown) => SeriesApi;
        applyOptions: (o: unknown) => void;
        remove: () => void;
        timeScale: () => { fitContent: () => void };
      };

      // ── Main candle/HA series ──
      const mainSeries = api.addSeries(CandlestickSeries, {
        upColor:         C.up,
        downColor:       C.down,
        borderUpColor:   C.up,
        borderDownColor: C.down,
        wickUpColor:     C.wick_up,
        wickDownColor:   C.wick_dn,
        priceScaleId:    "right",
      });

      const candleData = data.candles.map((b) =>
        chartType === "ha"
          ? { time: b.time, open: b.haOpen ?? b.open, high: b.haHigh ?? b.high, low: b.haLow ?? b.low, close: b.haClose ?? b.close }
          : { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }
      );
      mainSeries.setData(candleData);
      seriesRef.current["main"] = mainSeries;

      // ── Volume histogram (sub-pane via separate scale) ──
      const volSeries = api.addSeries(HistogramSeries, {
        priceFormat:  { type: "volume" },
        priceScaleId: "volume",
      });
      (api as unknown as { applyOptions: (o: unknown) => void }).applyOptions({
        leftPriceScale:  { visible: false },
        rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.18 } },
      });

      const volData = data.candles.map((b) => ({
        time:  b.time,
        value: b.volume,
        color: b.close >= b.open ? C.vol_up : C.vol_dn,
      }));
      volSeries.setData(volData);

      // Overlay volume scale to bottom
      (chart as { priceScale: (id: string) => { applyOptions: (o: unknown) => void } })
        .priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
      seriesRef.current["volume"] = volSeries;

      // ── MA50 ──
      const ma50Series = api.addSeries(LineSeries, {
        color:     C.ma50,
        lineWidth: 1,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        title: "MA50",
      });
      ma50Series.setData(
        data.candles.filter((b) => b.ma50 !== null).map((b) => ({ time: b.time, value: b.ma50! }))
      );
      seriesRef.current["ma50"] = ma50Series;

      // ── MA200 ──
      const ma200Series = api.addSeries(LineSeries, {
        color:     C.ma200,
        lineWidth: 1.5,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        title: "MA200",
      });
      ma200Series.setData(
        data.candles.filter((b) => b.ma200 !== null).map((b) => ({ time: b.time, value: b.ma200! }))
      );
      seriesRef.current["ma200"] = ma200Series;

      // ── Bollinger Bands ──
      const bbUpSeries = api.addSeries(LineSeries, {
        color: C.bbUp, lineWidth: 1, lineStyle: LineStyle.Dotted,
        priceLineVisible: false, crosshairMarkerVisible: false, title: "BB+2σ",
      });
      const bbMidSeries = api.addSeries(LineSeries, {
        color: C.bbMid, lineWidth: 1, lineStyle: LineStyle.Dotted,
        priceLineVisible: false, crosshairMarkerVisible: false, title: "BB mid",
      });
      const bbLowSeries = api.addSeries(LineSeries, {
        color: C.bbLow, lineWidth: 1, lineStyle: LineStyle.Dotted,
        priceLineVisible: false, crosshairMarkerVisible: false, title: "BB−2σ",
      });
      const bbCandles = data.candles.filter((b) => b.bbUpper !== null);
      bbUpSeries.setData(bbCandles.map((b) => ({ time: b.time, value: b.bbUpper! })));
      bbMidSeries.setData(bbCandles.map((b) => ({ time: b.time, value: b.bbMid! })));
      bbLowSeries.setData(bbCandles.map((b) => ({ time: b.time, value: b.bbLower! })));
      seriesRef.current["bbUp"]  = bbUpSeries;
      seriesRef.current["bbMid"] = bbMidSeries;
      seriesRef.current["bbLow"] = bbLowSeries;

      // ── VWAP 20d ──
      const vwapSeries = api.addSeries(LineSeries, {
        color: C.vwap, lineWidth: 1.5,
        priceLineVisible: false, crosshairMarkerVisible: false, title: "VWAP20",
      });
      vwapSeries.setData(
        data.candles.filter((b) => b.vwap !== null).map((b) => ({ time: b.time, value: b.vwap! }))
      );
      seriesRef.current["vwap"] = vwapSeries;

      // ── Anchored VWAP (YTD) ──
      const aVwapSeries = api.addSeries(LineSeries, {
        color: C.aVwap, lineWidth: 1.5, lineStyle: LineStyle.LargeDashed,
        priceLineVisible: false, crosshairMarkerVisible: false, title: "aVWAP YTD",
      });
      aVwapSeries.setData(
        data.candles.filter((b) => b.aVwap !== null).map((b) => ({ time: b.time, value: b.aVwap! }))
      );
      seriesRef.current["aVwap"] = aVwapSeries;

      // ── Structure markers (BOS/CHoCH) — v5 API: createSeriesMarkers ──
      if (data.structureMarkers.length > 0) {
        createSeriesMarkers(
          mainSeries as Parameters<typeof createSeriesMarkers>[0],
          data.structureMarkers.map((m) => ({
            time:     m.time,
            position: m.direction === "bull" ? "belowBar" : "aboveBar",
            color:    m.direction === "bull" ? C.up : C.down,
            shape:    m.event.startsWith("CHoCH") ? "arrowUp" : "circle",
            text:     m.event.replace("_B", "↑").replace("_S", "↓"),
            size:     1,
          }))
        );
      }

      // ── Order blocks (demand/supply zones via price lines) ──
      type PriceLineRef = { line: ReturnType<typeof mainSeries.createPriceLine>; color: string };
      const obLines: PriceLineRef[] = [];
      for (const ob of data.orderBlocks) {
        const color   = ob.type === "demand" ? C.demand : C.supply;
        const opacity = ob.active ? "cc" : "55";
        const c       = color + opacity;
        obLines.push({
          line: mainSeries.createPriceLine({
            price: ob.high, color: c, lineWidth: 1,
            lineStyle: LineStyle.Solid, axisLabelVisible: false,
            title: ob.active ? (ob.type === "demand" ? "OB D" : "OB S") : "",
          }),
          color: c,
        });
        obLines.push({
          line: mainSeries.createPriceLine({
            price: ob.low, color: c, lineWidth: 1,
            lineStyle: LineStyle.Solid, axisLabelVisible: false,
          }),
          color: c,
        });
      }
      seriesRef.current["obLines"] = obLines;

      // ── Volume Profile (POC / VAH / VAL) ──
      const vpLines: PriceLineRef[] = [
        {
          line: mainSeries.createPriceLine({
            price: data.volumeProfile.poc, color: C.poc, lineWidth: 1.5,
            lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "POC",
          }),
          color: C.poc,
        },
        {
          line: mainSeries.createPriceLine({
            price: data.volumeProfile.vah, color: C.vah, lineWidth: 1,
            lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "VAH",
          }),
          color: C.vah,
        },
        {
          line: mainSeries.createPriceLine({
            price: data.volumeProfile.val, color: C.val, lineWidth: 1,
            lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "VAL",
          }),
          color: C.val,
        },
      ];
      seriesRef.current["vpLines"] = vpLines;

      // ── Options levels ──
      const optLines: PriceLineRef[] = [];
      const opt = data.optionLevels;
      if (opt.maxPain) {
        optLines.push({
          line: mainSeries.createPriceLine({
            price: opt.maxPain, color: C.opt_mp, lineWidth: 1.5,
            lineStyle: LineStyle.LargeDashed, axisLabelVisible: true, title: "Max Pain",
          }),
          color: C.opt_mp,
        });
      }
      if (opt.resistance) {
        optLines.push({
          line: mainSeries.createPriceLine({
            price: opt.resistance, color: C.opt_sr, lineWidth: 1,
            lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "OI Res",
          }),
          color: C.opt_sr,
        });
      }
      if (opt.support) {
        optLines.push({
          line: mainSeries.createPriceLine({
            price: opt.support, color: C.opt_sr, lineWidth: 1,
            lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "OI Sup",
          }),
          color: C.opt_sr,
        });
      }
      seriesRef.current["optLines"] = optLines;

      // Apply overlay visibility
      applyOverlayVisibility(overlays);

      // Fit content
      (chart as { timeScale: () => { fitContent: () => void } }).timeScale().fitContent();

      // Resize observer
      const ro = new ResizeObserver(() => {
        if (containerRef.current && chart) {
          (chart as { applyOptions: (o: unknown) => void }).applyOptions({
            width: containerRef.current.clientWidth,
          });
        }
      });
      ro.observe(container);

      setReady(true);

      return () => { ro.disconnect(); };
    })();

    return () => {
      removed = true;
      destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, chartType]);

  // Apply overlay visibility changes without rebuilding chart
  const applyOverlayVisibility = useCallback((ov: ChartOverlays) => {
    type SeriesLike    = { applyOptions: (o: unknown) => void };
    type PriceLineRef  = { line: SeriesLike; color: string };

    const s = seriesRef.current as Record<string, unknown>;

    // LineSeries — support native `visible` toggle
    const showSeries = (key: string, visible: boolean) => {
      const v = s[key] as SeriesLike | undefined;
      if (v) v.applyOptions({ visible });
    };
    showSeries("vwap",   ov.vwap);
    showSeries("aVwap",  ov.aVwap);
    showSeries("ma50",   ov.ma50);
    showSeries("ma200",  ov.ma200);
    showSeries("bbUp",   ov.bb);
    showSeries("bbMid",  ov.bb);
    showSeries("bbLow",  ov.bb);

    // Price lines — toggle by setting color to transparent or original
    const showPriceLines = (key: string, visible: boolean) => {
      const lines = s[key] as PriceLineRef[] | undefined;
      if (!lines) return;
      for (const { line, color } of lines) {
        line.applyOptions({ color: visible ? color : "rgba(0,0,0,0)" });
      }
    };
    showPriceLines("obLines",  ov.ob);
    showPriceLines("vpLines",  ov.vp);
    showPriceLines("optLines", ov.opt);
  }, []);

  useEffect(() => {
    if (ready) applyOverlayVisibility(overlays);
  }, [overlays, ready, applyOverlayVisibility]);

  return (
    <div className="relative w-full" style={{ height }}>
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-white rounded-xl">
          <div className="flex flex-col items-center gap-2">
            <div className="w-6 h-6 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
            <span className="text-[10px] text-gray-400">Loading chart…</span>
          </div>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
