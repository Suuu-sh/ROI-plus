import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.PORT) || 5180, proxy: { '/api': 'http://127.0.0.1:8787' } },
  test: { environment: 'jsdom', globals: false },
})
