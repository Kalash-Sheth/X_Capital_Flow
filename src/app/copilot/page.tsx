"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Bot,
  Sparkles,
  TrendingUp,
  Globe,
  DollarSign,
  BarChart2,
  Activity,
  RefreshCw,
  Copy,
  Check,
} from "lucide-react";
import ChatMessage, {
  Message,
  TypingIndicator,
} from "@/components/copilot/ChatMessage";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Predefined queries ───────────────────────────────────────────────────────
const QUICK_QUERIES: {
  label: string;
  icon: React.ElementType;
  query: string;
  color: string;
}[] = [
  {
    label: "Current market regime",
    icon: Activity,
    query: "What is the current market regime?",
    color: "#1B3A5C",
  },
  {
    label: "Where is capital flowing?",
    icon: TrendingUp,
    query: "Where is capital flowing right now?",
    color: "#2D7D46",
  },
  {
    label: "Equity allocation advice",
    icon: BarChart2,
    query: "What should I do with my equity allocation?",
    color: "#B45309",
  },
  {
    label: "Yield curve situation",
    icon: Globe,
    query: "Explain the yield curve situation",
    color: "#7C3AED",
  },
  {
    label: "Is gold a good buy?",
    icon: DollarSign,
    query: "Is gold a good buy right now?",
    color: "#0891B2",
  },
];

// ─── Mock AI responses ────────────────────────────────────────────────────────
const MOCK_RESPONSES: Record<string, string> = {
  "What is the current market regime?": `**Current Market Regime: Risk-On (Confidence: 82%)**

The macro environment is firmly in a **Risk-On** regime, driven by the following key dynamics:

- **Equity momentum** is positive across Nifty50 (+3.8% 1M), S&P 500 (+2.3%), and IT sectors, with RSI readings between 55–70
- **FII flows** turned net positive after a 3-month outflow period, with ₹1,840Cr net inflows over the past week
- **Credit spreads** remain contained (HY at 390bps) — no systemic stress signals
- **India VIX** at 14.8 confirms low fear; markets are not pricing a shock event

**Regime implications:**
- Favor growth sectors (IT, financials, small-cap)
- Gold as a portfolio stabilizer remains attractive
- Avoid defensive plays like FMCG and utilities unless as a hedge

The regime has been in place for approximately 6 weeks. Watch for DXY direction and US jobs data as potential inflection triggers.`,

  "Where is capital flowing right now?": `**Capital Flow Analysis — March 2026**

Based on cross-asset momentum and institutional positioning data, capital is rotating through three primary channels:

**1. Into Indian Equities (Bullish)**
FII net inflows resumed after Q4 2025 selling. The weaker DXY (-1.8% 1M) is a direct tailwind for EM inflows. Domestic SIP flows remain at record levels (₹22,000+ Cr/month), providing a persistent bid.

**2. Into Gold & Precious Metals (Strong Rotation)**
Gold has outperformed SPX by 2.3% over the past 3 months. Central bank buying (China, India, Poland) is structurally supporting prices above $2,600. This signals late-cycle defensive rotation alongside risk-on equities — a divergence worth monitoring.

**3. Away from Crude Oil & Commodities (Outflow)**
WTI Crude down 4.1% 1M as global demand growth expectations moderate. Seasonal demand weakness and US production at 2-year highs are applying downside pressure.

**Net assessment:** Dual rotation — risk assets and gold simultaneously attracting flows, suggesting sophisticated hedging behavior rather than pure risk-on positioning.`,

  "What should I do with my equity allocation?": `**Equity Allocation Recommendation**

Given the current Risk-On regime with elevated but not extreme valuations, here is a tactical framework:

**Recommended adjustments:**

- **Nifty 50 (Large Cap):** Trim from ~32% to 28%. Trailing P/E at 21x is above the 10-year average of 18x. Capture gains without fully exiting the trend.
- **Nifty IT (Tech):** Increase from 12% to 16%. IT shows the strongest relative strength (1.18x vs Nifty) and benefits directly from DXY weakness boosting export revenues.
- **Nifty Bank:** Reduce from 14% to 10%. RSI at 72 signals near-term overbought conditions. Sector leadership may rotate away as credit growth moderates.
- **Small-Cap:** Hold current 5% allocation. Risk/reward is balanced; wait for a confirmed breakout above prior highs before adding.

**Key risk factors to monitor:**
- A sustained DXY reversal above 106 would be a headwind for FII flows
- US 10Y yield rising above 4.7% could reprice global equity risk premiums
- Nifty earnings season (April) will be the next fundamental catalyst

Position sizing discipline is paramount — no single sector should exceed 20% without strong conviction signals across multiple timeframes.`,

  "Explain the yield curve situation": `**US Yield Curve — Current Analysis**

The US Treasury yield curve remains **inverted** (10Y-2Y spread at -0.24%), though the inversion has narrowed significantly from the -1.07% extreme seen in mid-2023.

**What the inversion means:**
- Historically, sustained inversions precede recessions by 12–24 months with ~70% accuracy
- However, the current cycle has been unusually prolonged — the economy has shown remarkable resilience
- Fed rate cuts (priced in for H2 2026) are the primary driver of curve steepening expectations

**Current readings:**
- US 2Y Yield: **4.52%** (heavily influenced by Fed policy expectations)
- US 10Y Yield: **4.28%** (reflecting long-term growth and inflation outlook)
- Spread: **-0.24%** (narrowing from -0.54% six weeks ago)

**Investment implications:**
- The narrowing inversion suggests the market believes rate cuts are coming — positive for duration
- **Fixed income opportunity:** Adding 10Y bond exposure (increasing duration) is now favorable as the curve is expected to normalize (steepen) through 2026
- Indian bond market benefits indirectly as RBI follows global rate easing with a 2–3 month lag

**Bottom line:** The yield curve is signaling caution but not imminent collapse. Use any bond yield spike above 4.5% as a buying opportunity for duration exposure.`,

  "Is gold a good buy right now?": `**Gold — Investment Case Analysis**

**Short answer: Yes, with a medium-to-long term horizon.**

Gold is currently exhibiting one of the strongest fundamental and technical setups in recent years:

**Bullish drivers:**
- **DXY weakness** (-1.8% 1M): Gold is priced in USD — a weaker dollar directly boosts gold's purchasing power
- **Central bank buying:** EM central banks (China, India, Poland) have been net buyers for 8 consecutive quarters, creating structural demand
- **Real yields approaching zero:** As nominal rates fall and inflation expectations remain anchored, real yields compress — gold's opportunity cost decreases
- **Geopolitical premium:** Elevated macro uncertainty (Middle East, Taiwan tensions) sustains safe-haven demand
- **Technical confirmation:** Price above all major MAs; RSI at 58 (healthy, not overbought); SAR dots below price

**Caution points:**
- A sudden DXY reversal or hawkish Fed surprise could trigger a $50–80/oz correction
- Gold doesn't generate yield — in a high-rate environment, opportunity cost is elevated

**Technical levels:**
- **Support:** $2,620 (20-DMA), $2,580 (key pivot)
- **Target:** $2,750 (next major resistance) over 6–8 weeks
- **Stop loss:** $2,565

**Suggested allocation:** 10–15% of portfolio for balanced risk management. Current analysis supports scaling into gold on any 1.5–2% pullback.`,
};

function getFallbackResponse(query: string): string {
  const q = query.toLowerCase();
  if (q.includes("regime") || q.includes("market")) {
    return MOCK_RESPONSES["What is the current market regime?"];
  }
  if (q.includes("flow") || q.includes("capital") || q.includes("rotation")) {
    return MOCK_RESPONSES["Where is capital flowing right now?"];
  }
  if (q.includes("equity") || q.includes("allocation") || q.includes("portfolio")) {
    return MOCK_RESPONSES["What should I do with my equity allocation?"];
  }
  if (q.includes("yield") || q.includes("bond") || q.includes("rate")) {
    return MOCK_RESPONSES["Explain the yield curve situation"];
  }
  if (q.includes("gold") || q.includes("commodity") || q.includes("precious")) {
    return MOCK_RESPONSES["Is gold a good buy right now?"];
  }

  return `**Analysis for: "${query}"**

Thank you for your question. Based on the current market data available:

**Key observations:**
- The market is in a **Risk-On** regime with 82% confidence
- Cross-asset momentum is broadly positive for equity and commodity assets
- Macro backdrop shows contained inflation (CPI 4.2%) and supportive monetary policy

**General guidance:**
- Maintain diversified exposure across asset classes
- Monitor DXY direction as a key driver of EM and commodity flows
- Keep a 10–15% allocation to gold as a regime-change hedge

For more specific analysis on this topic, consider asking about:
- "What is the current capital rotation?"
- "How should I position my portfolio in this regime?"
- "What technical signals are showing for key assets?"

I'm here to provide deeper analysis on any specific asset, indicator, or market theme you'd like to explore.`;
}

// ─── Initial welcome message ──────────────────────────────────────────────────
const WELCOME_MESSAGE: Message = {
  id: "welcome",
  role: "assistant",
  content: `**Welcome to X-Capital Flow AI Copilot**

I'm your institutional-grade market intelligence assistant. I can help you with:

- **Market regime analysis** — current macro environment and what it means
- **Capital flow tracking** — where institutional money is moving
- **Portfolio allocation** — regime-based recommendations
- **Technical analysis** — signal interpretation for any tracked asset
- **Macro context** — yield curves, credit spreads, currency dynamics

Select a quick query below or type your own question. I have full context on all 16 tracked assets, 34 active signals, and real-time macro data.`,
  timestamp: new Date(),
};

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function CopilotPage() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, scrollToBottom]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isTyping) return;

      const userMsg: Message = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setIsTyping(true);

      // Attempt real API call, fall back to mock
      let responseText: string;
      try {
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, history: messages }),
        });
        if (res.ok) {
          const data = await res.json();
          responseText = data.message ?? data.content ?? data.text ?? "";
          if (!responseText) throw new Error("Empty response");
        } else {
          throw new Error("API error");
        }
      } catch {
        // Simulate network delay for mock responses
        const delay = 1200 + Math.random() * 800;
        await new Promise((r) => setTimeout(r, delay));
        responseText =
          MOCK_RESPONSES[trimmed] ?? getFallbackResponse(trimmed);
      }

      setIsTyping(false);

      const assistantMsg: Message = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: responseText,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    },
    [isTyping, messages]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const copyMessage = async (msg: Message) => {
    await navigator.clipboard.writeText(msg.content);
    setCopiedId(msg.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const clearChat = () => {
    setMessages([WELCOME_MESSAGE]);
    setInput("");
  };

  return (
    <div className="flex flex-col bg-[#F7F6F2] overflow-hidden -m-6" style={{ height: "calc(100vh - 56px)" }}>
      {/* Header */}
      <div className="flex-shrink-0 border-b border-[#DDD9D0] bg-white px-6 py-4">
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1B3A5C] shadow-sm">
              <Sparkles size={16} className="text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-foreground">
                AI Copilot
              </h1>
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <p className="text-xs text-muted-foreground">
                  Online · Market Intelligence Active
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-2 rounded-lg border border-[#DDD9D0] bg-[#F7F6F2] px-3 py-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                Claude Sonnet
              </span>
              <span className="rounded-full bg-[#1B3A5C] px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
                Pro
              </span>
            </div>
            <button
              onClick={clearChat}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#DDD9D0] bg-white text-muted-foreground hover:bg-[#F0EDE6] hover:text-foreground transition-colors"
              title="Clear chat"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </motion.div>
      </div>

      {/* Quick queries */}
      <div className="flex-shrink-0 border-b border-[#DDD9D0] bg-white/80 px-6 py-3">
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5 scrollbar-none">
          <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">
            Quick ask:
          </span>
          {QUICK_QUERIES.map((q) => (
            <button
              key={q.query}
              onClick={() => sendMessage(q.query)}
              disabled={isTyping}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-full border border-[#DDD9D0] bg-white px-3 py-1.5 text-xs font-medium text-foreground hover:border-[#B8B3A8] hover:bg-[#F7F6F2] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 hover:-translate-y-0.5 hover:shadow-sm"
            >
              <q.icon size={11} style={{ color: q.color }} />
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.map((msg, i) => (
            <div key={msg.id} className="group relative">
              <ChatMessage message={msg} index={i} />
              {/* Copy button for assistant messages */}
              {msg.role === "assistant" && (
                <button
                  onClick={() => copyMessage(msg)}
                  className="absolute -top-1 right-10 opacity-0 group-hover:opacity-100 transition-opacity flex h-6 w-6 items-center justify-center rounded-md border border-[#DDD9D0] bg-white text-muted-foreground hover:text-foreground shadow-sm"
                >
                  {copiedId === msg.id ? (
                    <Check size={10} className="text-emerald-500" />
                  ) : (
                    <Copy size={10} />
                  )}
                </button>
              )}
            </div>
          ))}

          {/* Typing indicator */}
          <AnimatePresence>
            {isTyping && <TypingIndicator />}
          </AnimatePresence>

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 border-t border-[#DDD9D0] bg-white px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <div
            className={cn(
              "flex items-end gap-3 rounded-2xl border bg-white px-4 py-3 transition-all duration-200 shadow-sm",
              input.length > 0
                ? "border-[#1B3A5C]/40 shadow-md"
                : "border-[#DDD9D0]"
            )}
          >
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[#F7F6F2]">
              <Bot size={13} className="text-[#1B3A5C]" />
            </div>

            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Auto-resize
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask about market regimes, capital flows, asset analysis..."
              disabled={isTyping}
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60 leading-relaxed"
              style={{ minHeight: "28px", maxHeight: "120px" }}
            />

            <motion.button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isTyping}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className={cn(
                "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl transition-all duration-150",
                input.trim() && !isTyping
                  ? "bg-[#1B3A5C] text-white shadow-sm hover:bg-[#2D5F8A]"
                  : "bg-[#F0EDE6] text-muted-foreground cursor-not-allowed"
              )}
            >
              <Send size={13} />
            </motion.button>
          </div>

          <p className="mt-2 text-center text-[10px] text-muted-foreground">
            Press Enter to send · Shift + Enter for new line · Responses may take a moment
          </p>
        </div>
      </div>
    </div>
  );
}
