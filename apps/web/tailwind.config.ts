import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#1d4ed8', soft: '#eff4ff' },
      },
    },
  },
  plugins: [],
};
export default config;
