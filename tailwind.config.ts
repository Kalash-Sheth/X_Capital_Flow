import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        // ─── Base / Background ────────────────────────────────────────────
        background: {
          DEFAULT: "#F7F6F2",   // warm off-white — primary page bg
          subtle:  "#EFEDE7",   // slightly darker off-white for cards / panels
          muted:   "#E8E5DC",   // muted ivory for table stripes / dividers
        },
        foreground: {
          DEFAULT: "#1A1A1A",   // near-black for primary text
          muted:   "#4B4B4B",   // secondary text
          subtle:  "#7A7A7A",   // tertiary / placeholder text
        },

        // ─── Brand / Accent ───────────────────────────────────────────────
        brand: {
          DEFAULT: "#1B3A5C",   // deep institutional navy — primary brand
          light:   "#2D5F8A",   // lighter navy for hover states
          muted:   "#4A7FA5",   // medium blue for secondary accents
          subtle:  "#C8DCF0",   // pale blue for tinted surfaces
        },

        // ─── Semantic: Positive / Bull ────────────────────────────────────
        positive: {
          DEFAULT: "#2D7A4F",   // deep institutional green
          light:   "#3FA066",   // lighter green for hover
          muted:   "#6BBF8A",   // medium green — badges, tags
          subtle:  "#D4F0E0",   // pale green — tinted backgrounds / chips
          text:    "#1C5C38",   // dark green for text on light bg
        },

        // ─── Semantic: Negative / Bear ────────────────────────────────────
        negative: {
          DEFAULT: "#B83232",   // deep institutional red
          light:   "#D94444",   // lighter red for hover
          muted:   "#E87272",   // medium red — badges, tags
          subtle:  "#FAE0E0",   // pale red — tinted backgrounds / chips
          text:    "#8C1F1F",   // dark red for text on light bg
        },

        // ─── Semantic: Caution / Neutral ──────────────────────────────────
        caution: {
          DEFAULT: "#B87A1A",   // deep amber / gold
          light:   "#D49A2A",   // lighter amber for hover
          muted:   "#E8BC6A",   // medium amber — badges, tags
          subtle:  "#FBF0D4",   // pale amber — tinted backgrounds / chips
          text:    "#7A4F0A",   // dark amber for text on light bg
        },

        // ─── Surface / UI Primitives ──────────────────────────────────────
        card: {
          DEFAULT: "#FFFFFF",
          foreground: "#1A1A1A",
        },
        popover: {
          DEFAULT: "#FFFFFF",
          foreground: "#1A1A1A",
        },
        border: {
          DEFAULT: "#DDD9D0",   // warm grey border
          strong:  "#C4BFB4",   // stronger border for emphasis
          subtle:  "#ECEAE4",   // very subtle divider
        },
        input:       "#DDD9D0",
        ring:        "#2D5F8A",

        // ─── Shadcn-compatible aliases ────────────────────────────────────
        primary: {
          DEFAULT:    "#1B3A5C",
          foreground: "#F7F6F2",
        },
        secondary: {
          DEFAULT:    "#EFEDE7",
          foreground: "#1A1A1A",
        },
        destructive: {
          DEFAULT:    "#B83232",
          foreground: "#F7F6F2",
        },
        muted: {
          DEFAULT:    "#EFEDE7",
          foreground: "#7A7A7A",
        },
        accent: {
          DEFAULT:    "#C8DCF0",
          foreground: "#1B3A5C",
        },

        // ─── Chart palette ────────────────────────────────────────────────
        chart: {
          "1": "#1B3A5C",   // navy
          "2": "#2D7A4F",   // green
          "3": "#B83232",   // red
          "4": "#B87A1A",   // amber
          "5": "#4A7FA5",   // blue-grey
          "6": "#6B4FA5",   // purple
          "7": "#A54F6B",   // rose
          "8": "#4FA58A",   // teal
        },
      },

      // ─── Typography ─────────────────────────────────────────────────────
      fontFamily: {
        sans:  ["Inter", "system-ui", "sans-serif"],
        mono:  ["JetBrains Mono", "Menlo", "monospace"],
        serif: ["Georgia", "Times New Roman", "serif"],
      },
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },

      // ─── Spacing ────────────────────────────────────────────────────────
      spacing: {
        "4.5": "1.125rem",
        "13":  "3.25rem",
        "15":  "3.75rem",
        "18":  "4.5rem",
        "22":  "5.5rem",
      },

      // ─── Border radius ──────────────────────────────────────────────────
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },

      // ─── Box shadow ─────────────────────────────────────────────────────
      boxShadow: {
        card:   "0 1px 3px 0 rgba(26,26,26,0.08), 0 1px 2px -1px rgba(26,26,26,0.06)",
        panel:  "0 4px 12px 0 rgba(26,26,26,0.08)",
        modal:  "0 20px 40px 0 rgba(26,26,26,0.16)",
        glow:   "0 0 16px 0 rgba(45,95,138,0.20)",
        "glow-positive": "0 0 16px 0 rgba(45,122,79,0.20)",
        "glow-negative": "0 0 16px 0 rgba(184,50,50,0.20)",
      },

      // ─── Keyframes / Animations ──────────────────────────────────────────
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to:   { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to:   { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "fade-out": {
          from: { opacity: "1", transform: "translateY(0)" },
          to:   { opacity: "0", transform: "translateY(4px)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to:   { opacity: "1", transform: "translateX(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to:   { opacity: "1", transform: "scale(1)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%":       { opacity: "0.4" },
        },
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition:  "200% 0" },
        },
      },
      animation: {
        "accordion-down":  "accordion-down 0.2s ease-out",
        "accordion-up":    "accordion-up 0.2s ease-out",
        "fade-in":         "fade-in 0.25s ease-out",
        "fade-out":        "fade-out 0.2s ease-in",
        "slide-in-right":  "slide-in-right 0.25s ease-out",
        "scale-in":        "scale-in 0.2s ease-out",
        "pulse-dot":       "pulse-dot 1.5s ease-in-out infinite",
        shimmer:           "shimmer 2s linear infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
