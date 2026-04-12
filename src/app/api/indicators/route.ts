// ============================================================
// GET /api/indicators?symbol=NIFTY50
// Returns computed technical indicators for one or all assets.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import {
  BASE_PRICES,
  generateOHLCV,
  computeRSI,
  computeSMA,
  computeMACD,
  computeBollinger,
  computeATR,
  computeADX,
  computeOBV,
  computeVWAP,
  computeHeikinAshi,
  computeFibLevels,
  computeSupportResistance,
  computeRelativeStrength,
  computeCompositeScores,
  getMacroData,
} from "../_lib/mockData";

export const dynamic = "force-dynamic";

function computeIndicatorsForSymbol(symbol: string) {
  const bars   = generateOHLCV(symbol, 200);
  const closes = bars.map(b => b.close);

  // RSI
  const rsiSeries  = computeRSI(closes, 14);
  const rsiCurrent = rsiSeries[rsiSeries.length - 1] ?? 50;
  const rsi14Series = rsiSeries.slice(-14);

  // MACD
  const macd = computeMACD(closes);

  // SMAs
  const sma20Arr  = computeSMA(closes, 20);
  const sma50Arr  = computeSMA(closes, 50);
  const sma200Arr = computeSMA(closes, 200);
  const sma20     = sma20Arr[sma20Arr.length - 1]  ?? closes[closes.length - 1];
  const sma50     = sma50Arr[sma50Arr.length - 1]  ?? closes[closes.length - 1];
  const sma200    = sma200Arr[sma200Arr.length - 1] ?? closes[closes.length - 1];

  // Bollinger Bands
  const bollinger = computeBollinger(closes);

  // ADX
  const adx = computeADX(bars);

  // ATR
  const atr = computeATR(bars);

  // OBV (normalized)
  const obv = computeOBV(bars);

  // VWAP
  const vwap = computeVWAP(bars);

  // Heikin Ashi
  const heikinAshiTrend = computeHeikinAshi(bars);

  // Fibonacci levels
  const fibonacci = computeFibLevels(bars);

  // Support / Resistance
  const { support, resistance } = computeSupportResistance(bars);

  // Composite scores (only for primary equity)
  const composites = symbol === "NIFTY50"
    ? computeCompositeScores(bars)
    : { rotationScore: null, riskPressure: null, healthScore: null };

  const currentClose = closes[closes.length - 1];

  return {
    symbol,
    computedAt: new Date().toISOString(),
    price: currentClose,
    rsi: {
      value:  rsiCurrent,
      series: rsi14Series,
      signal: rsiCurrent > 70 ? "Overbought" : rsiCurrent < 30 ? "Oversold" : "Neutral",
    },
    macd: {
      macd:      macd.macd,
      signal:    macd.signal,
      histogram: macd.histogram,
      crossover: macd.macd > macd.signal ? "Bullish" : "Bearish",
    },
    movingAverages: {
      sma20,
      sma50,
      sma200,
      aboveSMA20:  currentClose > sma20,
      aboveSMA50:  currentClose > sma50,
      aboveSMA200: currentClose > sma200,
      goldenCross: sma50 > sma200,
      deathCross:  sma50 < sma200,
    },
    bollinger: {
      upper:       bollinger.upper,
      middle:      bollinger.middle,
      lower:       bollinger.lower,
      squeeze:     bollinger.squeeze,
      percentB:    parseFloat(
        (((currentClose - bollinger.lower) / (bollinger.upper - bollinger.lower || 1)) * 100).toFixed(2)
      ),
    },
    adx: {
      value:  adx,
      trend:  adx > 40 ? "Very Strong Trend" : adx > 25 ? "Strong Trend" : adx > 20 ? "Moderate Trend" : "Weak / No Trend",
    },
    atr: {
      value:          atr,
      percentOfPrice: parseFloat(((atr / currentClose) * 100).toFixed(2)),
    },
    obv: {
      normalized: obv,
      trend:      obv > 10 ? "Accumulation" : obv < -10 ? "Distribution" : "Neutral",
    },
    vwap: {
      value:      vwap,
      aboveVWAP:  currentClose > vwap,
    },
    heikinAshi: {
      trend: heikinAshiTrend,
    },
    fibonacci,
    supportResistance: {
      support,
      resistance,
      distanceToSupport:    parseFloat(((currentClose - support) / currentClose * 100).toFixed(2)),
      distanceToResistance: parseFloat(((resistance - currentClose) / currentClose * 100).toFixed(2)),
    },
    ...composites.rotationScore !== null && {
      compositeScores: {
        capitalRotationScore: composites.rotationScore,
        riskPressureIndex:    composites.riskPressure,
        marketHealthScore:    composites.healthScore,
      },
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const symbolParam  = searchParams.get("symbol")?.toUpperCase();

    // If a specific symbol is requested
    if (symbolParam) {
      if (!BASE_PRICES[symbolParam]) {
        return NextResponse.json(
          {
            error: `Unknown symbol: ${symbolParam}`,
            availableSymbols: Object.keys(BASE_PRICES),
          },
          { status: 404 }
        );
      }

      // Also include relative strength ratios and macro-derived scores for full context
      const macro  = getMacroData();
      const rs     = computeRelativeStrength();
      const yield10y = BASE_PRICES.US10Y.price;
      const yield2y  = BASE_PRICES.US2Y.price;

      return NextResponse.json(
        {
          ...computeIndicatorsForSymbol(symbolParam),
          relativeStrength: rs,
          yieldCurve: {
            spread:  parseFloat((yield10y - yield2y).toFixed(4)),
            regime:  yield10y > yield2y ? "Normal" : "Inverted",
            realYield: parseFloat((yield10y - macro.cpi).toFixed(4)),
          },
        },
        { status: 200 }
      );
    }

    // Return indicators for all symbols
    const macro    = getMacroData();
    const rs       = computeRelativeStrength();
    const yield10y = BASE_PRICES.US10Y.price;
    const yield2y  = BASE_PRICES.US2Y.price;

    const allIndicators = Object.keys(BASE_PRICES).map(sym =>
      computeIndicatorsForSymbol(sym)
    );

    // Global composite scores from NIFTY50 bars
    const niftyBars       = generateOHLCV("NIFTY50", 200);
    const compositeScores = computeCompositeScores(niftyBars);

    return NextResponse.json(
      {
        computedAt: new Date().toISOString(),
        indicators: allIndicators,
        relativeStrength: rs,
        yieldCurve: {
          spread:    parseFloat((yield10y - yield2y).toFixed(4)),
          regime:    yield10y > yield2y ? "Normal" : "Inverted",
          realYield: parseFloat((yield10y - macro.cpi).toFixed(4)),
        },
        compositeScores: {
          capitalRotationScore: compositeScores.rotationScore,
          riskPressureIndex:    compositeScores.riskPressure,
          marketHealthScore:    compositeScores.healthScore,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[GET /api/indicators]", error);
    return NextResponse.json(
      { error: "Failed to compute indicators" },
      { status: 500 }
    );
  }
}
