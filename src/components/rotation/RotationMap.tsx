"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlowData {
  from: string;
  to: string;
  magnitude: number; // 0-1
  type: "inflow" | "outflow" | "neutral";
}

export interface NodeData {
  id: string;
  label: string;
  value: number; // current allocation %
  x?: number;
  y?: number;
  color: string;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  content: React.ReactNode;
}

// ─── Color helpers ────────────────────────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
  EQUITY:        "#6366f1", // indigo
  GOLD:          "#f59e0b", // amber
  BONDS:         "#3b82f6", // blue
  CASH:          "#10b981", // emerald
  COMMODITIES:   "#ef4444", // red
  INTERNATIONAL: "#8b5cf6", // violet
};

const FLOW_COLORS = {
  inflow:  "#22c55e",
  outflow: "#ef4444",
  neutral: "#94a3b8",
};

// ─── Component ────────────────────────────────────────────────────────────────

interface RotationMapProps {
  nodes: NodeData[];
  flows: FlowData[];
  width?: number;
  height?: number;
  animated?: boolean;
}

export default function RotationMap({
  nodes,
  flows,
  width = 520,
  height = 480,
  animated = true,
}: RotationMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    content: null,
  });

  useEffect(() => {
    if (!svgRef.current || !nodes.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.34;

    // ── Defs (gradients, filters, markers) ───────────────────────────────────
    const defs = svg.append("defs");

    // Arrow markers for each flow type
    (["inflow", "outflow", "neutral"] as const).forEach((type) => {
      defs
        .append("marker")
        .attr("id", `arrow-${type}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 10)
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", FLOW_COLORS[type]);
    });

    // Glow filter
    const glowFilter = defs.append("filter").attr("id", "glow");
    glowFilter
      .append("feGaussianBlur")
      .attr("stdDeviation", "3")
      .attr("result", "coloredBlur");
    const feMerge = glowFilter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // Green glow (receiving)
    const greenGlow = defs.append("filter").attr("id", "greenGlow");
    greenGlow
      .append("feGaussianBlur")
      .attr("stdDeviation", "4")
      .attr("result", "coloredBlur");
    greenGlow
      .append("feFlood")
      .attr("flood-color", "#22c55e")
      .attr("flood-opacity", "0.4")
      .attr("result", "flood");
    greenGlow
      .append("feComposite")
      .attr("in", "flood")
      .attr("in2", "coloredBlur")
      .attr("operator", "in")
      .attr("result", "comp");
    const feMerge2 = greenGlow.append("feMerge");
    feMerge2.append("feMergeNode").attr("in", "comp");
    feMerge2.append("feMergeNode").attr("in", "SourceGraphic");

    // Red glow (sending)
    const redGlow = defs.append("filter").attr("id", "redGlow");
    redGlow
      .append("feGaussianBlur")
      .attr("stdDeviation", "4")
      .attr("result", "coloredBlur");
    redGlow
      .append("feFlood")
      .attr("flood-color", "#ef4444")
      .attr("flood-opacity", "0.4")
      .attr("result", "flood");
    redGlow
      .append("feComposite")
      .attr("in", "flood")
      .attr("in2", "coloredBlur")
      .attr("operator", "in")
      .attr("result", "comp");
    const feMerge3 = redGlow.append("feMerge");
    feMerge3.append("feMergeNode").attr("in", "comp");
    feMerge3.append("feMergeNode").attr("in", "SourceGraphic");

    // Radial gradient for background
    const bgGrad = defs
      .append("radialGradient")
      .attr("id", "bgGrad")
      .attr("cx", "50%")
      .attr("cy", "50%")
      .attr("r", "50%");
    bgGrad
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", "#f8f7ff")
      .attr("stop-opacity", 1);
    bgGrad
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", "#f0f0f8")
      .attr("stop-opacity", 1);

    // ── Background ────────────────────────────────────────────────────────────
    svg
      .append("rect")
      .attr("width", width)
      .attr("height", height)
      .attr("fill", "url(#bgGrad)")
      .attr("rx", 16);

    // Subtle concentric circles
    [0.28, 0.42, 0.56].forEach((r) => {
      svg
        .append("circle")
        .attr("cx", cx)
        .attr("cy", cy)
        .attr("r", radius * r * (1 / 0.34))
        .attr("fill", "none")
        .attr("stroke", "#e2e0f0")
        .attr("stroke-width", 0.5)
        .attr("stroke-dasharray", "4 4");
    });

    // ── Assign node positions on circle ───────────────────────────────────────
    const n = nodes.length;
    const positioned = nodes.map((node, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      return {
        ...node,
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        color: node.color || NODE_COLORS[node.id] || "#6366f1",
      };
    });

    const nodeMap = new Map(positioned.map((n) => [n.id, n]));

    // Determine receiving / sending sets
    const receivingNodes = new Set(flows.filter((f) => f.type === "inflow").map((f) => f.to));
    const sendingNodes   = new Set(flows.filter((f) => f.type === "outflow").map((f) => f.from));

    // ── Draw curved flow paths ────────────────────────────────────────────────
    const flowGroup = svg.append("g").attr("class", "flows");

    flows.forEach((flow) => {
      const src = nodeMap.get(flow.from);
      const dst = nodeMap.get(flow.to);
      if (!src || !dst) return;

      const strokeW = 1 + flow.magnitude * 7;
      const color   = FLOW_COLORS[flow.type];

      // Cubic bezier with control points curving outward
      const mx = (src.x! + dst.x!) / 2;
      const my = (src.y! + dst.y!) / 2;
      // Push control point outward from center
      const dx = mx - cx;
      const dy = my - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const curvature = 0.4;
      const cpx = mx + (dx / (dist || 1)) * radius * curvature;
      const cpy = my + (dy / (dist || 1)) * radius * curvature;

      // Shorten path endpoints to avoid node overlap
      const nodeR = 18 + (src.value / 100) * 20;
      const dstR  = 18 + (dst.value / 100) * 20 + 8; // extra for arrowhead

      const srcAngle = Math.atan2(cpy - src.y!, cpx - src.x!);
      const dstAngle = Math.atan2(cpy - dst.y!, cpx - dst.x!);
      const x1 = src.x! + Math.cos(srcAngle) * nodeR;
      const y1 = src.y! + Math.sin(srcAngle) * nodeR;
      const x2 = dst.x! + Math.cos(dstAngle) * dstR;
      const y2 = dst.y! + Math.sin(dstAngle) * dstR;

      const pathD = `M${x1},${y1} Q${cpx},${cpy} ${x2},${y2}`;

      // Background (wider, dim) path for glow effect
      flowGroup
        .append("path")
        .attr("d", pathD)
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", strokeW + 4)
        .attr("stroke-opacity", 0.08)
        .attr("stroke-linecap", "round");

      // Main path
      const path = flowGroup
        .append("path")
        .attr("d", pathD)
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", strokeW)
        .attr("stroke-opacity", 0.7)
        .attr("stroke-linecap", "round")
        .attr("marker-end", `url(#arrow-${flow.type})`);

      // Animated dashes along path
      if (animated) {
        const totalLen = (path.node() as SVGPathElement)?.getTotalLength?.() ?? 200;
        const dashLen = 12;
        const gapLen  = totalLen - dashLen;

        path
          .attr("stroke-dasharray", `${dashLen} ${gapLen}`)
          .attr("stroke-dashoffset", totalLen);

        path
          .append("animateTransform") // fallback: use CSS animation
          .remove();

        // Use keyframe animation via SVG animate element
        const animate = document.createElementNS("http://www.w3.org/2000/svg", "animate");
        animate.setAttribute("attributeName", "stroke-dashoffset");
        animate.setAttribute("from", `${totalLen}`);
        animate.setAttribute("to", "0");
        animate.setAttribute("dur", `${1.5 + (1 - flow.magnitude) * 2}s`);
        animate.setAttribute("repeatCount", "indefinite");
        animate.setAttribute("calcMode", "linear");
        (path.node() as SVGPathElement)?.appendChild(animate);
      }
    });

    // ── Draw nodes ────────────────────────────────────────────────────────────
    const nodeGroup = svg.append("g").attr("class", "nodes");

    positioned.forEach((node) => {
      const nodeR = 22 + (node.value / 100) * 18;
      const isReceiving = receivingNodes.has(node.id);
      const isSending   = sendingNodes.has(node.id);
      const glowId = isReceiving ? "greenGlow" : isSending ? "redGlow" : "glow";

      const g = nodeGroup
        .append("g")
        .attr("transform", `translate(${node.x},${node.y})`)
        .attr("cursor", "pointer");

      // Outer pulse ring
      if (isReceiving || isSending) {
        const pulseColor = isReceiving ? "#22c55e" : "#ef4444";
        const pulseCircle = g
          .append("circle")
          .attr("r", nodeR + 8)
          .attr("fill", "none")
          .attr("stroke", pulseColor)
          .attr("stroke-width", 2)
          .attr("stroke-opacity", 0.4);

        if (animated) {
          const animR = document.createElementNS("http://www.w3.org/2000/svg", "animate");
          animR.setAttribute("attributeName", "r");
          animR.setAttribute("values", `${nodeR + 4};${nodeR + 14};${nodeR + 4}`);
          animR.setAttribute("dur", "2.5s");
          animR.setAttribute("repeatCount", "indefinite");
          (pulseCircle.node() as SVGCircleElement)?.appendChild(animR);

          const animO = document.createElementNS("http://www.w3.org/2000/svg", "animate");
          animO.setAttribute("attributeName", "stroke-opacity");
          animO.setAttribute("values", "0.5;0;0.5");
          animO.setAttribute("dur", "2.5s");
          animO.setAttribute("repeatCount", "indefinite");
          (pulseCircle.node() as SVGCircleElement)?.appendChild(animO);
        }
      }

      // Node background shadow
      g.append("circle")
        .attr("r", nodeR + 4)
        .attr("fill", node.color)
        .attr("fill-opacity", 0.08)
        .attr("filter", `url(#${glowId})`);

      // Node body
      g.append("circle")
        .attr("r", nodeR)
        .attr("fill", "#ffffff")
        .attr("stroke", node.color)
        .attr("stroke-width", 2.5);

      // Inner fill circle
      g.append("circle")
        .attr("r", nodeR * 0.65)
        .attr("fill", node.color)
        .attr("fill-opacity", 0.18);

      // Node label (ticker)
      g.append("text")
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("font-size", 9)
        .attr("font-weight", "800")
        .attr("fill", node.color)
        .attr("letter-spacing", "0.08em")
        .text(node.id.slice(0, 3));

      // Allocation value below
      g.append("text")
        .attr("text-anchor", "middle")
        .attr("y", nodeR + 14)
        .attr("font-size", 9.5)
        .attr("font-weight", "700")
        .attr("fill", "#374151")
        .text(`${node.value}%`);

      // Full label
      g.append("text")
        .attr("text-anchor", "middle")
        .attr("y", nodeR + 25)
        .attr("font-size", 8.5)
        .attr("fill", "#9ca3af")
        .text(node.label);

      // Hover interaction
      g.on("mouseenter", function (event: MouseEvent) {
        d3.select(this).select("circle:nth-child(2)").attr("stroke-width", 4);

        const relatedFlows = flows.filter(
          (f) => f.from === node.id || f.to === node.id
        );

        setTooltip({
          visible: true,
          x: event.offsetX + 12,
          y: event.offsetY - 12,
          content: (
            <div className="text-xs">
              <p className="font-bold text-gray-900 mb-1">{node.label}</p>
              <p className="text-gray-500 mb-1.5">Allocation: <span className="font-semibold text-gray-800">{node.value}%</span></p>
              {relatedFlows.map((f) => (
                <p key={`${f.from}-${f.to}`} className="text-gray-600">
                  {f.from === node.id ? `→ ${f.to}` : `← ${f.from}`}
                  <span className={["ml-1 font-semibold", f.type === "inflow" ? "text-emerald-600" : f.type === "outflow" ? "text-red-500" : "text-gray-500"].join(" ")}>
                    {Math.round(f.magnitude * 100)}%
                  </span>
                </p>
              ))}
            </div>
          ),
        });
      })
      .on("mouseleave", function () {
        d3.select(this).select("circle:nth-child(2)").attr("stroke-width", 2.5);
        setTooltip((t) => ({ ...t, visible: false }));
      });
    });

    // ── Center label ──────────────────────────────────────────────────────────
    svg
      .append("text")
      .attr("x", cx)
      .attr("y", cy - 6)
      .attr("text-anchor", "middle")
      .attr("font-size", 10)
      .attr("font-weight", "700")
      .attr("fill", "#6b7280")
      .attr("letter-spacing", "0.12em")
      .text("CAPITAL");

    svg
      .append("text")
      .attr("x", cx)
      .attr("y", cy + 8)
      .attr("text-anchor", "middle")
      .attr("font-size", 10)
      .attr("font-weight", "700")
      .attr("fill", "#6b7280")
      .attr("letter-spacing", "0.12em")
      .text("FLOW");

  }, [nodes, flows, width, height, animated]);

  return (
    <div className="relative inline-block">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        className="rounded-2xl"
        style={{ maxWidth: "100%" }}
      />

      {/* Tooltip */}
      {tooltip.visible && (
        <div
          className="absolute pointer-events-none bg-white border border-gray-200 rounded-xl shadow-lg p-3 z-50 min-w-[140px]"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.content}
        </div>
      )}
    </div>
  );
}
