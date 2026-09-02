import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Host-env quarantine + per-test env snapshot: the suite runs inside
    // Claude Code / pi subagents whose env carries variables the source reads.
    setupFiles: ['tests/setup.ts'],
    // A hang detector, not a budget: tests spawn real git and shell processes,
    // and a loaded Windows runner has pushed an 88ms-local test past the 5s default.
    testTimeout: 20_000,
    // Mock hygiene is enforced globally so no test depends on a neighbor's spies
    // or stubbed env surviving; shuffle probes order-independence with a fresh
    // seed on every run.
    restoreMocks: true,
    mockReset: true,
    unstubEnvs: true,
    sequence: { shuffle: true },
    coverage: {
      provider: 'v8',
      // lcov feeds SonarQube (see .github/workflows/pr-check.yaml); text is for local runs.
      reporter: ['text', 'lcov'],
      include: ['extensions/**/*.ts'],
      exclude: ['tests/**'],
      // A floor, not a ratchet: fails the run if coverage regresses below today's
      // levels (96.2/89.9/95.1/97.8 at adoption).
      thresholds: { statements: 96, branches: 89, functions: 94, lines: 97 },
    },
  },
})
