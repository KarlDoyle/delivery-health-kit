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
    // Linked git worktrees (e.g. `.cx-m1-5/`, used for parallel branch work)
    // live as ordinary subdirectories of the repo root. Without this exclude,
    // vitest's default test discovery walks into them and re-runs (and
    // double-counts) whatever branch happens to be checked out there.
    exclude: ["**/node_modules/**", "**/.*/**"],
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
        // Any linked worktree checked out as a dot-prefixed subdirectory
        // (e.g. `.cx-m1-5/`) — its whole source tree would otherwise be
        // swept into v8's "all files" collection at 0% coverage, since it's
        // a duplicate checkout the current test run never touches.
        "**/.*/**",
      ],
      // Ratchet, not a stretch goal. Raise these as you add tests; never lower
      // them. Enforced in CI via `pnpm test` (vitest run --coverage). See
      // ai-starter playbook/testing-and-coverage.md.
      //
      // Re-measured 2026-09-19 on @vitest/coverage-v8 5.x. That release counts
      // AST-aware: the branch denominator went 791 → 1077 and the function
      // denominator 176 → 300, because inline ternaries, `??` and default
      // parameters are now counted individually. The same code therefore scored
      // 65.64% branches under the new counter and 82.04% under the old one — a
      // change of unit, not a regression. Rather than move the branch number,
      // the gap was closed with real tests (logger, http retry, the live GitHub
      // and PagerDuty fetchers, and every absent-source rendering branch), so
      // `branches` stays at 78 and the rest ratchet UP to just below the newly
      // measured 85.50 / 78.45 / 88.33 / 84.60.
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 88,
        lines: 84,
      },
    },
  },
});
