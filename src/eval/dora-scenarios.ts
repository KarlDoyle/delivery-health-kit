import { computeDoraMetrics, type DeployEvent } from "../sources/dora.js";
import type { RawIncident } from "../sources/pagerduty.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DoraScenarioFixture {
  asOf: string;
  coverageStart: string;
  coverageEnd: string;
  deploys: DeployEvent[];
  incidents: RawIncident[];
}

export interface DoraScenarioRow {
  periodDays: number;
  deploys: number;
  deploymentFrequencyPerDay: number;
  leadTimeHours: number;
  cfrProxyPct: number;
  cfrWithIncidentsPct: number;
  cfrWithIncidentsBasis: string;
  reworkRatePct: number;
  recoveryMedianMinutes: number | null;
  recoveryP90Minutes: number | null;
}

/**
 * Compare DORA calculations over the same fixed records and date anchor.
 * Every requested period must be covered by the fixture; this prevents a
 * shorter history from being divided by a longer reporting window.
 */
export function runDoraScenarioMatrix(
  fixture: DoraScenarioFixture,
  periods: number[] = [7, 14, 30],
): DoraScenarioRow[] {
  const now = Date.parse(fixture.asOf);
  const coverageStart = Date.parse(fixture.coverageStart);
  const coverageEnd = Date.parse(fixture.coverageEnd);
  if (![now, coverageStart, coverageEnd].every(Number.isFinite)) {
    throw new Error("Scenario fixture needs valid asOf, coverageStart and coverageEnd dates.");
  }
  if (coverageEnd < now) {
    throw new Error("Scenario fixture coverage must extend through its asOf date.");
  }

  return periods.map((periodDays) => {
    if (!Number.isFinite(periodDays) || periodDays <= 0) {
      throw new Error(`Period must be a positive number of days: ${periodDays}`);
    }
    const since = now - periodDays * DAY_MS;
    if (since < coverageStart) {
      throw new Error(
        `${periodDays}-day window starts before fixture coverage (${fixture.coverageStart}).`,
      );
    }

    const proxy = computeDoraMetrics(fixture.deploys, periodDays, { now });
    const incidentsInWindow = fixture.incidents.filter((incident) => {
      const created = Date.parse(incident.createdAt);
      return created >= since && created <= now;
    });
    const withIncidents = computeDoraMetrics(fixture.deploys, periodDays, {
      now,
      incidents: incidentsInWindow,
    });

    return {
      periodDays,
      deploys: proxy.totalDeploys,
      deploymentFrequencyPerDay: proxy.deploymentFrequencyPerDay,
      leadTimeHours: proxy.leadTimeHours,
      cfrProxyPct: proxy.changeFailureRatePct,
      cfrWithIncidentsPct: withIncidents.changeFailureRatePct,
      cfrWithIncidentsBasis: withIncidents.cfrBasis,
      reworkRatePct: proxy.reworkRatePct,
      recoveryMedianMinutes: withIncidents.recoveryTime?.medianMinutes ?? null,
      recoveryP90Minutes: withIncidents.recoveryTime?.p90Minutes ?? null,
    };
  });
}
