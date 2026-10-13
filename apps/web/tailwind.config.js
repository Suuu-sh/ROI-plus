/** @type {import('tailwindcss').Config} */
const v = (n) => `rgb(var(--${n}) / <alpha-value>)`
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), surface: v('surface'), raised: v('raised'), line: v('line'),
        ink: v('ink'), muted: v('muted'), faint: v('faint'),
        accent: v('accent'), pos: v('pos'), neg: v('neg'), warn: v('warn'),
        horse: v('horse'), boat: v('boat'),
        mark: v('mark'), side: v('side'), 'side-ink': v('side-ink'),
      },
      fontFamily: {
        sans: ['"Zen Kaku Gothic New"', '"Hiragino Sans"', 'system-ui', 'sans-serif'],
        display: ['"Archivo"', '"Zen Kaku Gothic New"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        xl: '8px',
        '2xl': '10px',
      },
    },
  },
  plugins: [],
}
