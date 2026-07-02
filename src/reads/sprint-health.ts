/**
 * Sprint Health Read — the lead "read" of the Delivery Health Check product.
 *
 * Build principle (locked): **data constant, AI is the flavour.** The numbers,
 * the bands, and the verdict are computed deterministically HERE — same input,
 * same answer, every time. An LLM may later write nicer prose on top, but it is
 * never relied on for the maths or the grade. (Previously the bands/verdict lived
 * only in the prompt; this moves them into code, where they belong.)
 *
 * Formulas + bands are lifted from Karl's own metrics definitions — not invented.
 */

/** Raw sprint figures a buyer pastes from their tracker export. */
export interface SprintInput {
  sprintName?: string;
  /** Points (or stories) committed at sprint start. */
  committed: number;
  /** Total completed by sprint end. */
  completed: number;
  /** Of `completed`, how much was originally-planned work (for execution focus). */
  completedPlannedWork: number;
  /** Work added after the sprint started. */
  addedMidSprint: number;
  /** Committed work not finished (carried into the next sprint). */
  carriedOver: number;
  // --- Full sprint model (optional; ported from the legacy metrics vocabulary) ---
  /** Of `addedMidSprint`, how much was completed (for added completion). */
  addedCompleted?: number;
  /** Planned work removed from the sprint mid-flight. */
  plannedRemoved?: number;
  /** Added work removed again before sprint end. */
  addedRemoved?: number;
}

/** 🟢 / 🟡 / 🔴. */
export type Band = "green" | "amber" | "red";
export type SprintVerdict = "Hero" | "Laser-Focus" | "Solid" | "Chaos";

export interface SprintMetric {
  key: string;
  label: string;
  /** Ratio in [0, ∞); rendered as a percentage. */
  value: number;
  band: Band;
  higherIsBetter: boolean;
}

export interface SprintHealthRead {
  sprintName?: string;
  verdict: SprintVerdict;
  verdictReason: string;
  metrics: SprintMetric[];
  flags: string[];
  fixFirst: string;
}

const EMOJI: Record<Band, string> = { green: "🟢", amber: "🟡", red: "🔴" };

/** Band for a higher-is-better metric: 🟢 ≥90% · 🟡 70–89% · 🔴 <70%. */
function bandHigher(ratio: number): Band {
  if (ratio >= 0.9) return "green";
  if (ratio >= 0.7) return "amber";
  return "red";
}

/** Band for a lower-is-better metric: 🟢 <10% · 🟡 10–25% · 🔴 >25%. */
function bandLower(ratio: number): Band {
  if (ratio < 0.1) return "green";
  if (ratio <= 0.25) return "amber";
  return "red";
}

/** Guard against divide-by-zero; an absent denominator yields 0. */
function safeDiv(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

export function bandEmoji(band: Band): string {
  return EMOJI[band];
}

/**
 * Compute the full, deterministic Sprint Health Read from raw figures.
 * Pure function — no IO, no AI, no clock; snapshot-testable.
 */
export function computeSprintHealth(input: SprintInput): SprintHealthRead {
  const plannedCompletion = safeDiv(input.completed, input.committed);
  const executionFocus = safeDiv(input.completedPlannedWork, input.completed);
  const scopeCreep = safeDiv(input.addedMidSprint, input.committed);
  const carryoverRate = safeDiv(input.carriedOver, input.committed);
  const predictability = 0.4 * plannedCompletion + 0.3 * (1 - carryoverRate) + 0.3 * executionFocus;

  const metrics: SprintMetric[] = [
    {
      key: "completion",
      label: "Planned completion",
      value: plannedCompletion,
      band: bandHigher(plannedCompletion),
      higherIsBetter: true,
    },
    {
      key: "focus",
      label: "Execution focus",
      value: executionFocus,
      band: bandHigher(executionFocus),
      higherIsBetter: true,
    },
    {
      key: "creep",
      label: "Scope creep",
      value: scopeCreep,
      band: bandLower(scopeCreep),
      higherIsBetter: false,
    },
    {
      key: "carryover",
      label: "Carryover rate",
      value: carryoverRate,
      band: bandLower(carryoverRate),
      higherIsBetter: false,
    },
    {
      key: "predictability",
      label: "Predictability index",
      value: predictability,
      band: bandHigher(predictability),
      higherIsBetter: true,
    },
  ];

  // Full sprint model (only when the extra buckets are supplied) — ported from
  // the legacy metrics vocabulary: added completion and the churn index.
  if (input.addedCompleted !== undefined) {
    const addedCompletion = safeDiv(input.addedCompleted, input.addedMidSprint);
    metrics.push({
      key: "addedCompletion",
      label: "Added-work completion",
      value: addedCompletion,
      band: bandHigher(addedCompletion),
      higherIsBetter: true,
    });
  }
  if (input.plannedRemoved !== undefined || input.addedRemoved !== undefined) {
    // Churn = everything that moved (added in, planned out, added out) over the
    // sprint's total scope (committed + added), per the legacy definition.
    const churn = safeDiv(
      input.addedMidSprint + (input.plannedRemoved ?? 0) + (input.addedRemoved ?? 0),
      input.committed + input.addedMidSprint,
    );
    metrics.push({
      key: "churn",
      label: "Churn index",
      value: churn,
      band: bandLower(churn),
      higherIsBetter: false,
    });
  }

  const band = (key: string): Band => metrics.find((m) => m.key === key)?.band ?? "red";

  const { verdict, verdictReason } = nameSprint(band, carryoverRate);
  const flags = buildFlags(metrics);
  const fixFirst = pickFixFirst(metrics);

  return { sprintName: input.sprintName, verdict, verdictReason, metrics, flags, fixFirst };
}

/** The one-word verdict + a plain sentence. Order matters: Chaos wins first. */
function nameSprint(
  band: (key: string) => Band,
  carryoverRate: number,
): { verdict: SprintVerdict; verdictReason: string } {
  const red = (k: string) => band(k) === "red";
  const green = (k: string) => band(k) === "green";

  if (red("completion") || red("creep") || red("carryover")) {
    return {
      verdict: "Chaos",
      verdictReason: "the plan didn't hold — completion, scope or carryover went red.",
    };
  }
  if (green("completion") && carryoverRate <= 0.1) {
    return {
      verdict: "Hero",
      verdictReason: "the team committed and delivered — high completion with little spillover.",
    };
  }
  if (green("focus") && green("creep")) {
    return {
      verdict: "Laser-Focus",
      verdictReason: "the team worked the plan — high focus with scope held steady.",
    };
  }
  return {
    verdict: "Solid",
    verdictReason: "a healthy sprint — mostly on-target with nothing in the red.",
  };
}

/** 2–3 plain-English concerns with the "so what", drawn from the worst bands. */
function buildFlags(metrics: SprintMetric[]): string[] {
  const pct = (m: SprintMetric) => `${Math.round(m.value * 100)}%`;
  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m])) as Record<string, SprintMetric>;
  const flags: string[] = [];

  const creep = byKey.creep;
  const carry = byKey.carryover;
  const completion = byKey.completion;
  const focus = byKey.focus;

  if (creep && creep.band !== "green") {
    flags.push(
      `${pct(creep)} of the work was added mid-sprint — the plan isn't protected, so estimates will keep slipping.`,
    );
  }
  if (carry && carry.band !== "green") {
    flags.push(
      `${pct(carry)} of committed work carried over — the sprint is over-committed or getting interrupted.`,
    );
  }
  if (completion && completion.band !== "green") {
    flags.push(
      `Only ${pct(completion)} of committed work landed — commitments are running ahead of capacity.`,
    );
  }
  if (focus && focus.band !== "green" && flags.length < 3) {
    flags.push(
      `Just ${pct(focus)} of delivered work was planned — a lot of effort went to unplanned work.`,
    );
  }
  if (flags.length === 0) {
    flags.push("No material concerns — every dimension is on target. Keep the cadence.");
  }
  return flags.slice(0, 3);
}

/** The single highest-leverage action for next sprint, from the worst dimension. */
function pickFixFirst(metrics: SprintMetric[]): string {
  const reds = metrics.filter((m) => m.band === "red");
  const ambers = metrics.filter((m) => m.band === "amber");
  const worst = reds[0] ?? ambers[0];
  if (!worst) return "Hold the line — repeat what worked and keep tracking the trend.";

  switch (worst.key) {
    case "creep":
      return "Protect the sprint: new work swaps out something, it never stacks on top.";
    case "carryover":
      return "Right-size the commitment — pull in less, or shield the team from interruptions.";
    case "completion":
      return "Commit to what the team can actually finish; under-commit and beat it.";
    case "focus":
      return "Route unplanned work through a single front door (on-call) so the plan stays the plan.";
    default:
      return "Tighten estimates so predictability climbs next sprint.";
  }
}

// --- Multi-sprint trend (ported from the legacy metrics hero/chaos/laser logic) ---

export interface SprintTrend {
  perSprint: SprintHealthRead[];
  /** Highest planned completion with carryover ≤10% (tie → first); null if none qualify. */
  heroIndex: number | null;
  /** Highest scope creep (tie → first). */
  chaosIndex: number | null;
  /** Highest execution focus (tie → first). */
  laserFocusIndex: number | null;
}

function argmax(values: number[]): number | null {
  let bestIdx: number | null = null;
  let bestVal = Number.NEGATIVE_INFINITY;
  values.forEach((v, i) => {
    if (v > bestVal) {
      bestVal = v;
      bestIdx = i;
    }
  });
  return bestIdx;
}

/**
 * Compare a run of sprints and name the standouts. Deterministic, like
 * everything else here: same inputs, same answer.
 */
export function computeSprintTrend(inputs: SprintInput[]): SprintTrend {
  const perSprint = inputs.map(computeSprintHealth);
  if (inputs.length === 0) {
    return { perSprint, heroIndex: null, chaosIndex: null, laserFocusIndex: null };
  }

  const completion = inputs.map((i) => safeDiv(i.completed, i.committed));
  const creep = inputs.map((i) => safeDiv(i.addedMidSprint, i.committed));
  const focus = inputs.map((i) => safeDiv(i.completedPlannedWork, i.completed));
  const carryover = inputs.map((i) => safeDiv(i.carriedOver, i.committed));

  // Hero: best completion among sprints that also kept carryover ≤10%.
  const heroCandidates = completion.map((c, i) =>
    (carryover[i] ?? 1) <= 0.1 ? c : Number.NEGATIVE_INFINITY,
  );
  const heroIndex = heroCandidates.some((c) => c !== Number.NEGATIVE_INFINITY)
    ? argmax(heroCandidates)
    : null;

  // Standout callouts require the standout to actually stand out: a clean run
  // of sprints gets no "most chaotic", and only a genuinely-focused sprint
  // (green band) earns "laser focus" — otherwise every run names both.
  const maxCreep = Math.max(...creep);
  const maxFocus = Math.max(...focus);

  return {
    perSprint,
    heroIndex,
    chaosIndex: maxCreep >= 0.1 ? argmax(creep) : null,
    laserFocusIndex: maxFocus >= 0.9 ? argmax(focus) : null,
  };
}

/** Render the multi-sprint trend as one-screen Markdown. */
export function renderSprintTrendMarkdown(trend: SprintTrend): string {
  const lines: string[] = ["# Sprint Trend", ""];
  if (trend.perSprint.length === 0) {
    return `${lines.join("\n")}\nNo sprints supplied.\n`;
  }
  lines.push("| Sprint | Verdict | Completion | Creep | Carryover | Predictability |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  trend.perSprint.forEach((r, i) => {
    const get = (key: string): string => {
      const m = r.metrics.find((x) => x.key === key);
      return m ? `${Math.round(m.value * 100)}% ${bandEmoji(m.band)}` : "—";
    };
    const name = r.sprintName ?? `Sprint ${i + 1}`;
    lines.push(
      `| ${name} | ${r.verdict} | ${get("completion")} | ${get("creep")} | ${get("carryover")} | ${get("predictability")} |`,
    );
  });
  const nameAt = (idx: number | null): string | null => {
    if (idx === null) return null;
    return trend.perSprint[idx]?.sprintName ?? `Sprint ${idx + 1}`;
  };
  const callouts: string[] = [];
  const hero = nameAt(trend.heroIndex);
  const chaos = nameAt(trend.chaosIndex);
  const laser = nameAt(trend.laserFocusIndex);
  if (hero) callouts.push(`**Hero sprint:** ${hero} — delivered the plan with little spillover.`);
  if (laser)
    callouts.push(`**Laser focus:** ${laser} — highest share of delivered work that was planned.`);
  if (chaos) callouts.push(`**Most chaotic:** ${chaos} — most mid-sprint scope added.`);
  if (callouts.length) lines.push("", ...callouts);
  return `${lines.join("\n")}\n`;
}

/** Render the read as the canonical one-screen Markdown output. */
export function renderSprintHealthMarkdown(read: SprintHealthRead): string {
  const title = read.sprintName ? `Sprint Health — ${read.sprintName}` : "Sprint Health Read";
  const lines: string[] = [`# ${title}`, ""];
  lines.push(`## Verdict: ${read.verdict}`, "", read.verdictReason, "");
  lines.push("## Scorecard", "", "| Metric | Value | |", "| --- | --- | --- |");
  for (const m of read.metrics) {
    lines.push(`| ${m.label} | ${Math.round(m.value * 100)}% | ${bandEmoji(m.band)} |`);
  }
  lines.push("", "## Flags", "");
  for (const f of read.flags) lines.push(`- ${f}`);
  lines.push("", "## Fix first", "", read.fixFirst, "");
  return `${lines.join("\n")}\n`;
}
