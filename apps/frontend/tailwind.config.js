/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        trading: {
          bg: "var(--trading-bg)",
          surface: "var(--trading-surface)",
          border: "var(--trading-border)",
          gridLine: "var(--trading-grid-line)",
          textMuted: "var(--trading-text-muted)",
          textActive: "var(--trading-text-active)",
          bullish: "var(--trading-bullish)",
          bearish: "var(--trading-bearish)",
          neutral: "var(--trading-neutral)",
          divergence: "var(--trading-divergence)",
          sentiment: "var(--trading-sentiment)",
          dayHigh: "var(--trading-day-high)",
          dayLow: "var(--trading-day-low)",
        }
      },
    fontFamily: {
  sans: ["Inter", "Outfit", "sans-serif"],
  mono: ["Inter", "JetBrains Mono", "monospace"],
}
    },
  },
  plugins: [],
}
