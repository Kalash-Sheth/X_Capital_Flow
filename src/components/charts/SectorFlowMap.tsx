"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";

export interface SectorNode {
  id:          string;
  name:        string;
  color:       string;
  flowScore:   number;   // –100 to +100
  flowDirection: "Inflow" | "Outflow" | "Neutral";
  rsi:         number;
  change1M:    number;
  relStrength: number;
}

interface Tooltip {
  visible: boolean;
  x: number;
  y: number;
  content: React.ReactNode;
}

interface Props {
  sectors:  SectorNode[];
  width?:   number;
  height?:  number;
  animated?: boolean;
}

export default function SectorFlowMap({
  sectors,
  width  = 560,
  height = 520,
  animated = true,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<Tooltip>({ visible: false, x: 0, y: 0, content: null });

  useEffect(() => {
    if (!svgRef.current || !sectors.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const cx = width / 2;
    const cy = height / 2;
    const R  = Math.min(width, height) * 0.36;

    // ── Defs ────────────────────────────────────────────────────────────────
    const defs = svg.append("defs");

    // Arrow markers
    (["green", "red", "neutral"] as const).forEach((t) => {
      const color = t === "green" ? "#22c55e" : t === "red" ? "#ef4444" : "#94a3b8";
      defs.append("marker")
        .attr("id", `sarrow-${t}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 10).attr("refY", 0)
        .attr("markerWidth", 5).attr("markerHeight", 5)
        .attr("orient", "auto")
        .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", color);
    });

    // Glow filters
    const makeGlow = (id: string, color: string, blur: number) => {
      const f = defs.append("filter").attr("id", id);
      f.append("feGaussianBlur").attr("stdDeviation", blur).attr("result", "cb");
      f.append("feFlood").attr("flood-color", color).attr("flood-opacity", "0.5").attr("result", "fl");
      f.append("feComposite").attr("in", "fl").attr("in2", "cb").attr("operator", "in").attr("result", "comp");
      const m = f.append("feMerge");
      m.append("feMergeNode").attr("in", "comp");
      m.append("feMergeNode").attr("in", "SourceGraphic");
    };
    makeGlow("sf-green", "#22c55e", 5);
    makeGlow("sf-red",   "#ef4444", 5);
    makeGlow("sf-glow",  "#6366f1", 2);

    // Radial background gradient
    const bg = defs.append("radialGradient").attr("id", "sf-bg")
      .attr("cx", "50%").attr("cy", "50%").attr("r", "50%");
    bg.append("stop").attr("offset", "0%").attr("stop-color", "#1a2744").attr("stop-opacity", 1);
    bg.append("stop").attr("offset", "100%").attr("stop-color", "#0f1629").attr("stop-opacity", 1);

    // ── Background ──────────────────────────────────────────────────────────
    svg.append("rect").attr("width", width).attr("height", height)
      .attr("fill", "url(#sf-bg)").attr("rx", 20);

    // Subtle grid rings
    [0.30, 0.50, 0.70, 0.90].forEach((pct) => {
      svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", R * pct)
        .attr("fill", "none").attr("stroke", "rgba(255,255,255,0.05)")
        .attr("stroke-width", 0.5).attr("stroke-dasharray", "3 5");
    });
    // Radial spokes
    const n = sectors.length;
    sectors.forEach((_, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      svg.append("line")
        .attr("x1", cx).attr("y1", cy)
        .attr("x2", cx + R * 1.05 * Math.cos(angle))
        .attr("y2", cy + R * 1.05 * Math.sin(angle))
        .attr("stroke", "rgba(255,255,255,0.04)").attr("stroke-width", 0.5);
    });

    // ── Position nodes ──────────────────────────────────────────────────────
    const positioned = sectors.map((s, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      // Node radius: larger for stronger flow either way
      const nodeR = 20 + (Math.abs(s.flowScore) / 100) * 14;
      return { ...s, x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle), nodeR, angle };
    });
    const nodeMap = new Map(positioned.map((p) => [p.id, p]));

    // ── Build flows: top 3 outflows → top 3 inflows ─────────────────────────
    const inflows  = [...positioned].filter(s => s.flowDirection === "Inflow")
      .sort((a, b) => b.flowScore - a.flowScore).slice(0, 3);
    const outflows = [...positioned].filter(s => s.flowDirection === "Outflow")
      .sort((a, b) => a.flowScore - b.flowScore).slice(0, 3);

    // Draw flows
    outflows.forEach((src) => {
      inflows.forEach((dst) => {
        const magnitude = (Math.abs(src.flowScore) + dst.flowScore) / 200;

        const mx = (src.x + dst.x) / 2;
        const my = (src.y + dst.y) / 2;
        const dx = mx - cx, dy = my - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const cpx = mx + (dx / dist) * R * 0.35;
        const cpy = my + (dy / dist) * R * 0.35;

        const srcA = Math.atan2(cpy - src.y, cpx - src.x);
        const dstA = Math.atan2(cpy - dst.y, cpx - dst.x);
        const x1 = src.x + Math.cos(srcA) * (src.nodeR + 2);
        const y1 = src.y + Math.sin(srcA) * (src.nodeR + 2);
        const x2 = dst.x + Math.cos(dstA) * (dst.nodeR + 10);
        const y2 = dst.y + Math.sin(dstA) * (dst.nodeR + 10);

        const d = `M${x1},${y1} Q${cpx},${cpy} ${x2},${y2}`;
        const strokeW = 1.5 + magnitude * 5;

        // Glow halo
        svg.append("path").attr("d", d).attr("fill", "none")
          .attr("stroke", "#22c55e").attr("stroke-width", strokeW + 6)
          .attr("stroke-opacity", 0.06).attr("stroke-linecap", "round");

        // Main line
        const path = svg.append("path").attr("d", d).attr("fill", "none")
          .attr("stroke", "#22c55e").attr("stroke-width", strokeW)
          .attr("stroke-opacity", 0.75).attr("stroke-linecap", "round")
          .attr("marker-end", "url(#sarrow-green)");

        // Dash animation
        if (animated) {
          const el = path.node() as SVGPathElement;
          const len = el?.getTotalLength?.() ?? 200;
          const dashLen = 10, gap = len - dashLen;
          path.attr("stroke-dasharray", `${dashLen} ${gap}`)
            .attr("stroke-dashoffset", len);

          const a = document.createElementNS("http://www.w3.org/2000/svg", "animate");
          a.setAttribute("attributeName", "stroke-dashoffset");
          a.setAttribute("from", `${len}`);
          a.setAttribute("to", "0");
          a.setAttribute("dur", `${1.8 + (1 - magnitude) * 1.5}s`);
          a.setAttribute("repeatCount", "indefinite");
          a.setAttribute("calcMode", "linear");
          el?.appendChild(a);
        }
      });
    });

    // ── Draw nodes ──────────────────────────────────────────────────────────
    positioned.forEach((node) => {
      const isIn  = node.flowDirection === "Inflow";
      const isOut = node.flowDirection === "Outflow";
      const glowId = isIn ? "sf-green" : isOut ? "sf-red" : "sf-glow";
      const borderColor = isIn ? "#22c55e" : isOut ? "#ef4444" : "#6b7280";
      const { nodeR } = node;

      const g = svg.append("g")
        .attr("transform", `translate(${node.x},${node.y})`)
        .attr("cursor", "pointer");

      // Outer pulse ring for active flows
      if (isIn || isOut) {
        const pulseColor = isIn ? "#22c55e" : "#ef4444";
        const pulse = g.append("circle").attr("r", nodeR + 10)
          .attr("fill", "none").attr("stroke", pulseColor)
          .attr("stroke-width", 1.5).attr("stroke-opacity", 0.35);

        if (animated) {
          const ar = document.createElementNS("http://www.w3.org/2000/svg", "animate");
          ar.setAttribute("attributeName", "r");
          ar.setAttribute("values", `${nodeR + 6};${nodeR + 16};${nodeR + 6}`);
          ar.setAttribute("dur", isIn ? "2s" : "2.8s");
          ar.setAttribute("repeatCount", "indefinite");
          (pulse.node() as SVGCircleElement)?.appendChild(ar);

          const ao = document.createElementNS("http://www.w3.org/2000/svg", "animate");
          ao.setAttribute("attributeName", "stroke-opacity");
          ao.setAttribute("values", "0.5;0;0.5");
          ao.setAttribute("dur", isIn ? "2s" : "2.8s");
          ao.setAttribute("repeatCount", "indefinite");
          (pulse.node() as SVGCircleElement)?.appendChild(ao);
        }
      }

      // Glow halo
      g.append("circle").attr("r", nodeR + 6).attr("fill", node.color)
        .attr("fill-opacity", 0.15).attr("filter", `url(#${glowId})`);

      // Node body (dark fill)
      g.append("circle").attr("r", nodeR).attr("fill", "#1e2d4a")
        .attr("stroke", borderColor).attr("stroke-width", 2);

      // Inner fill dot
      g.append("circle").attr("r", nodeR * 0.55)
        .attr("fill", node.color).attr("fill-opacity", 0.25);

      // Short ticker label inside
      const short = node.id.replace("NIFTY_", "").slice(0, 5);
      g.append("text").attr("text-anchor", "middle").attr("dominant-baseline", "central")
        .attr("font-size", nodeR > 28 ? 9.5 : 8.5)
        .attr("font-weight", "800").attr("fill", node.color)
        .attr("letter-spacing", "0.05em").text(short);

      // Flow score badge below node
      const scoreText = (node.flowScore > 0 ? "+" : "") + node.flowScore.toFixed(0);
      const scoreColor = isIn ? "#4ade80" : isOut ? "#f87171" : "#9ca3af";
      g.append("text").attr("text-anchor", "middle").attr("y", nodeR + 14)
        .attr("font-size", 9).attr("font-weight", "700").attr("fill", scoreColor)
        .text(scoreText);

      // Name label
      const nameParts = node.name.split(" & ")[0].split(" ");
      const shortName = nameParts.length > 2 ? nameParts.slice(0, 2).join(" ") : node.name;
      g.append("text").attr("text-anchor", "middle").attr("y", nodeR + 25)
        .attr("font-size", 8).attr("fill", "rgba(255,255,255,0.4)").text(shortName);

      // Hover
      g.on("mouseenter", function(event: MouseEvent) {
        d3.select(this).select("circle:nth-child(3)").attr("stroke-width", 3.5);
        const rect = svgRef.current!.getBoundingClientRect();
        setTooltip({
          visible: true,
          x: event.clientX - rect.left + 14,
          y: event.clientY - rect.top - 14,
          content: (
            <div className="text-xs space-y-1.5">
              <p className="font-bold text-foreground" style={{ color: node.color }}>{node.name}</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <span className="text-muted-foreground">Flow Score</span>
                <span className="font-semibold tabular-nums" style={{ color: scoreColor }}>{scoreText}</span>
                <span className="text-muted-foreground">RSI 14</span>
                <span className="font-semibold tabular-nums">{node.rsi.toFixed(1)}</span>
                <span className="text-muted-foreground">1M Change</span>
                <span className={["font-semibold tabular-nums", node.change1M > 0 ? "text-emerald-600" : "text-red-600"].join(" ")}>
                  {node.change1M > 0 ? "+" : ""}{node.change1M.toFixed(2)}%
                </span>
                <span className="text-muted-foreground">Rel. Strength</span>
                <span className={["font-semibold tabular-nums", node.relStrength > 100 ? "text-emerald-600" : "text-red-500"].join(" ")}>
                  {node.relStrength.toFixed(1)}
                </span>
              </div>
              <p className="pt-0.5 border-t border-[#E8E6DF] text-[10px] font-semibold" style={{ color: borderColor }}>
                {isIn ? "▲ Capital Inflow" : isOut ? "▼ Capital Outflow" : "→ Neutral"}
              </p>
            </div>
          ),
        });
      })
      .on("mouseleave", function() {
        d3.select(this).select("circle:nth-child(3)").attr("stroke-width", 2);
        setTooltip(t => ({ ...t, visible: false }));
      });
    });

    // ── Centre label ────────────────────────────────────────────────────────
    svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 36)
      .attr("fill", "rgba(255,255,255,0.04)").attr("stroke", "rgba(255,255,255,0.08)")
      .attr("stroke-width", 1);
    svg.append("text").attr("x", cx).attr("y", cy - 8)
      .attr("text-anchor", "middle").attr("font-size", 9).attr("font-weight", "700")
      .attr("fill", "rgba(255,255,255,0.35)").attr("letter-spacing", "0.12em").text("SECTOR");
    svg.append("text").attr("x", cx).attr("y", cy + 5)
      .attr("text-anchor", "middle").attr("font-size", 9).attr("font-weight", "700")
      .attr("fill", "rgba(255,255,255,0.35)").attr("letter-spacing", "0.12em").text("CAPITAL");
    svg.append("text").attr("x", cx).attr("y", cy + 18)
      .attr("text-anchor", "middle").attr("font-size", 9).attr("font-weight", "700")
      .attr("fill", "rgba(255,255,255,0.35)").attr("letter-spacing", "0.12em").text("FLOW");

  }, [sectors, width, height, animated]);

  return (
    <div className="relative">
      <svg ref={svgRef} width={width} height={height}
        className="rounded-2xl w-full" style={{ maxWidth: "100%" }} />
      {tooltip.visible && (
        <div
          className="absolute pointer-events-none bg-white border border-[#E8E6DF] rounded-xl shadow-xl p-3 z-50 min-w-[180px]"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.content}
        </div>
      )}
    </div>
  );
}
