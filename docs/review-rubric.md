# Review Rubric (v1)

This is the **human-owned bar** the standing reviewer judges a change against.
It is the spec for "is this actually done and honest?" — not a style guide.

## Ownership guardrail (read this first)

- This rubric changes **only by a deliberate human commit** to this file. It is
  versioned (see the version below); a change is a reviewable diff like any other.
- The automated reviewer (`scripts/review.mjs`) **reads** this file and scores
  against it. It may *suggest* additions or wording changes in its output, but it
  **never edits this file itself**. No self-amending rubric.
- A version bump (e.g. v1 → v2) is the human signal that the bar moved. Record
  why in the commit message.

**Current version: `v1`** (bump this line when the dimensions change.)

## Dimensions

Each dimension is scored `0–5` (5 = fully met, 0 = absent/violated). The keys in
parentheses are the machine identifiers the runner expects back from the model.

1. **Claims = reality** (`claims_vs_reality`)
   Every claim in the change's description, comments, and docs is backed by the
   diff. No "added validation" without validation; no "handles X" without the
   code path for X. The README/claim equals the code.

2. **Tests are real, not theatre** (`tests_real`)
   New behaviour has tests that would actually fail if the behaviour broke. No
   asserting on mocks of the thing under test, no `expect(true).toBe(true)`, no
   tests that never execute the new code path. Absence of tests for new behaviour
   is a low score.

3. **Security** (`security`)
   No injection, no unvalidated input reaching a dangerous sink, no
   auth/authz regressions, no new network calls to untrusted destinations, no
   secrets-in-logs. Input is validated before it is used.

4. **No secrets** (`no_secrets`)
   No API keys, tokens, private keys, or real `.env` values committed. Only
   placeholder `.env.example`. (The deterministic secret-scan test is the
   backstop; this dimension catches shapes the scanner can miss.)

5. **Spec adherence** (`spec_adherence`)
   The change does **what was asked** — every acceptance criterion met, none
   silently dropped. Judge against the ask, not against how you'd have built it.
   If no spec was provided, derive the criteria a reasonable reviewer would hold
   it to and say so.

6. **Honest docs** (`honest_docs`)
   Docs and comments describe what the code does *now*, including its limits and
   caveats. No aspirational documentation written as if already true; known gaps
   are stated, not hidden.

## How the verdict is derived

- The reviewer returns a 0–5 score per dimension and a single
  `VERDICT: ACCEPT | REJECT`.
- **ACCEPT** requires every dimension to clear the bar. There is no partial
  credit and no rounding up: if one dimension is unmet, the verdict is REJECT
  with that dimension cited as the blocking reason.
- The reviewer is **advisory**: it recommends, a human makes the final merge
  call. See `.claude/agents/reviewer.md` for the reviewer persona.
