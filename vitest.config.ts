import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') }

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['tests/shared/**/*.test.ts', 'tests/main/**/*.test.ts', 'tests/sanity.test.ts'] } },
      { extends: true, test: { name: 'dom', environment: 'jsdom', include: ['tests/renderer/**/*.test.{ts,tsx}'], setupFiles: ['tests/renderer/setup.ts'] } }
    ]
  }
})
