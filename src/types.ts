/**
 * Shared model for the consolidated EM report.
 *
 * Each source module produces one of the metric blocks below; `assembleReport`
 * stitches them into a single `DeliveryReport`, and the renderers turn that into
 * Markdown or Slack Block Kit. Keeping one model is the whole point of the
 * consolidation — the three legacy tools each had their own shape.
 */

export type DORAClass = "Elite" | "High" | "Medium" | "Low";

/** Team / scope config. Drives both live fetchers and fixture selection. */
export interface DeliveryConfig {
  team: string;
  periodDays: number;
  repos: string[];
  teamMembers: string[];
  jiraProjectKey?: string;
}

// --- GitHub (PR flow) ---
export interface GitHubMetrics {
  totalMerged: number;
  avgCycleTimeHours: number;
  avgTimeToFirstReviewHours: number;
  avgPRSize: number;
  byRepo: Record<string, number>;
}

// --- DORA ---
export interface DoraMetrics {
  deploymentFrequencyPerDay: number;
  leadTimeHours: number;
  changeFailureRatePct: number;
  totalDeploys: number;
  totalReverts: number;
  periodDays: number;
  classes: {
    deploymentFrequency: DORAClass;
    leadTime: DORAClass;
    changeFailureRate: DORAClass;
  };
}

// --- Jira / Sprint ---
export interface WorkDistribution {
  productDelivery: number;
  bugs: number;
  techDebt: number;
  exploration: number;
  other: number;
}

export interface JiraMetrics {
  sprintName?: string;
  ticketsClosed: number;
  ticketsCreated: number;
  storyPointsCompleted: number;
  leadTime: { avgHours: number; medianHours: number; p90Hours: number };
  workDistribution: WorkDistribution;
  byType: Record<string, number>;
}

// --- Slack support intelligence ---
export interface SupportMetrics {
  totalRequests: number;
  medianFirstResponseMinutes: number | null;
  resolutionRatePct: number;
  unansweredCount: number;
  lateResponseCount: number;
  requesterMix: Record<string, number>;
  topThemes: { theme: string; count: number }[];
  targets: { medianFrtMinutes: number; resolutionRatePct: number };
}

/** The consolidated report. Any block may be absent if its source had no data. */
export interface DeliveryReport {
  generatedAt: string;
  team: string;
  periodDays: number;
  mode: "offline" | "live";
  dora?: DoraMetrics;
  github?: GitHubMetrics;
  jira?: JiraMetrics;
  support?: SupportMetrics;
}

// --- Multi-site scorecard (point at many teams → one comparison view) ---

/** One team's report plus a transparent composite health score, for ranking. */
export interface SiteScore {
  team: string;
  /** 0–100 composite health score (higher = healthier). See `scoreReport`. */
  score: number;
  /** The per-dimension sub-scores that make up `score` (absent ones omitted). */
  parts: Partial<Record<"dora" | "prFlow" | "support", number>>;
  report: DeliveryReport;
}

/** The cross-site view: every team scored and ranked in one scorecard. */
export interface DeliveryScorecard {
  generatedAt: string;
  periodDays: number;
  mode: "offline" | "live";
  /** Sites, ranked healthiest-first. */
  sites: SiteScore[];
}
