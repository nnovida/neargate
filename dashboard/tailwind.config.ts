import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0A0E14',
        panel: '#0E141D',
        panel2: '#131B28',
        line: 'rgba(255,255,255,0.08)',
        accent: {
          DEFAULT: '#FF3B30',
          dim: '#B3231B',
          soft: 'rgba(255,59,48,0.12)',
        },
        mut: '#8B93A5',
        ok: '#3ECF8E',
        warn: '#F5B83D',
      },
      fontFamily: {
        display: ['var(--font-display)', 'sans-serif'],
        sans: ['var(--font-body)', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(255,59,48,0.45)' },
          '50%': { opacity: '0.65', boxShadow: '0 0 0 6px rgba(255,59,48,0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
        shimmer: 'shimmer 1.6s linear infinite',
        'fade-up': 'fade-up 0.7s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
      boxShadow: {
        glow: '0 0 32px rgba(255,59,48,0.22)',
        'glow-sm': '0 0 14px rgba(255,59,48,0.30)',
      },
    },
  },
  plugins: [],
};

export default config;
