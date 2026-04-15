import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"

// ─────────────────────────────────────────────────────────────────────────────
// Font
// ─────────────────────────────────────────────────────────────────────────────

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
  weight: ["400", "500", "600", "700"],
})

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

export const metadata: Metadata = {
  title: {
    default: "X-Capital Flow",
    template: "%s · X-Capital Flow",
  },
  description:
    "Institutional-grade capital flow analysis, macro regime detection, and AI-powered rotation intelligence for modern markets.",
  keywords: [
    "capital flow",
    "market rotation",
    "macro regime",
    "institutional trading",
    "asset allocation",
    "AI copilot",
    "market signals",
  ],
  authors: [{ name: "X-Capital Flow" }],
  creator: "X-Capital Flow",
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon-16x16.png",
    apple: "/apple-touch-icon.png",
  },
}

export const viewport: Viewport = {
  themeColor: "#1B3A5C",
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
}

// ─────────────────────────────────────────────────────────────────────────────
// Root layout
// ─────────────────────────────────────────────────────────────────────────────

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Preconnect for Google Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  )
}
