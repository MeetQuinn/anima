import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'src': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  base: '/',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Forward all /api/* requests to the Anima backend (default port 4174).
      // Without this, dev-mode fetches hit the Vite server and get back HTML,
      // producing "Unexpected token '<', '<!doctype…' is not valid JSON".
      '/api': {
        target: process.env['VITE_API_TARGET'] ?? 'http://localhost:4174',
        changeOrigin: true,
      },
      '/kb/raw': {
        target: process.env['VITE_API_TARGET'] ?? 'http://localhost:4174',
        changeOrigin: true,
      },
    },
  },
})
