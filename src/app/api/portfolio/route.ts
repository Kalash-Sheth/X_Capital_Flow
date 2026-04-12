// GET  /api/portfolio — Real NeonDB data + computed allocations (no Claude)
// POST /api/portfolio — Claude AI analysis on demand only

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeRSI, computeMACD, computeCompositeScores, type OHLCVBar } from "../_lib/mockData";

export const dynamic = "force-dynamic";

type RegimeType = "Risk-On" | "Risk-Off" | "Neutral" | "Transitioning";

interface AllocationTarget {
  equity:        number;
  gold:          number;
  bonds:         number;
  cash:          number;
  international: number;
}

const REGIME_ALLOCATIONS: Record<string, AllocationTarget> = {
  "Risk-On":      { equity: 65, gold: 8,  bonds: 15, cash: 5,  international: 7 },
  "Risk-Off":     { equity: 38, gold: 22, bonds: 28, cash: 8,  international: 4 },
  "Neutral":      { equity: 55, gold: 12, bonds: 20, cash: 8,  international: 5 },
  "Transitioning":{ equity: 48, gold: 16, bonds: 22, cash: 9,  international: 5 },
};

const CURRENT_ALLOCATIONS: AllocationTarget = {
  equity: 60, gold: 5, bonds: 20, cash: 10, international: 5,
};

const ASSET_META = [
  { key: "equity",        symbol: "NIFTY50", label: "Equity (Nifty)",  assetClass: "EQUITY" },
  { key: "gold",          symbol: "GOLD",    label: "Gold",            assetClass: "COMMODITY" },
  { key: "bonds",         symbol: "US10Y",   label: "Bonds (G-Sec)",   assetClass: "FIXED_INCOME" },
  { key: "cash",          symbol: "CASH",    label: "Cash / Liquid",   assetClass: "CASH" },
  { key: "international", symbol: "SPX",     label: "International",   assetClass: "EQUITY" },
] as const;

// ─── NeonDB batch fetch ───────────────────────────────────────────────────────
async function fetchBarsMap(tickers: string[], days: number): Promise<Record<string, OHLCVBar[]>> {
  const assets = await prisma.asset.findMany({
    where: { ticker: { in: tickers } },
    include: {
      priceData: { orderBy: { timestamp: "asc" }, take: days },
    },
  });
  const result: Record<string, OHLCVBar[]> = {};
  for (const a of assets) {
    result[a.ticker] = a.priceData.map((r) => ({
      date:   r.timestamp.toISOString().slice(0, 10),
      open:   r.open,
      high:   r.high,
      low:    r.low,
      close:  r.close,
      volume: r.volume ?? 0,
    }));
  }
  return result;
}

// ─── Math helpers ─────────────────────────────────────────────────────────────
function realizedVol(closes: number[], window = 20): number {
  if (closes.length < window + 1) return 15;
  const slice    = closes.slice(-window - 1);
  const returns  = slice.slice(1).map((c, i) => Math.log(c / slice[i]));
  const mean     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return parseFloat((Math.sqrt(variance * 252) * 100).toFixed(2));
}

function ret20d(closes: number[]): number {
  if (closes.length < 21) return 0;
  return parseFloat(((closes.at(-1)! / closes.at(-21)! - 1) * 100).toFixed(2));
}

function detectRegime(
  niftyRSI: number, yieldSpread: number, vixProxy: number,
  goldMom: number,  niftyMom: number
): { type: RegimeType; confidence: number } {
  let riskOff = 0;
  if (niftyRSI < 45)   riskOff += 2;
  if (yieldSpread < 0) riskOff += 3;
  if (vixProxy > 20)   riskOff += 2;
  if (goldMom > 3)     riskOff += 2;
  if (niftyMom < -3)   riskOff += 2;
  const type: RegimeType =
    riskOff >= 6 ? "Risk-Off" : riskOff >= 3 ? "Transitioning" : "Risk-On";
  return {
    type,
    confidence: parseFloat(Math.min(0.95, 0.4 + riskOff * 0.05).toFixed(2)),
  };
}

// ─── Shared: build market snapshot from NeonDB ────────────────────────────────
async function buildMarketSnapshot() {
  const TICKERS = ["NIFTY50", "GOLD", "US10Y", "US2Y", "USDINR", "SPX", "SENSEX"];
  const barsMap = await fetchBarsMap(TICKERS, 90);

  const closes = (t: string) => (barsMap[t] ?? []).map((b) => b.close);

  const niftyCloses  = closes("NIFTY50");
  const goldCloses   = closes("GOLD");
  const spxCloses    = closes("SPX");
  const usdinrCloses = closes("USDINR");

  const niftyRSIArr  = computeRSI(niftyCloses);
  const niftyRSI     = niftyRSIArr.at(-1) ?? 50;
  const niftyMom     = ret20d(niftyCloses);
  const goldMom      = ret20d(goldCloses);
  const spxMom       = ret20d(spxCloses);
  const vixProxy     = realizedVol(niftyCloses, 20);
  const yield10y     = closes("US10Y").at(-1) ?? 4.5;
  const yield2y      = closes("US2Y").at(-1)  ?? 4.0;
  const yieldSpread  = parseFloat((yield10y - yield2y).toFixed(4));

  const usdinrLatest = usdinrCloses.at(-1)  ?? 84.5;
  const usdinrPrev   = usdinrCloses.at(-2)  ?? usdinrLatest;
  const usdinrChgPct = parseFloat(((usdinrLatest - usdinrPrev) / usdinrPrev * 100).toFixed(3));

  const niftyLatest  = niftyCloses.at(-1) ?? 0;
  const goldLatest   = goldCloses.at(-1)  ?? 0;
  const spxLatest    = spxCloses.at(-1)   ?? 0;

  const niftyMACD    = computeMACD(niftyCloses);
  const niftyBars    = barsMap["NIFTY50"] ?? [];
  const comp         = computeCompositeScores(niftyBars.length >= 5 ? niftyBars : niftyBars);

  const goldNiftyRatio = niftyLatest > 0
    ? parseFloat((goldLatest / niftyLatest).toFixed(4))
    : 0;

  const CPI_ESTIMATE = 4.2;
  const realYield    = parseFloat((yield10y - CPI_ESTIMATE).toFixed(2));

  const regime = detectRegime(niftyRSI, yieldSpread, vixProxy, goldMom, niftyMom);

  const targets = REGIME_ALLOCATIONS[regime.type] ?? REGIME_ALLOCATIONS["Neutral"];
  const current = CURRENT_ALLOCATIONS;

  const rawAllocations = ASSET_META.map((meta) => {
    const key    = meta.key as keyof AllocationTarget;
    const curr   = current[key];
    const sugg   = targets[key];
    const change = sugg - curr;
    return { ...meta, current: curr, suggested: sugg, change };
  });

  const marketContextStr = `MARKET SNAPSHOT — ${new Date().toISOString().split("T")[0]} (Live NeonDB Data)

REGIME: ${regime.type} (Confidence: ${(regime.confidence * 100).toFixed(0)}%)

KEY ASSET PRICES:
- Nifty 50:   ₹${niftyLatest.toFixed(0)}  | 20D Return: ${niftyMom > 0 ? "+" : ""}${niftyMom}%
- Gold (USD): $${goldLatest.toFixed(2)}   | 20D Return: ${goldMom > 0 ? "+" : ""}${goldMom}%
- S&P 500:    ${spxLatest.toFixed(0)}     | 20D Return: ${spxMom > 0 ? "+" : ""}${spxMom}%
- USD/INR:    ${usdinrLatest.toFixed(2)}  | Daily Chg:  ${usdinrChgPct > 0 ? "+" : ""}${usdinrChgPct}% (${usdinrChgPct > 0 ? "INR weakening → FII outflow pressure" : "INR strengthening → FII inflow signal"})

FIXED INCOME & MACRO:
- US 10Y Yield:  ${yield10y}%
- US 2Y Yield:   ${yield2y}%
- Yield Spread:  ${yieldSpread > 0 ? "+" : ""}${yieldSpread}% → ${yieldSpread < 0 ? "INVERTED (recession signal)" : yieldSpread < 0.3 ? "Near-flat (caution)" : "Normal"}
- Real Yield:    ${realYield}% (10Y minus CPI est. ${CPI_ESTIMATE}%)
- India CPI est: ${CPI_ESTIMATE}%

NIFTY TECHNICAL INDICATORS:
- RSI (14):  ${niftyRSI.toFixed(1)} → ${niftyRSI > 70 ? "Overbought — mean reversion risk" : niftyRSI < 30 ? "Oversold — recovery potential" : niftyRSI < 45 ? "Weakening momentum" : "Neutral-to-Bullish"}
- MACD:      ${niftyMACD.macd.toFixed(2)} | Signal: ${niftyMACD.signal.toFixed(2)} | Histogram: ${niftyMACD.histogram.toFixed(2)} → ${niftyMACD.histogram > 0 ? "Bullish momentum" : "Bearish momentum"}
- Realized Vol (20D annualized): ${vixProxy}% → ${vixProxy > 25 ? "High — risk-off conditions" : vixProxy > 18 ? "Elevated — caution warranted" : "Calm — risk-on favored"}

RELATIVE STRENGTH:
- Gold/Nifty Ratio: ${goldNiftyRatio} → ${goldNiftyRatio > 4 ? "Elevated — risk-off rotation active" : "Within normal range"}
- Nifty vs Gold 20D momentum spread: ${parseFloat((niftyMom - goldMom).toFixed(2))}%

COMPOSITE SCORES:
- Capital Rotation Score: ${comp.rotationScore}/100
- Risk Pressure Index:    ${comp.riskPressure}/100
- Market Health Score:    ${comp.healthScore}/100`;

  const allocationContextStr = `CURRENT vs REGIME-OPTIMAL ALLOCATIONS (${regime.type} regime):
${rawAllocations.map((a) => `- ${a.label}: Current ${a.current}% → Suggested ${a.suggested}% (${a.change > 0 ? "+" : ""}${a.change}%)`).join("\n")}

Based on the above live market data and the ${regime.type} regime with ${(regime.confidence * 100).toFixed(0)}% confidence, provide detailed rationale for each allocation adjustment and a comprehensive portfolio strategy insight.`;

  return {
    regime,
    rawAllocations,
    comp,
    indicators: {
      niftyRSI:      parseFloat(niftyRSI.toFixed(1)),
      niftyMom,
      goldMom,
      yieldSpread,
      vixProxy,
      usdinrChgPct,
      realYield,
      goldNiftyRatio,
      macdHistogram: parseFloat(niftyMACD.histogram.toFixed(2)),
    },
    marketContextStr,
    allocationContextStr,
  };
}

type RawAllocation = {
  key: string; symbol: string; label: string; assetClass: string;
  current: number; suggested: number; change: number;
};

// ─── Build allocations without AI (computed fallback rationale) ───────────────
function buildAllocations(rawAllocations: RawAllocation[], regime: string) {
  return rawAllocations.map((a) => {
    const fallback =
      a.change > 5
        ? `${regime} regime targets ${a.suggested}% for ${a.label}. Current ${a.current}% is ${Math.abs(a.change)}% below the regime-optimal weight.`
        : a.change < -5
        ? `${regime} conditions call for trimming ${a.label} from ${a.current}% to ${a.suggested}%. Position is ${Math.abs(a.change)}% above the regime-optimal weight.`
        : `${a.label} at ${a.current}% is broadly aligned with ${regime} regime targets. Minor ${Math.abs(a.change)}% tactical adjustment.`;
    return {
      asset:      a.label,
      symbol:     a.symbol,
      assetClass: a.assetClass,
      current:    a.current,
      suggested:  a.suggested,
      change:     a.change,
      rationale:  fallback,
      priority:   (Math.abs(a.change) >= 10 ? "HIGH" : Math.abs(a.change) >= 5 ? "MEDIUM" : "LOW") as "HIGH" | "MEDIUM" | "LOW",
    };
  });
}

function buildActions(allocations: ReturnType<typeof buildAllocations>) {
  return allocations
    .filter((a) => Math.abs(a.change) >= 2)
    .map((a, i) => ({
      id:        String(i + 1),
      type:      (a.change > 0 ? "INCREASE" : "REDUCE") as "INCREASE" | "REDUCE",
      asset:     a.asset,
      fromPct:   a.current,
      toPct:     a.suggested,
      priority:  a.priority,
      rationale: a.rationale,
    }))
    .sort((x, y) => {
      const ord: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return (ord[x.priority] ?? 2) - (ord[y.priority] ?? 2);
    });
}

// ─── GET: market data + computed allocations — NO Claude ─────────────────────
export async function GET() {
  try {
    const snap = await buildMarketSnapshot();
    const { regime, rawAllocations, comp, indicators } = snap;

    const allocations = buildAllocations(rawAllocations, regime.type);
    const actions     = buildActions(allocations);

    const maxDev           = Math.max(...allocations.map((a) => Math.abs(a.change)));
    const rebalancingAlert = maxDev >= 8;
    const alertMsgs = allocations
      .filter((a) => Math.abs(a.change) >= 10)
      .map((a) => `${a.asset} ${a.change > 0 ? "underweight" : "overweight"} by ${Math.abs(a.change)}%`);

    return NextResponse.json({
      regime:           regime.type,
      regimeConfidence: regime.confidence,
      allocations,
      actions,
      compositeContext: {
        capitalRotationScore: comp.rotationScore,
        riskPressureIndex:    comp.riskPressure,
        marketHealthScore:    comp.healthScore,
      },
      // AI fields are null — frontend shows "Run Analysis" prompt
      portfolioInsight: null,
      preferredAssets:  null,
      avoidAssets:      null,
      keyRisks:         null,
      generatedBy:      "computed" as const,
      rebalancingAlert,
      alertMessage: rebalancingAlert
        ? alertMsgs.join("; ") || `Portfolio mis-aligned with ${regime.type} regime by up to ${maxDev}%`
        : "Portfolio within acceptable deviation bands",
      confidence:  regime.confidence,
      timestamp:   new Date().toISOString(),
      indicators,
    });
  } catch (error) {
    console.error("[GET /api/portfolio]", error);
    return NextResponse.json({ error: "Failed to compute portfolio allocation" }, { status: 500 });
  }
}

// ─── POST: Claude AI analysis — called only on button click ──────────────────
export async function POST() {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const snap = await buildMarketSnapshot();
    const { regime, rawAllocations, marketContextStr, allocationContextStr } = snap;

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client    = new Anthropic({ apiKey });

    const systemPrompt = `You are X-Capital Flow's AI portfolio strategist — an expert in Indian and global financial markets with deep knowledge of Nifty, BSE, G-Sec, FII/DII flows, RBI policy, and macro regime analysis.

Your analysis must be:
1. Data-driven — cite specific numbers from the market context provided
2. India-centric — reference INR, RBI policy, FII flow signals explicitly
3. Regime-aware — every recommendation must align with the detected regime
4. Risk-adjusted — quantify risk and reward with specific rationale
5. Concise and actionable — each rationale is 2-3 sentences maximum

IMPORTANT: For each asset, provide your own AI-suggested allocation percentage (suggestedPct). These should differ from the rule-based targets based on your nuanced analysis. All suggestedPct values must sum to exactly 100.

Respond ONLY with valid JSON (no markdown, no code fences, no text outside the JSON):
{
  "allocations": {
    "Equity (Nifty)": { "suggestedPct": <integer 0-100>, "rationale": "2-3 sentences citing RSI/momentum/regime/FII data", "priority": "HIGH|MEDIUM|LOW" },
    "Gold":           { "suggestedPct": <integer 0-100>, "rationale": "...", "priority": "HIGH|MEDIUM|LOW" },
    "Bonds (G-Sec)":  { "suggestedPct": <integer 0-100>, "rationale": "...", "priority": "HIGH|MEDIUM|LOW" },
    "Cash / Liquid":  { "suggestedPct": <integer 0-100>, "rationale": "...", "priority": "HIGH|MEDIUM|LOW" },
    "International":  { "suggestedPct": <integer 0-100>, "rationale": "...", "priority": "HIGH|MEDIUM|LOW" }
  },
  "portfolioInsight": "3-4 sentence executive summary with specific data points",
  "preferredAssets": ["up to 5 preferred assets/sectors with brief inline reason"],
  "avoidAssets": ["3-4 assets/sectors to avoid with inline reason"],
  "keyRisks": ["3 specific risk factors with data-backed context"]
}`;

    const message = await client.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 2048,
      system:     systemPrompt,
      messages:   [{ role: "user", content: `${marketContextStr}\n\n${allocationContextStr}` }],
    });

    const rawText   = message.content[0].type === "text" ? message.content[0].text : "{}";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Claude returned no valid JSON");

    const ai = JSON.parse(jsonMatch[0]) as {
      allocations:      Record<string, { suggestedPct?: number; rationale: string; priority: "HIGH" | "MEDIUM" | "LOW" }>;
      portfolioInsight: string;
      preferredAssets:  string[];
      avoidAssets:      string[];
      keyRisks:         string[];
    };

    // Merge AI rationale + AI-suggested percentages into allocations
    const enrichedAllocations = rawAllocations.map((a) => {
      const aiEntry  = ai.allocations?.[a.label];
      // Use Claude's suggested %, fallback to rule-based if missing/invalid
      const aiSugg   = typeof aiEntry?.suggestedPct === "number" && aiEntry.suggestedPct >= 0
        ? aiEntry.suggestedPct
        : a.suggested;
      const change   = aiSugg - a.current;
      return {
        asset:      a.label,
        symbol:     a.symbol,
        assetClass: a.assetClass,
        current:    a.current,
        suggested:  aiSugg,
        change,
        rationale:  aiEntry?.rationale ?? `${regime.type} regime: ${change > 0 ? "increase" : change < 0 ? "reduce" : "maintain"} ${a.label} allocation.`,
        priority:   (aiEntry?.priority ?? (Math.abs(change) >= 10 ? "HIGH" : Math.abs(change) >= 5 ? "MEDIUM" : "LOW")) as "HIGH" | "MEDIUM" | "LOW",
      };
    });

    const enrichedActions = buildActions(enrichedAllocations);

    return NextResponse.json({
      allocations:      enrichedAllocations,
      actions:          enrichedActions,
      portfolioInsight: ai.portfolioInsight,
      preferredAssets:  ai.preferredAssets,
      avoidAssets:      ai.avoidAssets,
      keyRisks:         ai.keyRisks,
      generatedBy:      "claude" as const,
      generatedAt:      new Date().toISOString(),
    });
  } catch (error) {
    console.error("[POST /api/portfolio]", error);
    return NextResponse.json({ error: "Claude analysis failed" }, { status: 500 });
  }
}
