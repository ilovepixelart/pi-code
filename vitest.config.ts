import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // lcov feeds SonarQube (see .github/workflows/pr-check.yaml); text is for local runs.
      reporter: ['text', 'lcov'],
      include: ['extensions/**/*.ts'],
      exclude: ['tests/**'],
    },
  },
})
