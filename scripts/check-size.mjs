#!/usr/bin/env node
// Size ratchet (relay pattern): the built CLI must stay lean. Fails loud if
// the runtime payload bloats past budget so dependency creep can't quietly
// erode the "single tiny tool" promise. Measures shipped .js only — sourcemaps
// and .d.ts are dev artefacts, not what a user runs. Raise the budget
// deliberately, never casually.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BUDGET_KB = 192; // dist/**/*.js total. Measured 2026-07-02: 119 KB.

function jsSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += jsSize(p);
    else if (entry.name.endsWith(".js")) total += statSync(p).size;
  }
  return total;
}

const sizeKb = Math.round(jsSize("dist") / 1024);
if (sizeKb > BUDGET_KB) {
  console.error(`size ratchet: dist JS is ${sizeKb} KB — over the ${BUDGET_KB} KB budget.`);
  process.exit(1);
}
console.log(`size ratchet: dist JS is ${sizeKb} KB (budget ${BUDGET_KB} KB) — ok.`);
