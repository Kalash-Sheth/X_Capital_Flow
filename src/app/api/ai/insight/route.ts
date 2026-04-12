// ============================================================
// POST /api/ai/insight
// Generates a structured AI market insight.
// Uses Claude (Anthropic) when ANTHROPIC_API_KEY is set,
// otherwise returns a detailed mock insight.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import {
  detectRegime,
  getMacroData,
  generateOHLCV,
  computeRSI,
  computeMACD,
  computeRelativeStrength,
  computeCompositeScores,
  BASE_PRICES,
} from "../../_lib/mockData";

export const dynamic = "force-dynamic";

interface InsightResponse {
  insight:        string;
  whatHappening:  string;
  whyHappening:   string;
  whatToDo:       string;
  regime:         string;
  confidence:     number;
  generatedBy:    "claude" | "mock";
  timestamp:      string;
}

// ── Build comprehensive market context string ──
function buildMarketContext(): string {
  const macro   = getMacroData();
  const regime  = detectRegime();
  const rs      = computeRelativeStrength();
  const bars    = generateOHLCV("NIFTY50", 60);
  const closes  = bars.map(b => b.close);
  const rsiArr  = computeRSI(closes);
  const rsi     = rsiArr[rsiArr.length - 1] ?? 50;
  const macd    = computeMACD(closes);
  const bars200 = generateOHLCV("NIFTY50", 200);
  const comp    = computeCompositeScores(bars200);

  return `
MARKET SNAPSHOT (${new Date().toISOString().split("T")[0]}):

REGIME: ${regime.type} (confidence: ${(regime.confidence * 100).toFixed(0)}%)
Description: ${regime.description}

KEY ASSET PRICES:
- Nifty 50: ₹${BASE_PRICES.NIFTY50.price.toLocaleString()} (change: -0.45%)
- SENSEX: ₹${BASE_PRICES.SENSEX.price.toLocaleString()}
- Nifty Bank: ₹${BASE_PRICES.NIFTY_BANK.price.toLocaleString()}
- Nifty IT: ₹${BASE_PRICES.NIFTY_IT.price.toLocaleString()} (+0.82%)
- Nifty Pharma: ₹${BASE_PRICES.NIFTY_PHARMA.price.toLocaleString()} (+1.12%)
- Gold (MCX): ₹${BASE_PRICES.GOLD.price.toLocaleString()} (+0.95%)
- Crude Oil: ₹${BASE_PRICES.CRUDE_OIL.price.toLocaleString()} (-1.20%)
- USD/INR: ${BASE_PRICES.USDINR.price}
- US 10Y Yield: ${BASE_PRICES.US10Y.price}%
- US 2Y Yield: ${BASE_PRICES.US2Y.price}%

MACRO:
- FII Flow: ₹${macro.fiiFlow} Cr (${macro.fiiFlow < 0 ? "NET SELL" : "NET BUY"})
- DII Flow: ₹${macro.diiFlow} Cr (${macro.diiFlow > 0 ? "NET BUY" : "NET SELL"})
- India VIX: ${macro.vix}
- India CPI: ${macro.cpi}%
- India 10Y Yield: ${macro.india10y}%

TECHNICAL:
- Nifty RSI (14): ${rsi.toFixed(1)}
- MACD: ${macd.macd.toFixed(1)} | Signal: ${macd.signal.toFixed(1)} | Histogram: ${macd.histogram.toFixed(1)}

RELATIVE STRENGTH:
- Gold/Nifty: ${rs.goldNifty.toFixed(3)} (${rs.goldNifty > 3.8 ? "ELEVATED — risk-off signal" : "Normal"})
- Smallcap/Largecap: ${rs.smallcapLargecap.toFixed(3)}
- Copper/Gold: ${rs.copperGold.toFixed(3)} (${rs.copperGold < 0.95 ? "LOW — growth concerns" : "Normal"})
- Nifty/SPX: ${rs.niftySPX.toFixed(3)}

COMPOSITE SCORES:
- Capital Rotation Score: ${comp.rotationScore}/100
- Risk Pressure Index: ${comp.riskPressure}/100
- Market Health Score: ${comp.healthScore}/100
  `.trim();
}

// ── Mock insight (detailed, realistic) ──
function generateMockInsight(_userContext: string): InsightResponse {
  const regime  = detectRegime();
  const macro   = getMacroData();
  const rs      = computeRelativeStrength();
  const bars    = generateOHLCV("NIFTY50", 60);
  const rsiArr  = computeRSI(bars.map(b => b.close));
  const rsi     = rsiArr[rsiArr.length - 1] ?? 50;

  const whatHappening = `Indian equity markets are exhibiting classic ${regime.type} characteristics. Nifty 50 is trading near ₹${BASE_PRICES.NIFTY50.price.toLocaleString()}, off recent highs, while Gold (MCX) is rising toward ₹${BASE_PRICES.GOLD.price.toLocaleString()}. Foreign Institutional Investors (FIIs) have been net sellers to the tune of ₹${Math.abs(macro.fiiFlow)} crore, while Domestic Institutional Investors (DIIs) are providing partial support with ₹${macro.diiFlow} crore in net purchases. The Nifty RSI at ${rsi.toFixed(1)} suggests momentum is ${rsi > 60 ? "still relatively elevated" : rsi < 40 ? "oversold — a potential bottom-fishing opportunity" : "neutral, awaiting a clear directional catalyst"}. IT and Pharma sectors are outperforming, suggesting defensive and dollar-earning sectors are preferred. The Gold/Nifty ratio at ${rs.goldNifty.toFixed(3)} is ${rs.goldNifty > 3.8 ? "elevated, confirming risk-off rotation" : "stable"}.`;

  const whyHappening = `The ${regime.type} regime is being driven by a confluence of factors: ${regime.drivers.join(", ")}. Globally, US 10Y yields at ${BASE_PRICES.US10Y.price}% with an inverted/flat 2Y-10Y spread (${(BASE_PRICES.US10Y.price - BASE_PRICES.US2Y.price).toFixed(2)}%) is signaling recessionary caution among bond traders. The Copper/Gold ratio of ${rs.copperGold.toFixed(3)} — a barometer of global growth expectations — is ${rs.copperGold < 1.0 ? "below 1.0, signaling that commodity markets are pricing in growth deceleration" : "holding above 1.0, suggesting growth expectations remain intact"}. Domestically, India CPI at ${macro.cpi}% provides the RBI with limited easing room, keeping liquidity conditions tighter than ideal for risk assets. The differential between FII selling and DII buying (net ₹${(macro.diiFlow + macro.fiiFlow).toLocaleString()} Cr) reveals that SIP flows and domestic insurance money are the primary market stabilizer.`;

  const whatToDo = `Given the ${regime.type} regime with ${(regime.confidence * 100).toFixed(0)}% confidence, the recommended tactical playbook is: (1) Reduce equity weight from ~60% toward 38-40% — specifically trimming cyclicals, PSU banks, and rate-sensitive names. (2) Increase Gold allocation to 18-22% via Sovereign Gold Bonds or Gold ETFs — the Gold/Nifty ratio trajectory supports this. (3) Add bond duration via G-Sec or long-duration gilt funds — India 10Y at ${macro.india10y}% offers real yield above CPI. (4) Within equity, rotate toward defensives: Pharma (NIFTY PHARMA up 1.12%), FMCG, and IT (dollar earners insulated from INR weakness). (5) Maintain a 8-10% cash buffer for opportunistic deployment if Nifty corrects to the 22,500-22,800 support zone. (6) Watch for VIX declining below 14 as a signal to add equity aggression.`;

  const insight = `${whatHappening} ${whyHappening.split(".")[0]}. ${whatToDo.split(".")[0]}.`;

  return {
    insight,
    whatHappening,
    whyHappening,
    whatToDo,
    regime:      regime.type,
    confidence:  regime.confidence,
    generatedBy: "mock",
    timestamp:   new Date().toISOString(),
  };
}

// ── Claude-powered insight ──
async function generateClaudeInsight(
  userContext: string,
  marketContext: string,
  apiKey: string
): Promise<InsightResponse> {
  // Dynamically import Anthropic SDK
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client    = new Anthropic({ apiKey });

  const systemPrompt = `You are X-Capital Flow's AI market analyst — an expert in Indian and global financial markets.
You have deep knowledge of: equity markets (Nifty, BSE), commodities (Gold, Crude, Silver, Copper),
fixed income (G-Sec, US Treasuries), FII/DII flows, technical analysis, and macro regime detection.

You always provide:
1. Clear, actionable analysis — not generic platitudes
2. Specific price levels, ratios, and data points
3. India-centric context (RBI policy, CPI, INR, FII flows)
4. Risk-adjusted recommendations
5. A structured JSON response

Respond ONLY with valid JSON matching this exact structure:
{
  "whatHappening": "2-3 sentences describing the current market situation with specific data",
  "whyHappening": "2-3 sentences explaining the macro/technical drivers",
  "whatToDo": "3-5 actionable bullet points as a single string",
  "insight": "1-2 sentence executive summary"
}`;

  const userMessage = `Current market data:\n${marketContext}\n\nUser query: ${userContext || "Provide a comprehensive market insight and portfolio guidance."}`;

  const message = await client.messages.create({
    model:      "claude-opus-4-5",
    max_tokens: 1024,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userMessage }],
  });

  const content  = message.content[0];
  const rawText  = content.type === "text" ? content.text : "{}";

  // Parse JSON from Claude's response
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude did not return valid JSON");

  const parsed   = JSON.parse(jsonMatch[0]) as {
    whatHappening: string;
    whyHappening:  string;
    whatToDo:      string;
    insight:       string;
  };

  const regime = detectRegime();
  return {
    insight:       parsed.insight       ?? "",
    whatHappening: parsed.whatHappening ?? "",
    whyHappening:  parsed.whyHappening  ?? "",
    whatToDo:      parsed.whatToDo      ?? "",
    regime:        regime.type,
    confidence:    regime.confidence,
    generatedBy:   "claude",
    timestamp:     new Date().toISOString(),
  };
}

// Dashboard polls via GET (no body needed)
export async function GET() {
  const insight = generateMockInsight("");
  const regime = detectRegime();
  return NextResponse.json({
    // Dashboard-compatible fields
    title: `${regime.type} Regime — ${regime.type === "Risk-Off" ? "Defensive Positioning Warranted" : regime.type === "Risk-On" ? "Equity Momentum Intact" : "Balanced Approach Recommended"}`,
    happening: insight.whatHappening,
    why: insight.whyHappening,
    action: insight.whatToDo,
    confidence: insight.confidence,
    generatedAt: insight.timestamp,
    tags: [regime.type, "FII Flows", "Gold", "Yield Curve", "VIX"],
    // Extended fields
    whatHappening: insight.whatHappening,
    whyHappening: insight.whyHappening,
    whatToDo: insight.whatToDo,
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { context?: string };
    const userContext  = typeof body?.context === "string" ? body.context.trim() : "";
    const marketContext = buildMarketContext();
    const apiKey       = process.env.ANTHROPIC_API_KEY;

    if (apiKey) {
      try {
        const insight = await generateClaudeInsight(userContext, marketContext, apiKey);
        return NextResponse.json(insight, { status: 200 });
      } catch (claudeError) {
        console.warn("[POST /api/ai/insight] Claude failed, falling back to mock:", claudeError);
        // Fall through to mock
      }
    }

    // Mock fallback
    const insight = generateMockInsight(userContext);
    return NextResponse.json(insight, { status: 200 });
  } catch (error) {
    console.error("[POST /api/ai/insight]", error);
    return NextResponse.json(
      { error: "Failed to generate AI insight" },
      { status: 500 }
    );
  }
}
