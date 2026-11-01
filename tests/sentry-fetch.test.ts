import { describe, expect, it } from "vitest";
import { fetchSentryIssues } from "../src/sources/sentry.js";

const config = {
  org: "acme",
  authToken: "sentry-test-token",
  host: "https://sentry.example.test",
  periodDays: 14,
};

function link(url: string): string {
  return `<${url}>; rel="next"; results="true"; cursor="next"`;
}

async function runPagination(nextLink: string) {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response("[]", {
      status: 200,
      headers: requests.length === 1 ? { link: nextLink } : {},
    });
  };

  const issues = await fetchSentryIssues(config, { fetch });
  return { issues, requests };
}

describe("Sentry pagination URL validation", () => {
  const endpoint =
    "https://sentry.example.test/api/0/organizations/acme/issues/";

  it("follows a same-origin next link for the same API endpoint", async () => {
    const next = `${endpoint}?cursor=next`;
    const { requests } = await runPagination(link(next));

    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe(next);
    expect(requests[1]!.authorization).toBe("Bearer sentry-test-token");
  });

  it("resolves a relative next link against the current API endpoint", async () => {
    const next = "?cursor=next";
    const { requests } = await runPagination(link(next));

    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]!.url).searchParams.get("cursor")).toBe("next");
    expect(requests[1]!.url).toContain("/api/0/organizations/acme/issues/");
  });

  it.each([
    ["external host", "https://attacker.example.test/api/0/organizations/acme/issues/?cursor=steal"],
    ["different port", "https://sentry.example.test:8443/api/0/organizations/acme/issues/?cursor=steal"],
    ["different API path", "https://sentry.example.test/api/0/organizations/other/issues/?cursor=steal"],
  ])("does not follow a next link with a %s", async (_reason, unsafeUrl) => {
    const { requests, issues } = await runPagination(link(unsafeUrl));

    expect(issues).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.authorization).toBe("Bearer sentry-test-token");
  });

  it("ignores malformed next URLs without making another request", async () => {
    const { requests } = await runPagination(link("http://[::1"));

    expect(requests).toHaveLength(1);
  });

  it("does not paginate when the Link header has no next result", async () => {
    const { requests } = await runPagination(
      '<https://sentry.example.test/api/0/organizations/acme/issues/?cursor=next>; rel="previous"; results="true"',
    );

    expect(requests).toHaveLength(1);
  });
});
