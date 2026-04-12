import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: number, symbol = "₹"): string {
  if (Math.abs(value) >= 10000000) return `${symbol}${(value / 10000000).toFixed(2)}Cr`;
  if (Math.abs(value) >= 100000) return `${symbol}${(value / 100000).toFixed(2)}L`;
  if (Math.abs(value) >= 1000) return `${symbol}${(value / 1000).toFixed(2)}K`;
  return `${symbol}${value.toFixed(2)}`;
}

export function formatPercent(value: number, decimals = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

export function formatNumber(value: number, decimals = 2): string {
  if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(decimals)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(decimals)}K`;
  return value.toFixed(decimals);
}

export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function getChangeColor(value: number): string {
  if (value > 0) return 'text-emerald-600';
  if (value < 0) return 'text-red-600';
  return 'text-amber-600';
}

export function getChangeBg(value: number): string {
  if (value > 0) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (value < 0) return 'bg-red-50 text-red-700 border-red-200';
  return 'bg-amber-50 text-amber-700 border-amber-200';
}
