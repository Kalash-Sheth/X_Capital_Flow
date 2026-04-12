// =============================================================================
// X-Capital Flow — Shared TypeScript Types
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Enumerations (mirror Prisma enums for client-side use)
// ─────────────────────────────────────────────────────────────────────────────

export type AssetClass =
  | "EQUITY"
  | "FIXED_INCOME"
  | "COMMODITY"
  | "CURRENCY"
  | "CRYPTO"
  | "REAL_ESTATE"
  | "ALTERNATIVE";

export type SignalDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export type SignalStrength = "STRONG" | "MODERATE" | "WEAK";

export type RegimeType =
  | "RISK_ON"
  | "RISK_OFF"
  | "STAGFLATION"
  | "DEFLATION"
  | "RECOVERY"
  | "EXPANSION"
  | "CONTRACTION"
  | "UNKNOWN";

export type InsightType =
  | "MARKET_OVERVIEW"
  | "ROTATION_SIGNAL"
  | "RISK_ALERT"
  | "OPPORTUNITY"
  | "MACRO_ANALYSIS"
  | "SECTOR_ANALYSIS";

// ─────────────────────────────────────────────────────────────────────────────
// Core domain entities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master record for a tracked financial instrument.
 */
export interface Asset {
  id: string;
  ticker: string;
  name: string;
  assetClass: AssetClass;
  sector?: string | null;
  region?: string | null;
  currency: string;
  isActive: boolean;
  createdAt: string; // ISO-8601
  updatedAt: string;
}

/**
 * Single OHLCV candle for an asset.
 */
export interface PriceData {
  id: string;
  assetId: string;
  timestamp: string; // ISO-8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  adjClose?: number | null;
  source?: string | null;
  createdAt: string;
}

/**
 * Computed technical or macro indicator value for a single bar.
 */
export interface Indicator {
  id: string;
  assetId: string;
  name: string;
  value: number;
  timestamp: string;
  period?: number | null;
  parameters?: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Directional trading or rotation signal for an asset.
 */
export interface Signal {
  id: string;
  assetId: string;
  direction: SignalDirection;
  strength: SignalStrength;
  confidence: number; // 0.0 – 1.0
  source: string;
  rationale?: string | null;
  entryPrice?: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  riskReward?: number | null;
  expiresAt?: string | null;
  isActive: boolean;
  triggeredAt: string;
  createdAt: string;
  updatedAt: string;
  // Populated via join when requested
  asset?: Asset;
}

/**
 * Records a capital rotation event between two assets or asset classes.
 */
export interface RotationLog {
  id: string;
  fromAssetId?: string | null;
  toAssetId?: string | null;
  regime: RegimeType;
  allocationPct: number;
  notionalValue?: number | null;
  rationale?: string | null;
  momentum?: number | null;
  relativeStrength?: number | null;
  executedAt: string;
  createdAt: string;
  // Populated via join when requested
  fromAsset?: Asset | null;
  toAsset?: Asset | null;
}

/**
 * LLM-generated market analysis or recommendation.
 */
export interface AIInsight {
  id: string;
  type: InsightType;
  title: string;
  summary: string;
  content: string;
  modelUsed: string;
  promptTokens?: number | null;
  outputTokens?: number | null;
  regime?: RegimeType | null;
  confidence?: number | null;
  tags: string[];
  relatedTickers: string[];
  isPublished: boolean;
  generatedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio & Allocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single line item in a target or current portfolio allocation.
 */
export interface PortfolioAllocation {
  asset: Asset;
  targetPct: number;    // desired allocation 0–100
  currentPct: number;   // current actual allocation 0–100
  driftPct: number;     // currentPct - targetPct (positive = overweight)
  notionalValue?: number;
  signal?: Signal | null;
}

/**
 * Full portfolio snapshot with aggregate metadata.
 */
export interface Portfolio {
  id: string;
  name: string;
  description?: string;
  totalValue: number;
  currency: string;
  regime: RegimeType;
  allocations: PortfolioAllocation[];
  lastRebalancedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rotation Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The output of a capital rotation analysis run.
 */
export interface RotationResult {
  regime: RegimeType;
  regimeConfidence: number;              // 0.0 – 1.0
  timestamp: string;
  recommendedAllocations: PortfolioAllocation[];
  rotations: SuggestedRotation[];
  rationale: string;
  aiInsight?: AIInsight | null;
}

/**
 * A single suggested rotation action.
 */
export interface SuggestedRotation {
  fromAsset: Asset | null;              // null = from cash
  toAsset: Asset | null;               // null = to cash
  allocationPct: number;
  urgency: "IMMEDIATE" | "NEAR_TERM" | "GRADUAL";
  rationale: string;
  expectedReturn?: number | null;
  riskScore?: number | null;           // 0–10 scale
}

// ─────────────────────────────────────────────────────────────────────────────
// Market Data (API responses / aggregations)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregated market data snapshot for a single asset (used in dashboards).
 */
export interface MarketData {
  asset: Asset;
  latestPrice: number;
  priceChange1D: number;        // absolute change
  priceChangePct1D: number;     // percentage change (e.g. 2.5 = +2.5%)
  priceChangePct1W: number;
  priceChangePct1M: number;
  priceChangePct3M: number;
  priceChangePct1Y: number;
  volume24h?: number | null;
  marketCap?: number | null;
  high52W?: number | null;
  low52W?: number | null;
  beta?: number | null;         // vs benchmark (e.g. S&P 500)
  updatedAt: string;
}

/**
 * A candlestick / time-series data point for charting.
 */
export interface CandlePoint {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * A generic time-series value for indicator or price charts.
 */
export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
  label?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Technical Signals & Indicators (computed / display layer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot of key technical indicator values for a single asset at a point in time.
 */
export interface TechnicalSignals {
  assetId: string;
  ticker: string;
  timestamp: string;

  // Trend
  sma20?: number | null;
  sma50?: number | null;
  sma200?: number | null;
  ema12?: number | null;
  ema26?: number | null;
  priceVsSma20?: number | null;    // % above/below
  priceVsSma50?: number | null;
  priceVsSma200?: number | null;

  // Momentum
  rsi14?: number | null;           // 0–100
  macd?: number | null;
  macdSignal?: number | null;
  macdHistogram?: number | null;
  roc10?: number | null;           // rate of change
  roc20?: number | null;

  // Volatility
  atr14?: number | null;
  bollingerUpper?: number | null;
  bollingerLower?: number | null;
  bollingerWidth?: number | null;  // (upper - lower) / middle
  historicalVol20?: number | null; // annualised

  // Volume
  obv?: number | null;             // on-balance volume
  volumeSma20?: number | null;
  volumeRatio?: number | null;     // current volume / sma20

  // Relative strength
  relativeStrengthVsSPY?: number | null; // RS vs S&P 500 (1 = equal)
  relativeStrengthVsBenchmark?: number | null;
  rsRank?: number | null;          // percentile rank vs peer universe

  // Composite scores (0–100)
  trendScore?: number | null;
  momentumScore?: number | null;
  volatilityScore?: number | null;
  overallScore?: number | null;

  // Derived signal
  signal: SignalDirection;
  signalStrength: SignalStrength;
  confidence: number; // 0.0 – 1.0
}

// ─────────────────────────────────────────────────────────────────────────────
// Macro / Regime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A set of macro economic indicator readings used for regime classification.
 */
export interface MacroIndicators {
  timestamp: string;

  // Growth
  gdpGrowthYoY?: number | null;
  pmManufacturing?: number | null;
  pmServices?: number | null;
  industrialProductionYoY?: number | null;
  retailSalesYoY?: number | null;

  // Inflation
  cpiYoY?: number | null;
  pceYoY?: number | null;
  ppiYoY?: number | null;

  // Labour
  unemploymentRate?: number | null;
  nonfarmPayrolls?: number | null;

  // Credit & Rates
  fedFundsRate?: number | null;
  tenYearYield?: number | null;
  twoYearYield?: number | null;
  yieldCurve?: number | null;        // 10Y – 2Y spread
  creditSpreadHY?: number | null;    // high-yield spread (bps)
  creditSpreadIG?: number | null;    // investment-grade spread (bps)

  // Risk sentiment
  vix?: number | null;
  fearGreedIndex?: number | null;    // 0–100
  dollarIndex?: number | null;       // DXY

  // Commodities
  goldPrice?: number | null;
  oilPriceWTI?: number | null;
  copperPrice?: number | null;
}

/**
 * Current market regime assessment.
 */
export interface RegimeAssessment {
  regime: RegimeType;
  confidence: number;  // 0.0 – 1.0
  description: string;
  keyDrivers: string[];
  macroIndicators: MacroIndicators;
  preferredAssetClasses: AssetClass[];
  avoidedAssetClasses: AssetClass[];
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI / Display helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic status / badge display variant.
 */
export type DisplayVariant =
  | "positive"
  | "negative"
  | "caution"
  | "neutral"
  | "brand"
  | "muted";

/**
 * A single item in a filter / select control.
 */
export interface SelectOption<T = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

/**
 * Pagination metadata returned from list API endpoints.
 */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/**
 * Standard API list response wrapper.
 */
export interface ListResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

/**
 * Standard API error shape.
 */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Standard API response wrapper for single-item endpoints.
 */
export interface ApiResponse<T> {
  data: T;
  error?: ApiError | null;
}
