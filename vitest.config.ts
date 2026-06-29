import { defineConfig } from "vitest/config";

/**
 * Canonical vitest config for the ai-starter standard.
 *
 * Tests run in plain Node (no browser/DOM). Coverage uses the v8 provider.
 *
 * The coverage thresholds below are the *lever* the standard gives you: scope
 * `include` to your safety-critical module(s) and switch the thresholds on once
 * that code exists. They ship commented-out so a freshly-copied template is
 * green from the first commit — leanness over a coverage number you haven't
 * earned yet. (Pattern lifted from relay's core-coverage gate.)
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["dist/**", "build/**", "scripts/**", "tests/**", "**/*.config.*", "**/*.d.ts"],
      // Turn these on for your core/safety module once it exists:
      // include: ["src/core/**/*.ts"],
      // thresholds: { lines: 90, functions: 90, branches: 85 },
    },
  },
});
