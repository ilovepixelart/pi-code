import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Host-env quarantine + per-test env snapshot: the suite runs inside
    // Claude Code / pi subagents whose env carries variables the source reads.
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      // lcov feeds SonarQube (see .github/workflows/pr-check.yaml); text is for local runs.
      reporter: ['text', 'lcov'],
      include: ['extensions/**/*.ts'],
      exclude: ['tests/**'],
    },
  },
})
