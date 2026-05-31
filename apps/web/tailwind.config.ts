import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Private-banking-style palette: deep graphite + gold accent.
        ink: {
          50:  '#f7f7f8',
          100: '#eeeef1',
          200: '#d9d9de',
          400: '#8a8a92',
          600: '#55555c',
          800: '#26262b',
          900: '#17171a',
        },
        gold: {
          // Brighter accents added (300 / 400) for the BullionOS-
          // branded chrome — sidebar active state, hero mark gradients,
          // login wordmark. Existing 500/600 stay tuned for the inline
          // "elegant tan" accents already used across forms + buttons.
          //
          // 300/400 (the bright branded accent tier) route through the
          // --brand-accent* CSS vars so a tenant accent override
          // recolors the chrome accents; the fallback hex are today's
          // exact values, so an un-customized deploy is unchanged.
          300: 'var(--brand-accent-strong, #f3d266)',
          400: 'var(--brand-accent, #e7b934)',
          500: '#c9a96a',
          600: '#b08e4a',
        },
        // BullionOS-branded chrome surfaces. Used by AdminLayout's
        // sidebar / header / footer + the login page. Content cards
        // inside the main column keep the existing white/ink-* tones
        // so per-feature pages don't all need a dark-mode pass at once
        // — the dark chrome around light cards is the intentional
        // "branded shell + content surface" look.
        bos: {
          black: '#05060d', // page backdrop
          // sidebar / header / footer chrome — routed through
          // --brand-chrome-bg so a tenant can recolor the shell; the
          // fallback is today's exact night tone.
          night: 'var(--brand-chrome-bg, #0a0d18)',
          line:  'rgba(231,185,52,0.10)', // subtle gold border
          text:  '#c7beab', // warm gray for sidebar copy
          mute:  '#9a907c', // dimmer copy / icons
        },
        // Semantic tints for buy-side (money-out, navy) and sell-side
        // (money-in, green) screens. Kept subtle — the numbers still
        // dominate; the hue just helps operators recognize context at a
        // glance. Invoice PDFs stay monochrome and are unaffected.
        buy: {
          50:  '#e6edf7', // slightly darker than a pastel — reads "navy"
          100: '#d4dff0',
          200: '#a8bddc',
          600: '#1e3a78',
          700: '#152c5e',
        },
        sell: {
          50:  '#e8f3ec', // light hue over a darker-green base
          100: '#d2e7d9',
          200: '#9ecdaf',
          600: '#1f6b3e',
          700: '#175130',
        },
      },
      fontFamily: {
        // `font-sans` routes through --brand-font so a tenant
        // font_family override flows to every Tailwind text utility;
        // the fallback is today's exact Inter stack.
        sans: ['var(--brand-font)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
