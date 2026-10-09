/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the built assets work at a domain root (Vercel/Netlify)
  // AND under a subpath (GitHub Pages project sites).
  base: './',
  plugins: [react()],
  // Allow access through forwarded/tunneled hosts (e.g. VS Code *.devtunnels.ms).
  // Keep this only for sharing demos; it is not a hardened production setup.
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
