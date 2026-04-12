"use client";

import { cn } from "@/lib/utils";

export type SignalVerdict =
  | "Bullish"
  | "Bearish"
  | "Neutral"
  | "Overbought"
  | "Oversold";

interface SignalBadgeProps {
  verdict: SignalVerdict;
  className?: string;
  size?: "sm" | "md";
}

const VERDICT_STYLES: Record<
  SignalVerdict,
  { bg: string; text: string; border: string; dot: string }
> = {
  Bullish: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    dot: "bg-emerald-500",
  },
  Bearish: {
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-200",
    dot: "bg-red-500",
  },
  Neutral: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    dot: "bg-amber-400",
  },
  Overbought: {
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-200",
    dot: "bg-orange-500",
  },
  Oversold: {
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
    dot: "bg-blue-500",
  },
};

export default function SignalBadge({
  verdict,
  className,
  size = "md",
}: SignalBadgeProps) {
  const styles = VERDICT_STYLES[verdict];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-semibold",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
        styles.bg,
        styles.text,
        styles.border,
        className
      )}
    >
      <span
        className={cn(
          "rounded-full",
          size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
          styles.dot
        )}
      />
      {verdict}
    </span>
  );
}
