import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts so tests do not load the PWA plugin. Tests live in tests/ (outside the tsc -b include).
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], environment: 'node' } })
