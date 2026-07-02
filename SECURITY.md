# Security

## The model

dhk is **local-first by design**: all metric computation happens on your
machine. In offline mode (the default, incl. `dhk demo`) the tool makes **zero
network calls**. In `--live` mode it calls only the APIs you have explicitly
connected (GitHub, Jira, PagerDuty, Sentry, Prometheus, Google Sheets) — your
delivery data is never sent to any other party, and there is no telemetry.

## Credentials

- `dhk connect` stores tokens in `~/.config/dhk/config.json` with **owner-only
  permissions (0600)**; the directory is created 0700.
- Tokens are prompted with echo disabled — they never appear on screen or in
  shell history (unless you pass them as flags, which is supported for CI but
  not recommended interactively).
- Use the narrowest scopes: GitHub `repo` read; PagerDuty read-only;
  Sentry org read; a Sheets token only if you push rows.
- The Sheets path deliberately takes a short-lived OAuth bearer token (e.g.
  `gcloud auth print-access-token`) rather than handling service-account key
  files.

## Guardrails in the repo

- `tests/secret-scan.test.ts` fails the suite if key-shaped strings, real
  tokens, or `.env` values land in the tree; it runs in CI and in the pre-push
  hook.
- Committed fixtures are entirely synthetic (the fictional "Nimbus Labs" org) —
  no real names, repos, incidents, or data, ever.
- Team-level only is product-enforced: no per-person metric exists in the data
  model, so a leaderboard cannot be built from this tool's output.

## Reporting

This repository is currently private/unpublished. Report concerns directly to
the maintainer.
