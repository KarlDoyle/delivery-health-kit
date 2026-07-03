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
      exclude: [
        "dist/**",
        "build/**",
        "scripts/**",
        "tests/**",
        "**/*.config.*",
        "**/*.d.ts",
        ".claude/**",
      ],
      // Ratchet, not a stretch goal. Set at/just-below the coverage measured on
      // 2026-07-02 (stmts 74.95 / branch 80.26 / funcs 78.48 / lines 74.95) so the
      // repo is green now and coverage can only go up. Raise these as you add
      // tests; never lower them. Enforced in CI via `pnpm test` (vitest run
      // --coverage). See ai-starter playbook/testing-and-coverage.md.
      thresholds: {
        statements: 73,
        branches: 78,
        functions: 76,
        lines: 73,
      },
    },
  },
});
