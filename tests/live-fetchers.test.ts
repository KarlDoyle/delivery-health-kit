import { describe, expect, it } from "vitest";
import { createSilentLogger } from "../src/logger.js";
import { fetchGitHubPRs } from "../src/sources/github.js";
import { fetchPagerDutyIncidents } from "../src/sources/pagerduty.js";

/**
 * The live GitHub and PagerDuty fetchers, driven through an injected `fetch`.
 * Nothing here touches the network: every response is a stub, so the pagination,
 * windowing and partial-failure branches are exercised offline.
 *
 * Failures are stubbed as 404s on purpose — `fetchWithRetry` fails fast on 4xx,
 * so these tests never sit through the exponential backoff a 5xx would trigger.
 */

const logger = createSilentLogger();
const NOW = Date.parse("2026-06-29T12:00:00Z");

/** A fetch stub that fails the test if it is ever called. */
const unreachableFetch: typeof globalThis.fetch = async () => {
  throw new Error("fetch should not have been called");
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const notFound = (): Response => new Response("", { status: 404, statusText: "Not Found" });

const ghConfig = {
  team: "Atlas",
  periodDays: 14,
  repos: ["acme/web"],
  teamMembers: ["dev"],
  token: "t",
};

function listPR(
  n: number,
  mergedAt: string | null,
  updatedAt = mergedAt ?? "2026-06-28T00:00:00Z",
) {
  return {
    number: n,
    title: `PR ${n}`,
    created_at: "2026-06-20T00:00:00Z",
    merged_at: mergedAt,
    updated_at: updatedAt,
    user: { login: "dev" },
  };
}

describe("fetchGitHubPRs", () => {
  it("skips without calling fetch when no token is configured", async () => {
    const out = await fetchGitHubPRs(
      { ...ghConfig, token: "" },
      { logger, fetch: unreachableFetch, now: NOW },
    );
    expect(out).toEqual([]);
  });

  it("normalizes a merged, in-window PR with its detail and first review", async () => {
    const urls: string[] = [];
    const out = await fetchGitHubPRs(ghConfig, {
      logger,
      now: NOW,
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/reviews")) {
          return json([
            { submitted_at: "2026-06-21T00:00:00Z", state: "COMMENTED" },
            { submitted_at: "2026-06-22T00:00:00Z", state: "APPROVED" },
          ]);
        }
        if (/\/pulls\/\d+$/.test(url)) return json({ additions: 30, deletions: 5 });
        return json([listPR(1, "2026-06-25T00:00:00Z")]);
      },
    });

    expect(out).toEqual([
      {
        repo: "web",
        number: 1,
        author: "dev",
        createdAt: "2026-06-20T00:00:00Z",
        mergedAt: "2026-06-25T00:00:00Z",
        additions: 30,
        deletions: 5,
        firstReviewAt: "2026-06-21T00:00:00Z",
        title: "PR 1",
      },
    ]);
    expect(urls[0]).toContain("https://api.github.com/repos/acme/web/pulls?state=closed");
  });

  it("falls back to the configured org for a bare repo name, and to 'unknown' without one", async () => {
    const seen: string[] = [];
    const capture: typeof globalThis.fetch = async (input) => {
      seen.push(String(input));
      return json([]);
    };

    await fetchGitHubPRs(
      { ...ghConfig, repos: ["web"], org: "acme" },
      { logger, now: NOW, fetch: capture },
    );
    expect(seen[0]).toContain("/repos/acme/web/");

    seen.length = 0;
    await fetchGitHubPRs({ ...ghConfig, repos: ["web"] }, { logger, now: NOW, fetch: capture });
    expect(seen[0]).toContain("/repos/unknown/web/");
  });

  it("skips an unusable repo entry without calling fetch", async () => {
    const out = await fetchGitHubPRs(
      { ...ghConfig, repos: [""] },
      { logger, fetch: unreachableFetch, now: NOW },
    );
    expect(out).toEqual([]);
  });

  it("stops the repo cleanly when the list call fails", async () => {
    const out = await fetchGitHubPRs(ghConfig, { logger, now: NOW, fetch: async () => notFound() });
    expect(out).toEqual([]);
  });

  it("skips unmerged and out-of-window PRs before making any detail call", async () => {
    let detailCalls = 0;
    const out = await fetchGitHubPRs(ghConfig, {
      logger,
      now: NOW,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("?state=closed")) {
          return json([
            listPR(1, null), // never merged
            listPR(2, "2026-01-01T00:00:00Z"), // merged before the window
            listPR(3, "2026-12-01T00:00:00Z"), // merged after `now`
          ]);
        }
        detailCalls++;
        return json({});
      },
    });
    expect(out).toEqual([]);
    expect(detailCalls).toBe(0);
  });

  it("defaults sizes and review time to zero/null when the detail and review calls fail", async () => {
    const out = await fetchGitHubPRs(ghConfig, {
      logger,
      now: NOW,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("?state=closed")) return json([listPR(7, "2026-06-25T00:00:00Z")]);
        return notFound();
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ additions: 0, deletions: 0, firstReviewAt: null });
  });

  it("treats an empty review list as no review", async () => {
    const out = await fetchGitHubPRs(ghConfig, {
      logger,
      now: NOW,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/reviews")) return json([]);
        if (/\/pulls\/\d+$/.test(url)) return json({});
        return json([listPR(8, "2026-06-25T00:00:00Z")]);
      },
    });
    expect(out[0]?.firstReviewAt).toBeNull();
  });

  it("paginates a full page, then stops once a page has aged out of the window", async () => {
    const pages: number[] = [];
    const out = await fetchGitHubPRs(ghConfig, {
      logger,
      now: NOW,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("?state=closed")) {
          const page = Number(new URL(url).searchParams.get("page"));
          pages.push(page);
          if (page === 1) {
            // A full page, all still inside the window → must fetch page 2.
            return json(
              Array.from({ length: 100 }, (_, i) => listPR(i + 1, "2026-06-25T00:00:00Z")),
            );
          }
          // A full page updated long before the window → stop paginating.
          return json(
            Array.from({ length: 100 }, (_, i) => listPR(1000 + i, null, "2026-01-01T00:00:00Z")),
          );
        }
        if (/\/pulls\/\d+$/.test(url)) return json({ additions: 1, deletions: 1 });
        return json([]);
      },
    });
    expect(pages).toEqual([1, 2]);
    expect(out).toHaveLength(100);
  });
});

const pdConfig = { apiKey: "k", periodDays: 14 };

function apiIncident(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `incident ${id}`,
    status: "resolved",
    created_at: "2026-06-25T10:00:00Z",
    acknowledged_at: "2026-06-25T10:10:00Z",
    resolved_at: "2026-06-25T11:00:00Z",
    urgency: "high",
    priority: { name: "P2" },
    html_url: `https://pd.test/${id}`,
    service: { id: "S1", summary: "web" },
    ...overrides,
  };
}

describe("fetchPagerDutyIncidents", () => {
  it("skips without calling fetch when no API key is configured", async () => {
    const out = await fetchPagerDutyIncidents(
      { ...pdConfig, apiKey: "" },
      { logger, fetch: unreachableFetch, now: NOW },
    );
    expect(out).toEqual([]);
  });

  it("normalizes incidents and sends the window, limit and service filter", async () => {
    let seen = "";
    const out = await fetchPagerDutyIncidents(
      { ...pdConfig, serviceIds: ["S1", "S2"] },
      {
        logger,
        now: NOW,
        fetch: async (input) => {
          seen = String(input);
          return json({ incidents: [apiIncident("INC-1")], more: false });
        },
      },
    );

    expect(seen).toContain("https://api.pagerduty.com/incidents");
    expect(seen).toContain("limit=100");
    expect(seen).toContain("service_ids%5B%5D=S1");
    expect(seen).toContain("service_ids%5B%5D=S2");
    expect(seen).toContain("since=2026-06-15T12%3A00%3A00.000Z");
    expect(out).toEqual([
      {
        id: "INC-1",
        title: "incident INC-1",
        status: "resolved",
        createdAt: "2026-06-25T10:00:00Z",
        acknowledgedAt: "2026-06-25T10:10:00Z",
        resolvedAt: "2026-06-25T11:00:00Z",
        urgency: "high",
        severity: "P2",
        service: "web",
        htmlUrl: "https://pd.test/INC-1",
      },
    ]);
  });

  it("honours an alternative API host", async () => {
    let seen = "";
    await fetchPagerDutyIncidents(
      { ...pdConfig, apiHost: "https://api.eu.pagerduty.com" },
      {
        logger,
        now: NOW,
        fetch: async (input) => {
          seen = String(input);
          return json({ more: false });
        },
      },
    );
    expect(seen.startsWith("https://api.eu.pagerduty.com/incidents")).toBe(true);
  });

  it("nulls the optional fields when PagerDuty omits them", async () => {
    const out = await fetchPagerDutyIncidents(pdConfig, {
      logger,
      now: NOW,
      fetch: async () =>
        json({
          incidents: [
            apiIncident("INC-2", {
              acknowledged_at: undefined,
              resolved_at: undefined,
              priority: null,
              status: "triggered",
            }),
          ],
          more: false,
        }),
    });
    expect(out[0]).toMatchObject({
      acknowledgedAt: null,
      resolvedAt: null,
      severity: null,
      status: "triggered",
    });
  });

  it("follows `more` across pages and stops when it is false", async () => {
    const offsets: string[] = [];
    const out = await fetchPagerDutyIncidents(pdConfig, {
      logger,
      now: NOW,
      fetch: async (input) => {
        const offset = new URL(String(input)).searchParams.get("offset") ?? "";
        offsets.push(offset);
        return offset === "0"
          ? json({ incidents: [apiIncident("INC-A")], more: true })
          : json({ incidents: [apiIncident("INC-B")], more: false });
      },
    });
    expect(offsets).toEqual(["0", "100"]);
    expect(out.map((i) => i.id)).toEqual(["INC-A", "INC-B"]);
  });

  it("stops cleanly when a page fails, keeping what it already has", async () => {
    let calls = 0;
    const out = await fetchPagerDutyIncidents(pdConfig, {
      logger,
      now: NOW,
      fetch: async () => {
        calls++;
        return calls === 1 ? json({ incidents: [apiIncident("INC-C")], more: true }) : notFound();
      },
    });
    expect(out.map((i) => i.id)).toEqual(["INC-C"]);
  });
});
