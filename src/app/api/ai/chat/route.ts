// ============================================================
// POST /api/ai/chat
// Copilot chat endpoint — context-aware financial Q&A.
// Uses Claude when ANTHROPIC_API_KEY is set,
// otherwise returns smart mock responses.
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

interface ChatMessage {
  role:    "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
  context?: Record<string, unknown>;
}

interface ChatResponse {
  reply:       string;
  generatedBy: "claude" | "mock";
  timestamp:   string;
}

// ── Gather current context once per request ──
function buildFullContext() {
  const macro  = getMacroData();
  const regime = detectRegime();
  const rs     = computeRelativeStrength();
  const bars   = generateOHLCV("NIFTY50", 60);
  const closes = bars.map(b => b.close);
  const rsiArr = computeRSI(closes);
  const rsi    = rsiArr[rsiArr.length - 1] ?? 50;
  const macd   = computeMACD(closes);
  const comp   = computeCompositeScores(generateOHLCV("NIFTY50", 200));
  const yield10y = BASE_PRICES.US10Y.price;
  const yield2y  = BASE_PRICES.US2Y.price;

  return { macro, regime, rs, rsi, macd, comp, yield10y, yield2y };
}

// ── Keyword-driven mock responses ──
function generateMockResponse(
  latestUserMessage: string,
  ctx: ReturnType<typeof buildFullContext>
): string {
  const q = latestUserMessage.toLowerCase();

  // Regime / market overview
  if (q.match(/regime|market mode|market condition|overview|summary|what.*market/)) {
    return `Current market regime is **${ctx.regime.type}** (${(ctx.regime.confidence * 100).toFixed(0)}% confidence). ${ctx.regime.description}

Key drivers: ${ctx.regime.drivers.join(", ")}.

**Composite Scores:**
- Capital Rotation: ${ctx.comp.rotationScore}/100
- Risk Pressure: ${ctx.comp.riskPressure}/100
- Market Health: ${ctx.comp.healthScore}/100

In a ${ctx.regime.type} environment, consider reducing equity exposure and increasing defensive allocations (Gold, Bonds, Cash).`;
  }

  // FII/DII flows
  if (q.match(/fii|dii|foreign|domestic|flow|institutional/)) {
    return `**FII/DII Flow Update:**

- **FII (Foreign Institutional Investors):** ₹${ctx.macro.fiiFlow} Cr — ${ctx.macro.fiiFlow < 0 ? "NET SELLERS. Foreign funds are reducing India equity exposure, likely due to global risk-off sentiment and dollar strength (DXY at " + BASE_PRICES.DXY.price + ")." : "NET BUYERS. Foreign institutional confidence in India markets is positive."}

- **DII (Domestic Institutional Investors):** ₹${ctx.macro.diiFlow} Cr — ${ctx.macro.diiFlow > 0 ? "NET BUYERS. Mutual fund SIP flows and insurance companies are absorbing FII selling, providing price support." : "NET SELLERS."}

- **Net market impact:** ₹${ctx.macro.fiiFlow + ctx.macro.diiFlow} Cr combined flow.

${ctx.macro.fiiFlow < 0 && ctx.macro.diiFlow > 0 ? "The DII cushion is partially offsetting FII pressure — watch for convergence as a buy signal." : ""}`;
  }

  // Gold analysis
  if (q.match(/gold|safe.?haven|precious/)) {
    return `**Gold Analysis:**

Gold (MCX) is trading at ₹${BASE_PRICES.GOLD.price.toLocaleString()}, up 0.95% today.

**Gold/Nifty Ratio:** ${ctx.rs.goldNifty.toFixed(3)} — ${ctx.rs.goldNifty > 3.8 ? "ELEVATED. Rising ratio confirms risk-off capital rotation from equity to gold." : "Stable. No extreme positioning."}

**Why Gold is Rising:**
1. VIX at ${ctx.macro.vix} — elevated fear premium supports safe-haven demand
2. FII selling equities (₹${Math.abs(ctx.macro.fiiFlow)} Cr) — capital seeking refuge in gold
3. Crude Oil weakness signals global growth concerns, not inflation — gold benefits
4. US Real Yield at ${(ctx.yield10y - ctx.macro.cpi).toFixed(2)}% — ${ctx.yield10y - ctx.macro.cpi < 1 ? "low real yields support gold (opportunity cost of holding gold is low)" : "higher real yields are a headwind for gold"}

**Target & Strategy:** Sovereign Gold Bonds (SGB) or Gold ETFs recommended. 18-22% allocation suitable in current ${ctx.regime.type} regime.`;
  }

  // Nifty / equity analysis
  if (q.match(/nifty|equity|stock|share|sensex|index/)) {
    return `**Nifty 50 Technical Analysis:**

- **Price:** ₹${BASE_PRICES.NIFTY50.price.toLocaleString()} (-0.45%)
- **RSI (14):** ${ctx.rsi.toFixed(1)} — ${ctx.rsi > 70 ? "Overbought — caution" : ctx.rsi < 30 ? "Oversold — potential bounce" : "Neutral zone"}
- **MACD:** ${ctx.macd.macd.toFixed(1)} | Signal: ${ctx.macd.signal.toFixed(1)} | Histogram: ${ctx.macd.histogram.toFixed(1)} (${ctx.macd.histogram > 0 ? "Bullish momentum" : "Bearish momentum"})

**Sector Rotation:**
- Outperforming: IT (+0.82%), Pharma (+1.12%) — defensive and dollar-earning sectors
- Underperforming: Bank (-0.68%), Smallcap (-0.91%)

**Key Levels:**
- Support: ~22,500-22,800 (50-day SMA zone)
- Resistance: ~24,800-25,000 (recent highs)

In the current ${ctx.regime.type} regime with FII selling, the bias is cautiously negative. Wait for VIX to drop below 15 before adding equity aggressively.`;
  }

  // VIX
  if (q.match(/vix|volatil|fear|fear index/)) {
    return `**India VIX Analysis:**

Current VIX: **${ctx.macro.vix}** (${ctx.macro.vix > 20 ? "HIGH — elevated fear" : ctx.macro.vix > 16 ? "MODERATE — caution warranted" : ctx.macro.vix < 13 ? "LOW — possible complacency" : "Normal range"})

**Interpretation:**
- VIX > 20: Panic or crisis mode — options are expensive, consider selling premium strategies
- VIX 15-20: Elevated caution — reduce position sizes, tighten stops
- VIX 12-15: Normal — trend-following works well
- VIX < 12: Complacency — consider buying protection (puts, inverse ETFs)

**Current Reading (${ctx.macro.vix}):** ${ctx.macro.vix > 16 ? "Elevated volatility is compressing equity valuations. This environment favors defensive allocation and hedged strategies. VIX spikes above 22 have historically been good entry points for long-term investors." : "Calm market environment — momentum strategies and trend-following are favored."}`;
  }

  // Yield curve / bonds / rates
  if (q.match(/yield|bond|rate|rbi|fed|interest|g.?sec|10y|2y/)) {
    const spread = ctx.yield10y - ctx.yield2y;
    return `**Yield Curve & Bond Market Analysis:**

- **US 10Y:** ${ctx.yield10y}%
- **US 2Y:** ${ctx.yield2y}%
- **Spread (10Y-2Y):** ${spread.toFixed(2)}% — ${spread < 0 ? "INVERTED ⚠️ — historically precedes recession within 12-18 months" : spread < 0.3 ? "FLAT — uncertainty about growth" : "Normal positive slope"}
- **India 10Y:** ${ctx.macro.india10y}%
- **India CPI:** ${ctx.macro.cpi}%
- **India Real Yield:** ${(ctx.macro.india10y - ctx.macro.cpi).toFixed(2)}%

**RBI Outlook:** With CPI at ${ctx.macro.cpi}%, the RBI has ${ctx.macro.cpi < 4.5 ? "room to cut rates — positive for bond prices and equity multiples" : "limited room for easing — rates likely on hold"}. Long-duration G-Sec funds could benefit from a rate cut cycle.

**Strategy:** ${spread < 0 ? "Inverted curve signals to reduce equity duration risk. Prefer short-duration bonds (1-3Y) and AAA corporate bonds over equity." : "Maintain moderate bond allocation as portfolio ballast. India G-Sec offers attractive real yields."}`;
  }

  // Rotation / capital flows
  if (q.match(/rotation|flow|capital|sector|which sector|where.*money/)) {
    return `**Capital Rotation Analysis:**

**Active Rotations (Confidence):**
1. **Equity → Gold** (${ctx.rs.goldNifty > 3.8 ? "~68%" : "~35%"}) — ${ctx.rs.goldNifty > 3.8 ? "Strong risk-off signal. FII outflows and elevated VIX confirming this." : "Moderate signal building."}
2. **Equity → Bonds** (~45%) — Duration play as rate cut expectations build
3. **Cyclicals → Defensives** (~55%) — Pharma, FMCG outperforming Bank, Auto

**Sector Preference in ${ctx.regime.type}:**
- OVERWEIGHT: Pharma, FMCG, IT (defensive/dollar earners), Gold
- NEUTRAL: Private Banks, NBFCs
- UNDERWEIGHT: PSU Banks, Real Estate, Auto, Metals

**Capital Rotation Score: ${ctx.comp.rotationScore}/100** — ${ctx.comp.rotationScore > 60 ? "High rotation activity — repositioning in progress" : ctx.comp.rotationScore > 40 ? "Moderate rotation" : "Stable allocation environment"}`;
  }

  // Portfolio advice
  if (q.match(/portfolio|allocat|invest|suggest|recommend|what.*buy|should.*buy|how.*invest/)) {
    return `**Portfolio Allocation Suggestion — ${ctx.regime.type} Regime:**

| Asset Class          | Current | Suggested | Change |
|---------------------|---------|-----------|--------|
| Equity (Nifty)      |   60%   |    38%    |  -22%  |
| Gold (SGB/ETF)      |    5%   |    22%    |  +17%  |
| Bonds (G-Sec)       |   20%   |    28%    |   +8%  |
| Cash                |   10%   |     8%    |   -2%  |
| International       |    5%   |     4%    |   -1%  |

**Rebalancing Priority:**
1. Trim equity, especially cyclical/PSU names
2. Build gold position via SGB (tax-efficient) or Gold ETF
3. Allocate to long-duration G-Sec for rate cut play
4. Maintain cash buffer for opportunistic re-entry below Nifty 22,800

**Confidence:** ${(ctx.regime.confidence * 100).toFixed(0)}% | Risk Pressure: ${ctx.comp.riskPressure}/100 | Health: ${ctx.comp.healthScore}/100`;
  }

  // Crude oil
  if (q.match(/crude|oil|petroleum|energy|brent/)) {
    return `**Crude Oil Analysis:**

Crude Oil (MCX) at ₹${BASE_PRICES.CRUDE_OIL.price.toLocaleString()} (-1.20% today).

**India Macro Impact:**
- Crude at ~$75/bbl (approximate international) is **positive** for India — lower import bill reduces Current Account Deficit (CAD)
- Every $10 fall in crude reduces India's import bill by ~$15-20 Bn annually
- INR benefits from lower crude (USD/INR at ${BASE_PRICES.USDINR.price})
- RBI gets more comfort to ease policy with crude-driven inflation relief

**Copper/Gold Ratio (growth proxy):** ${ctx.rs.copperGold.toFixed(3)} — ${ctx.rs.copperGold < 1.0 ? "Below 1.0 — global growth concerns align with crude weakness. Not a pure supply story." : "Above 1.0 — growth expectations intact."}

**Sectors to Watch:** OMCs (HPCL, BPCL) benefit from falling crude. Aviation (IndiGo) benefits. Upstream E&P and Oil Service companies face headwinds.`;
  }

  // INR / currency
  if (q.match(/inr|rupee|currency|usd|dollar|fx|forex|dxy/)) {
    return `**INR / Currency Analysis:**

- **USD/INR:** ${BASE_PRICES.USDINR.price} (USD strengthening modestly)
- **DXY (Dollar Index):** ${BASE_PRICES.DXY.price} (+0.15%)

**INR Drivers:**
1. **FII outflows** (₹${Math.abs(ctx.macro.fiiFlow)} Cr) — pressuring INR as FIIs repatriate capital
2. **Crude Oil** — falling crude is supportive of INR (lower oil import payments)
3. **RBI intervention** — RBI typically defends 84.50-85.50 range via forward sales
4. **DXY strength** — when DXY rises, EM currencies including INR face depreciation pressure

**INR Outlook:** USD/INR likely to trade 84.20-85.20 range near-term. A break above 85.50 would signal increased RBI FX reserves depletion and could trigger hawkish RBI stance.

**IT Sector Benefit:** INR weakness is positive for Nifty IT (TCS, Infosys, Wipro) as ~60-70% of revenues are USD-denominated.`;
  }

  // Default comprehensive response
  return `**X-Capital Flow Market Intelligence:**

**Current Regime: ${ctx.regime.type}** (${(ctx.regime.confidence * 100).toFixed(0)}% confidence)

Here's the key market snapshot as of today:

**Prices:**
- Nifty 50: ₹${BASE_PRICES.NIFTY50.price.toLocaleString()} (-0.45%)
- Gold (MCX): ₹${BASE_PRICES.GOLD.price.toLocaleString()} (+0.95%)
- USD/INR: ${BASE_PRICES.USDINR.price}

**Technicals (Nifty):**
- RSI: ${ctx.rsi.toFixed(1)} | MACD: ${ctx.macd.histogram > 0 ? "Bullish" : "Bearish"}

**Flows:**
- FII: ₹${ctx.macro.fiiFlow} Cr | DII: ₹${ctx.macro.diiFlow} Cr
- VIX: ${ctx.macro.vix}

**Composite Scores:**
- Rotation Score: ${ctx.comp.rotationScore}/100
- Risk Pressure: ${ctx.comp.riskPressure}/100
- Health Score: ${ctx.comp.healthScore}/100

You can ask me about: **regime analysis, FII/DII flows, gold, Nifty technicals, yield curve, sector rotation, portfolio allocation, crude oil, or INR**.`;
}

// ── Claude-powered chat ──
async function generateClaudeChat(
  messages: ChatMessage[],
  marketContext: string,
  userContext: Record<string, unknown>,
  apiKey: string
): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client    = new Anthropic({ apiKey });

  const systemPrompt = `You are X-Capital Flow's AI copilot — an expert financial analyst for Indian and global markets.
You have real-time access to the following market data:

${marketContext}

Guidelines:
- Be specific and data-driven — quote exact prices, ratios, and indicators from the data above
- Focus on India-centric analysis but include global context
- Keep responses concise (150-250 words) but actionable
- Use markdown formatting for tables, bold for key metrics
- Never give personalized financial advice — provide market analysis only
- If asked about something outside markets, politely redirect to market topics`;

  const claudeMessages = messages.map(m => ({
    role:    m.role as "user" | "assistant",
    content: m.content,
  }));

  const response = await client.messages.create({
    model:      "claude-opus-4-5",
    max_tokens: 512,
    system:     systemPrompt,
    messages:   claudeMessages,
  });

  const content = response.content[0];
  return content.type === "text" ? content.text : "I was unable to generate a response. Please try again.";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as Partial<ChatRequestBody>;

    // Validate messages array
    const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return NextResponse.json(
        { error: "messages array is required and must not be empty" },
        { status: 400 }
      );
    }

    const userContext = (body?.context ?? {}) as Record<string, unknown>;

    // Build market context
    const ctx           = buildFullContext();
    const marketContext = `
REGIME: ${ctx.regime.type} (${(ctx.regime.confidence * 100).toFixed(0)}% confidence) — ${ctx.regime.description}
Nifty 50: ₹${BASE_PRICES.NIFTY50.price.toLocaleString()} | Gold: ₹${BASE_PRICES.GOLD.price.toLocaleString()} | USD/INR: ${BASE_PRICES.USDINR.price}
FII Flow: ₹${ctx.macro.fiiFlow} Cr | DII: ₹${ctx.macro.diiFlow} Cr | VIX: ${ctx.macro.vix}
Nifty RSI: ${ctx.rsi.toFixed(1)} | MACD Histogram: ${ctx.macd.histogram.toFixed(1)}
Gold/Nifty: ${ctx.rs.goldNifty.toFixed(3)} | Smallcap/Largecap: ${ctx.rs.smallcapLargecap.toFixed(3)} | Copper/Gold: ${ctx.rs.copperGold.toFixed(3)}
Rotation Score: ${ctx.comp.rotationScore}/100 | Risk Pressure: ${ctx.comp.riskPressure}/100 | Health: ${ctx.comp.healthScore}/100
US 10Y: ${ctx.yield10y}% | US 2Y: ${ctx.yield2y}% | India 10Y: ${ctx.macro.india10y}% | CPI: ${ctx.macro.cpi}%
    `.trim();

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const lastUserMsg = messages.findLast(m => m.role === "user")?.content ?? "";

    if (apiKey) {
      try {
        const reply = await generateClaudeChat(messages, marketContext, userContext, apiKey);
        return NextResponse.json(
          { reply, generatedBy: "claude", timestamp: new Date().toISOString() } satisfies ChatResponse,
          { status: 200 }
        );
      } catch (claudeError) {
        console.warn("[POST /api/ai/chat] Claude failed, falling back to mock:", claudeError);
        // Fall through to mock
      }
    }

    // Mock fallback
    const reply = generateMockResponse(lastUserMsg, ctx);
    return NextResponse.json(
      { reply, generatedBy: "mock", timestamp: new Date().toISOString() } satisfies ChatResponse,
      { status: 200 }
    );
  } catch (error) {
    console.error("[POST /api/ai/chat]", error);
    return NextResponse.json(
      { error: "Failed to generate chat response" },
      { status: 500 }
    );
  }
}
