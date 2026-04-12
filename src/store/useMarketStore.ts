import { create } from "zustand"
import type {
  MarketData,
  RotationResult,
  RegimeType,
  RegimeAssessment,
  Signal,
} from "@/types"

// ─────────────────────────────────────────────────────────────────────────────
// Chat message type for the AI Copilot
// ─────────────────────────────────────────────────────────────────────────────

export type ChatRole = "user" | "assistant" | "system"

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  timestamp: string  // ISO-8601
  isStreaming?: boolean
  metadata?: {
    model?: string
    tokens?: number
    regime?: RegimeType
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Store shape
// ─────────────────────────────────────────────────────────────────────────────

interface MarketState {
  // ── Market data ──────────────────────────────────────────────────────────
  marketData: MarketData[]
  signals: Signal[]
  rotationResult: RotationResult | null
  regimeAssessment: RegimeAssessment | null
  currentRegime: RegimeType

  // ── Loading / sync ────────────────────────────────────────────────────────
  isLoading: boolean
  isRefreshing: boolean
  lastUpdated: string | null   // ISO-8601 timestamp of last successful fetch
  error: string | null

  // ── Selection ─────────────────────────────────────────────────────────────
  selectedAsset: string | null   // asset ticker

  // ── AI Copilot ────────────────────────────────────────────────────────────
  copilotMessages: ChatMessage[]
  isCopilotLoading: boolean

  // ── Actions ───────────────────────────────────────────────────────────────
  fetchMarketData: () => Promise<void>
  refreshMarketData: () => Promise<void>
  setSelectedAsset: (ticker: string | null) => void
  addCopilotMessage: (message: Omit<ChatMessage, "id" | "timestamp">) => void
  updateCopilotMessage: (id: string, patch: Partial<ChatMessage>) => void
  clearCopilotMessages: () => void
  setCopilotLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// ID / timestamp helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function nowISO(): string {
  return new Date().toISOString()
}

// ─────────────────────────────────────────────────────────────────────────────
// Store implementation
// ─────────────────────────────────────────────────────────────────────────────

export const useMarketStore = create<MarketState>((set, get) => ({
  // ── Initial state ─────────────────────────────────────────────────────────
  marketData: [],
  signals: [],
  rotationResult: null,
  regimeAssessment: null,
  currentRegime: "UNKNOWN",

  isLoading: false,
  isRefreshing: false,
  lastUpdated: null,
  error: null,

  selectedAsset: null,

  copilotMessages: [],
  isCopilotLoading: false,

  // ── fetchMarketData ───────────────────────────────────────────────────────
  fetchMarketData: async () => {
    if (get().isLoading) return
    set({ isLoading: true, error: null })

    try {
      // Parallel fetch of market summary, signals, and rotation
      const [marketRes, signalsRes, rotationRes] = await Promise.allSettled([
        fetch("/api/market/summary"),
        fetch("/api/signals?active=true&limit=20"),
        fetch("/api/rotation/latest"),
      ])

      const updates: Partial<MarketState> = {
        isLoading: false,
        lastUpdated: nowISO(),
      }

      if (marketRes.status === "fulfilled" && marketRes.value.ok) {
        const json = await marketRes.value.json()
        updates.marketData = json.data ?? json
      }

      if (signalsRes.status === "fulfilled" && signalsRes.value.ok) {
        const json = await signalsRes.value.json()
        updates.signals = json.data ?? json
      }

      if (rotationRes.status === "fulfilled" && rotationRes.value.ok) {
        const json = await rotationRes.value.json()
        const result: RotationResult = json.data ?? json
        updates.rotationResult = result
        updates.currentRegime = result.regime ?? "UNKNOWN"
      }

      set(updates)
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to fetch market data",
      })
    }
  },

  // ── refreshMarketData (silent background refresh) ─────────────────────────
  refreshMarketData: async () => {
    if (get().isRefreshing) return
    set({ isRefreshing: true, error: null })

    try {
      const [marketRes, signalsRes, rotationRes] = await Promise.allSettled([
        fetch("/api/market/summary"),
        fetch("/api/signals?active=true&limit=20"),
        fetch("/api/rotation/latest"),
      ])

      const updates: Partial<MarketState> = {
        isRefreshing: false,
        lastUpdated: nowISO(),
      }

      if (marketRes.status === "fulfilled" && marketRes.value.ok) {
        const json = await marketRes.value.json()
        updates.marketData = json.data ?? json
      }

      if (signalsRes.status === "fulfilled" && signalsRes.value.ok) {
        const json = await signalsRes.value.json()
        updates.signals = json.data ?? json
      }

      if (rotationRes.status === "fulfilled" && rotationRes.value.ok) {
        const json = await rotationRes.value.json()
        const result: RotationResult = json.data ?? json
        updates.rotationResult = result
        updates.currentRegime = result.regime ?? "UNKNOWN"
      }

      set(updates)
    } catch (err) {
      set({
        isRefreshing: false,
        error: err instanceof Error ? err.message : "Refresh failed",
      })
    }
  },

  // ── setSelectedAsset ──────────────────────────────────────────────────────
  setSelectedAsset: (ticker) => set({ selectedAsset: ticker }),

  // ── addCopilotMessage ─────────────────────────────────────────────────────
  addCopilotMessage: (message) => {
    const newMessage: ChatMessage = {
      ...message,
      id: generateId(),
      timestamp: nowISO(),
    }
    set((state) => ({
      copilotMessages: [...state.copilotMessages, newMessage],
    }))
  },

  // ── updateCopilotMessage ──────────────────────────────────────────────────
  updateCopilotMessage: (id, patch) => {
    set((state) => ({
      copilotMessages: state.copilotMessages.map((msg) =>
        msg.id === id ? { ...msg, ...patch } : msg
      ),
    }))
  },

  // ── clearCopilotMessages ──────────────────────────────────────────────────
  clearCopilotMessages: () => set({ copilotMessages: [] }),

  // ── setCopilotLoading ─────────────────────────────────────────────────────
  setCopilotLoading: (loading) => set({ isCopilotLoading: loading }),

  // ── setError ──────────────────────────────────────────────────────────────
  setError: (error) => set({ error }),
}))

// ─────────────────────────────────────────────────────────────────────────────
// Convenience selectors
// ─────────────────────────────────────────────────────────────────────────────

export const selectMarketData = (s: MarketState) => s.marketData
export const selectSignals = (s: MarketState) => s.signals
export const selectRotationResult = (s: MarketState) => s.rotationResult
export const selectCurrentRegime = (s: MarketState) => s.currentRegime
export const selectIsLoading = (s: MarketState) => s.isLoading
export const selectIsRefreshing = (s: MarketState) => s.isRefreshing
export const selectLastUpdated = (s: MarketState) => s.lastUpdated
export const selectSelectedAsset = (s: MarketState) => s.selectedAsset
export const selectCopilotMessages = (s: MarketState) => s.copilotMessages
export const selectIsCopilotLoading = (s: MarketState) => s.isCopilotLoading
