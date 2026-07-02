# CLAUDE.md — Delivery Health Kit

**Canonical agent instructions live in [AGENTS.md](AGENTS.md)** — read that
first (architecture, golden rules, gates, fixture conventions). `STATE.md`
holds the build record and staged decisions.

Quick orientation: one CLI — `dhk report` (delivery, DX Core 4) + `dhk digest`
(reliability) — local-first, team-level only, always demos fully offline
(`pnpm dhk demo`). Zero runtime dependencies. Gates:
`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm size && pnpm e2e`.
