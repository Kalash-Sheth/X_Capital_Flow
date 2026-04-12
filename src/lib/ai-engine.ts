// ============================================================
// ai-engine.ts — Anthropic Claude integration for market insights
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import type { RotationResult, MarketRegime, AllocationResult } from './rotation-engine';
import type { ComputedIndicators } from './rotation-engine';
import type { ForecastResult } from './prediction-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AIInsightResponse {
  summary: string;           // 2-3 sentence executive summary
  whatIsHappening: string;   // current market state description
  whyRotating: string;       // capital flow reasoning
  whatToDo: string;          // actionable investor guidance
  keyRisks: string[];        // top 3 risks
  opportunities: string[];   // top 3 opportunities
  rawText: string;           // full model response
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MarketContext {
  regime: MarketRegime;
  rotations: RotationResult[];
  allocation?: AllocationResult;
  forecasts?: ForecastResult[];
  macro: {
    vix: number;
    fiiFlow: number;
    diiFlow: number;
    cpi: number;
    india10y: number;
    us10y: number;
    us2y: number;
    usdinr: number;
  };
  priceSnapshot: Record<string, number>;   // symbol → last close
}

// ---------------------------------------------------------------------------
// Anthropic client singleton
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildMarketContextBlock(ctx: MarketContext): string {
  const { regime, rotations, macro, priceSnapshot, forecasts } = ctx;

  const yieldSpread = (macro.us10y - macro.us2y).toFixed(2);
  const yieldCurveStatus =
    parseFloat(yieldSpread) < 0
      ? 'INVERTED'
      : parseFloat(yieldSpread) < 0.25
      ? 'FLAT'
      : 'NORMAL';

  const rotationSummary = rotations
    .slice(0, 4)
    .map(
      (r) =>
        `  - ${r.from} → ${r.to}: confidence ${(r.confidence * 100).toFixed(0)}%, ${r.strength} signal`
    )
    .join('\n');

  const priceSummary = Object.entries(priceSnapshot)
    .map(([sym, price]) => `  ${sym}: ${price.toLocaleString()}`)
    .join('\n');

  const forecastSummary = forecasts
    ? forecasts
        .slice(0, 5)
        .map(
          (f) =>
            `  - ${f.asset}: ${f.direction.toUpperCase()} (${(f.confidence * 100).toFixed(0)}% confidence, ~${f.targetPct}% target)`
        )
        .join('\n')
    : '  Not available';

  return `
=== MARKET CONTEXT (X-Capital Flow Engine) ===

MARKET REGIME: ${regime.type} (confidence: ${(regime.confidence * 100).toFixed(0)}%)
${regime.description}
Key drivers: ${regime.drivers.join(', ')}

MACRO SNAPSHOT:
  India VIX: ${macro.vix.toFixed(2)}
  FII Net Flow: ₹${macro.fiiFlow.toLocaleString()} cr (${macro.fiiFlow >= 0 ? 'INFLOW' : 'OUTFLOW'})
  DII Net Flow: ₹${macro.diiFlow.toLocaleString()} cr
  India CPI: ${macro.cpi.toFixed(2)}%
  India 10Y Yield: ${macro.india10y.toFixed(2)}%
  US 10Y Yield: ${macro.us10y.toFixed(2)}%
  US 2Y Yield: ${macro.us2y.toFixed(2)}%
  Yield Curve (10Y-2Y): ${yieldSpread}% — ${yieldCurveStatus}
  USD/INR: ${macro.usdinr.toFixed(2)}

CURRENT PRICES:
${priceSummary}

ACTIVE ROTATION SIGNALS:
${rotationSummary || '  No strong rotation signals detected'}

5-10 DAY FORECASTS:
${forecastSummary}

=== END CONTEXT ===
`.trim();
}

function buildInsightSystemPrompt(): string {
  return `You are X-Capital Flow, an elite financial intelligence assistant specializing in Indian and global capital markets. You analyse macro data, capital flows, technical indicators, and cross-asset rotation signals to provide institutional-grade market insights.

Your analysis style:
- Clear, concise, and actionable — no fluff
- Evidence-based reasoning tied directly to the data provided
- Focus on cross-asset relationships (equities, commodities, FX, bonds)
- Understand Indian market microstructure: FII/DII dynamics, SEBI regulations, Nifty composition
- Use proper financial terminology
- Always acknowledge uncertainty and risks

When answering, structure your response clearly with labelled sections.`;
}

function buildInsightUserPrompt(
  ctx: MarketContext,
  question?: string
): string {
  const ctxBlock = buildMarketContextBlock(ctx);

  if (question) {
    return `${ctxBlock}

USER QUESTION: ${question}

Please answer the question using the market context above. Be specific and data-driven.`;
  }

  return `${ctxBlock}

Based on this market data, provide a comprehensive analysis covering:

1. WHAT IS HAPPENING: Describe the current market state in 2-3 sentences.
2. WHY CAPITAL IS ROTATING: Explain the macro and technical drivers behind current capital flows.
3. INVESTOR ACTION PLAN: Specific, actionable guidance for Indian retail and institutional investors.
4. KEY RISKS: List the top 3 risks to the current thesis.
5. OPPORTUNITIES: List the top 3 investment opportunities given the current regime.

Keep each section concise but substantive. Use the actual numbers from the data.`;
}

// ---------------------------------------------------------------------------
// Parse structured insight from model response
// ---------------------------------------------------------------------------

function parseInsightResponse(raw: string): AIInsightResponse {
  const extract = (label: string, fallback = ''): string => {
    const regex = new RegExp(
      `(?:${label}|\\d+\\.\\s*${label})[:\\s]*([\\s\\S]*?)(?=\\n(?:\\d+\\.|[A-Z ]{4,}:|$))`,
      'i'
    );
    const m = raw.match(regex);
    return m ? m[1].trim() : fallback;
  };

  // Extract bullet lists
  const extractList = (label: string): string[] => {
    const section = extract(label);
    if (!section) return [];
    return section
      .split(/\n/)
      .map((l) => l.replace(/^[-•*]\s*/, '').trim())
      .filter((l) => l.length > 10)
      .slice(0, 3);
  };

  const whatIsHappening = extract('WHAT IS HAPPENING', raw.slice(0, 300));
  const whyRotating = extract('WHY CAPITAL IS ROTATING', '');
  const whatToDo =
    extract('INVESTOR ACTION PLAN', '') || extract('WHAT TO DO', '');
  const keyRisks = extractList('KEY RISKS');
  const opportunities = extractList('OPPORTUNITIES');

  // Summary: first 2 sentences of the whole response
  const sentences = raw.split(/(?<=\.)\s+/);
  const summary = sentences.slice(0, 2).join(' ');

  return {
    summary,
    whatIsHappening,
    whyRotating,
    whatToDo,
    keyRisks,
    opportunities,
    rawText: raw,
  };
}

// ---------------------------------------------------------------------------
// Main API functions
// ---------------------------------------------------------------------------

/**
 * Generate a comprehensive AI insight for the current market state.
 */
export async function generateAIInsight(
  rotation: RotationResult[],
  regime: MarketRegime,
  indicators: ComputedIndicators,
  question?: string,
  forecasts?: ForecastResult[]
): Promise<AIInsightResponse> {
  const client = getClient();

  // Build context from indicators
  const lastClose = (arr: number[]) => arr[arr.length - 1] ?? 0;

  const ctx: MarketContext = {
    regime,
    rotations: rotation,
    forecasts,
    macro: {
      vix: indicators.indiaVix,
      fiiFlow: indicators.fiiFlow,
      diiFlow: indicators.diiFlow,
      cpi: indicators.cpi,
      india10y: indicators.india10y,
      us10y: indicators.us10y,
      us2y: indicators.us2y,
      usdinr: lastClose(indicators.usdinrCloses),
    },
    priceSnapshot: {
      NIFTY50:      lastClose(indicators.nifty50Closes),
      NIFTY_BANK:   lastClose(indicators.niftyBankCloses),
      NIFTY_IT:     lastClose(indicators.niftyITCloses),
      NIFTY_PHARMA: lastClose(indicators.niftyPharmaCloses),
      GOLD:         lastClose(indicators.goldCloses),
      CRUDE_OIL:    lastClose(indicators.crudeoilCloses),
      SPX:          lastClose(indicators.spxCloses),
      DXY:          lastClose(indicators.dxyCloses),
      USDINR:       lastClose(indicators.usdinrCloses),
    },
  };

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: buildInsightSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildInsightUserPrompt(ctx, question),
      },
    ],
  });

  const raw =
    response.content[0].type === 'text' ? response.content[0].text : '';
  return parseInsightResponse(raw);
}

/**
 * Multi-turn chat with the AI copilot, grounded in current market context.
 */
export async function chatWithCopilot(
  messages: ChatMessage[],
  context: MarketContext
): Promise<string> {
  const client = getClient();

  const ctxBlock = buildMarketContextBlock(context);

  // Prepend context to the first user message if not already present
  const enrichedMessages: Anthropic.Messages.MessageParam[] = messages.map(
    (m, i) => {
      if (i === 0 && m.role === 'user') {
        return {
          role: 'user' as const,
          content: `${ctxBlock}\n\n---\n\n${m.content}`,
        };
      }
      return { role: m.role as 'user' | 'assistant', content: m.content };
    }
  );

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 800,
    system: buildInsightSystemPrompt(),
    messages: enrichedMessages,
  });

  return response.content[0].type === 'text' ? response.content[0].text : '';
}

/**
 * Generate a quick one-liner market summary suitable for a dashboard header.
 */
export async function generateMarketOneLiner(
  regime: MarketRegime,
  vix: number,
  fiiFlow: number
): Promise<string> {
  const client = getClient();

  const prompt = `Current market data:
- Regime: ${regime.type} (${(regime.confidence * 100).toFixed(0)}% confidence)
- India VIX: ${vix.toFixed(2)}
- FII Flow: ₹${fiiFlow.toLocaleString()} crores

Write ONE sentence (max 20 words) summarising the market mood for a dashboard. Be direct and impactful.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 60,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].type === 'text'
    ? response.content[0].text.trim()
    : `Markets are ${regime.type.toLowerCase()} — stay informed.`;
}

/**
 * Explain a specific rotation signal in plain language.
 */
export async function explainRotation(
  rotation: RotationResult
): Promise<string> {
  const client = getClient();

  const prompt = `Explain this capital rotation signal in 2-3 sentences for an Indian retail investor:
- From: ${rotation.from}
- To: ${rotation.to}
- Regime: ${rotation.regime}
- Confidence: ${(rotation.confidence * 100).toFixed(0)}%
- Strength: ${rotation.strength}
- Key signals: ${rotation.signals.join('; ')}

Be clear, educational, and mention what this means practically for their portfolio.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].type === 'text'
    ? response.content[0].text.trim()
    : `Capital is rotating from ${rotation.from} to ${rotation.to} due to ${rotation.signals[0] ?? 'multiple signals'}.`;
}
