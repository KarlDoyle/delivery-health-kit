import { readFileSync } from "node:fs";
import { type DoraScenarioFixture, runDoraScenarioMatrix } from "../src/eval/dora-scenarios.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/scenarios/dora-sensitivity.json", import.meta.url), "utf8"),
) as DoraScenarioFixture;
const rows = runDoraScenarioMatrix(fixture);

console.log("Baseline synthetic DORA scenarios");
console.log(`As of: ${fixture.asOf}`);
console.log(`Coverage: ${fixture.coverageStart} → ${fixture.coverageEnd}`);
console.log(
  "Fictional records; compare calculation assumptions, not real-world team performance.\n",
);
console.log(
  "days | deploys | deploys/day | lead h | CFR proxy | CFR with incidents | basis | rework | recovery median/p90 min",
);
console.log(
  "-----|---------|-------------|--------|-----------|-------------------|-------|--------|----------------------",
);
for (const row of rows) {
  const recovery =
    row.recoveryMedianMinutes === null
      ? "no linked incident"
      : `${row.recoveryMedianMinutes}/${row.recoveryP90Minutes}`;
  console.log(
    `${String(row.periodDays).padStart(4)} | ${String(row.deploys).padStart(7)} | ${row.deploymentFrequencyPerDay.toFixed(2).padStart(11)} | ${row.leadTimeHours.toFixed(1).padStart(6)} | ${`${row.cfrProxyPct.toFixed(1)}%`.padStart(9)} | ${`${row.cfrWithIncidentsPct.toFixed(1)}%`.padStart(17)} | ${row.cfrWithIncidentsBasis.padEnd(15)} | ${`${row.reworkRatePct.toFixed(1)}%`.padStart(6)} | ${recovery}`,
  );
}
