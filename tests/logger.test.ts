import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/http.js";
import { createLogger, createSilentLogger, Logger } from "../src/logger.js";

/**
 * Logger + fetchWithRetry — the two zero-dependency utilities every live source
 * fetcher leans on. Both were previously exercised only incidentally, so their
 * level filtering and their retry/timeout branches were untested.
 */

/** Capture console.error without letting it reach the test reporter. */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("Logger level filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to info: drops debug, keeps info/warn/error", () => {
    const cap = captureStderr();
    const log = createLogger();
    log.debug("dbg");
    log.info("inf");
    log.warn("wrn");
    log.error("err");
    cap.restore();

    expect(cap.lines.some((l) => l.includes("dbg"))).toBe(false);
    expect(cap.lines.some((l) => l.startsWith("info  inf"))).toBe(true);
    expect(cap.lines.some((l) => l.startsWith("warn  wrn"))).toBe(true);
    expect(cap.lines.some((l) => l.startsWith("error err"))).toBe(true);
  });

  it("at debug level emits every level", () => {
    const cap = captureStderr();
    new Logger("debug").debug("visible");
    cap.restore();
    expect(cap.lines[0]).toBe("debug visible");
  });

  it("at error level suppresses debug, info and warn", () => {
    const cap = captureStderr();
    const log = new Logger("error");
    log.debug("d");
    log.info("i");
    log.warn("w");
    cap.restore();
    expect(cap.lines).toEqual([]);
  });

  it("appends serialised data, and degrades gracefully when it cannot be serialised", () => {
    const cap = captureStderr();
    const log = new Logger("debug");
    log.info("with", { a: 1 });
    log.info("without");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    log.info("cyclic", cyclic);
    cap.restore();

    expect(cap.lines[0]).toBe('info  with {"a":1}');
    expect(cap.lines[1]).toBe("info  without");
    expect(cap.lines[2]).toBe("info  cyclic [unserializable]");
  });

  it("error() prints an Error's message, stringifies a non-Error, and omits nothing", () => {
    const cap = captureStderr();
    const log = new Logger("debug");
    log.error("boom", new Error("the cause"));
    log.error("plain", 42);
    log.error("bare");
    cap.restore();

    expect(cap.lines).toEqual(["error boom", "   the cause", "error plain", "   42", "error bare"]);
  });

  it("the silent logger writes nothing at any level", () => {
    const cap = captureStderr();
    const log = createSilentLogger();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e", new Error("x"));
    cap.restore();
    expect(cap.lines).toEqual([]);
  });
});

describe("fetchWithRetry", () => {
  const logger = createSilentLogger();

  it("returns the first ok response without retrying", async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      "https://example.test/ok",
      {},
      {
        logger,
        fetch: async () => {
          calls++;
          return new Response("hi", { status: 200 });
        },
      },
    );
    expect(await res.text()).toBe("hi");
    expect(calls).toBe(1);
  });

  it("fails fast on a 4xx — no retry", async () => {
    let calls = 0;
    await expect(
      fetchWithRetry(
        "https://example.test/nope",
        {},
        {
          logger,
          fetch: async () => {
            calls++;
            return new Response("", { status: 404, statusText: "Not Found" });
          },
        },
      ),
    ).rejects.toThrow("HTTP 404");
    expect(calls).toBe(1);
  });

  it("retries a 5xx and succeeds on a later attempt", async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      "https://example.test/flaky",
      {},
      {
        logger,
        maxRetries: 2,
        fetch: async () => {
          calls++;
          return calls === 1
            ? new Response("", { status: 503, statusText: "Unavailable" })
            : new Response("ok", { status: 200 });
        },
      },
    );
    expect(await res.text()).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries a network error and rethrows the last one once retries are exhausted", async () => {
    let calls = 0;
    await expect(
      fetchWithRetry(
        "https://example.test/down",
        {},
        {
          logger,
          maxRetries: 2,
          fetch: async () => {
            calls++;
            throw new Error("ECONNREFUSED");
          },
        },
      ),
    ).rejects.toThrow("ECONNREFUSED");
    expect(calls).toBe(2);
  });

  it("converts an aborted request into a timeout error and does not retry", async () => {
    let calls = 0;
    await expect(
      fetchWithRetry(
        "https://example.test/slow",
        {},
        {
          logger,
          timeoutMs: 5,
          fetch: async (_url, init) =>
            new Promise((_resolve, reject) => {
              calls++;
              init?.signal?.addEventListener("abort", () => {
                const e = new Error("aborted");
                e.name = "AbortError";
                reject(e);
              });
            }),
        },
      ),
    ).rejects.toThrow("Request timeout after 5ms");
    expect(calls).toBe(1);
  });
});
