import type { Config } from "tailwindcss";

// Sexualsync v1 brand palette — see docs/DESIGN_BRIEF.md.
// The shipped app is dark by default: wine-dark surfaces, warm cream text,
// and rose as the primary accent.
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        // Surface tokens (read from CSS variables so Tailwind alpha works).
        bg: "rgb(var(--bg-rgb) / <alpha-value>)",
        surface: "rgb(var(--surface-rgb) / <alpha-value>)",
        "surface-2": "rgb(var(--surface-2-rgb) / <alpha-value>)",
        ink: "rgb(var(--cream-rgb) / <alpha-value>)",
        "ink-2": "rgb(var(--cream-muted-rgb) / <alpha-value>)",
        "ink-3": "rgb(var(--cream-faint-rgb) / <alpha-value>)",
        line: "rgb(var(--hairline-rgb) / <alpha-value>)",

        // Brand accents.
        primary: "rgb(var(--accent-rgb) / <alpha-value>)",
        "primary-ink": "rgb(var(--ink-rgb) / <alpha-value>)",
        gold: "rgb(var(--gold-rgb) / <alpha-value>)",
        rose: "rgb(var(--accent-rgb) / <alpha-value>)",

        // Semantic.
        no: "rgb(var(--no-rgb) / <alpha-value>)",
      },
      fontFamily: {
        // Editorial serif for headings, humanist sans for UI.
        // Bound by next/font in layout.tsx via CSS variables.
        display: ["var(--font-display)", "Cormorant Garamond", "Georgia", "serif"],
        sans: ["var(--font-sans)", "Geist", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        // 13px floor per the brief — never go below this in UI text.
        xs: ["13px", { lineHeight: "1.4" }],
        // Editorial display ramp — mirrors brand-tokens.css --ss-display-*.
        "display-xs": "18px",
        "display-sm": "22px",
        "display-md": "26px",
        "display-lg": "32px",
        "display-xl": "42px",
      },
      borderRadius: {
        card: "20px",
        pill: "999px",
      },
      maxWidth: {
        // Mobile-first: design at 390px, max out around tablet width.
        app: "440px",
      },
      boxShadow: {
        card: "0 1px 0 rgb(243 220 217 / 0.04), 0 10px 28px -18px rgb(0 0 0 / 0.42)",
      },
    },
  },
  plugins: [],
};
export default config;
