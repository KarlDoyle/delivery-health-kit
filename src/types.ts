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

/**
 * How change-failure rate was derived. DORA's definition is "deploys causing
 * degraded service"; without incident data the honest stand-in is reverts.
 * The renderers surface this label so the two are never silently conflated.
 */
export type CfrBasis = "incident-linked" | "revert-proxy";

export interface DoraMetrics {
  deploymentFrequencyPerDay: number;
  leadTimeHours: number;
  changeFailureRatePct: number;
  cfrBasis: CfrBasis;
  /**
   * Rework rate (DORA 2024 stability factor): flagged fix/revert deploys as a
   * share of all deploys. Flag-based only — no file-overlap heuristics.
   */
  reworkRatePct: number;
  totalDeploys: number;
  totalReverts: number;
  totalFixDeploys: number;
  /**
   * Failed-deployment recovery time (DORA 2024 rename of MTTR): incident
   * create→resolve, median + p90. Only present when incident data is connected.
   */
  recoveryTime?: { medianMinutes: number; p90Minutes: number };
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

// --- Reliability (the `dhk digest` half) ---

/** avg / median / p90 of a set of durations, in minutes. */
export interface TimeMetrics {
  avgMinutes: number;
  medianMinutes: number;
  p90Minutes: number;
}

/**
 * PagerDuty incident metrics — team-level only. On-call load is reported per
 * service and by out-of-hours share, never per responder.
 */
export interface PagerDutyMetrics {
  totalIncidents: number;
  active: number;
  resolved: number;
  byUrgency: { high: number; low: number };
  bySeverity: Record<string, number>;
  /** Time to detect: create → acknowledge. */
  ttd: TimeMetrics;
  /** Failed-deployment recovery time basis: create → resolve. */
  ttm: TimeMetrics;
  onCall: {
    byService: Record<string, number>;
    /** Share of incidents created outside configured working hours (0–100). */
    outOfHoursPct: number;
    busiestService: string | null;
  };
}

/** Sentry error-tracking metrics (error-budget context). */
export interface SentryMetrics {
  totalIssues: number;
  /** Issues first seen inside the report window. */
  newIssues: number;
  byProject: Record<string, number>;
  byLevel: { error: number; warning: number; info: number };
}

/** One service's SLO position (from Prometheus or compatible). */
export interface ServiceSlo {
  name: string;
  availabilityPct: number;
  availabilityTargetPct: number;
  meetingAvailability: boolean;
  p95Ms: number;
  p99Ms: number;
  latencyThresholdMs: number;
  meetingLatency: boolean;
  totalRequests: number;
  failedRequests: number;
  /**
   * True when the queries returned no signal (endpoint unreachable, no series).
   * Rendered as "no data" and excluded from attainment — an infrastructure
   * problem must never read as an SLO breach (or a pass).
   */
  noData?: boolean;
}

export interface SloMetrics {
  services: ServiceSlo[];
  /** Share of measurable services meeting both SLOs (0–100); no-data excluded. */
  attainmentPct: number;
}

/** The reliability report (`dhk digest`). Shares the record model with `report`. */
export interface ReliabilityReport {
  generatedAt: string;
  team: string;
  periodDays: number;
  mode: "offline" | "live";
  incidents?: PagerDutyMetrics;
  errors?: SentryMetrics;
  slo?: SloMetrics;
  /** Present when deploys + incidents both exist: the incident-linked CFR. */
  dora?: DoraMetrics;
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
