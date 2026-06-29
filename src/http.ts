import type { ILogger } from "./logger.js";

/**
 * fetch() with retry + timeout. Exponential backoff (1s, 2s, 4s) on 5xx and
 * network errors; fails fast on 4xx and timeouts.
 *
 * Reused from consolidation/_extracted_capabilities/fetch-with-retry, trimmed to
 * the project's ILogger. Only the live source fetchers use this; the offline
 * path never touches the network.
 */
export interface FetchWithRetryOptions {
  maxRetries?: number;
  timeoutMs?: number;
  logger?: ILogger;
  fetch?: typeof globalThis.fetch;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { maxRetries = 3, timeoutMs = 30000, logger, fetch: fetchFn = globalThis.fetch } = options;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      logger?.debug(`fetch ${url} (attempt ${attempt}/${maxRetries})`);
      const response = await fetchFn(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok) return response;

      if (response.status >= 400 && response.status < 500) {
        // Client error — retrying won't help.
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      // 5xx — retry.
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      logger?.warn(`server error from ${url}, will retry (${response.status})`);
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      if (error instanceof Error && error.message.startsWith("HTTP 4")) throw error;
      lastError = error as Error;
      logger?.warn(`network error fetching ${url}, will retry`, {
        error: (error as Error).message,
      });
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }

  const finalError = lastError ?? new Error(`Failed to fetch ${url} after ${maxRetries} attempts`);
  logger?.error(`all retries exhausted for ${url}`, finalError);
  throw finalError;
}
