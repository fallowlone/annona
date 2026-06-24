const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

export type ReqOpts = {
  headers?: Record<string, string>;
  query?: Record<string, string | number>;
  retries?: number;
};

export interface Fetcher {
  getJson<T>(url: string, opts?: ReqOpts): Promise<T>;
  getText(url: string, opts?: ReqOpts): Promise<string>;
}

const RETRYABLE = new Set([403, 408, 429, 500, 502, 503, 504]);

// A request that opens a TCP connection but never responds would otherwise
// hang the await forever (never entering the retry loop). Bound every attempt.
const DEFAULT_TIMEOUT_MS = 10_000;

export function createFetcher(opts?: {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  proxyMode?: "none" | "pool" | "service";
  timeoutMs?: number;
}): Fetcher {
  const doFetch = opts?.fetchImpl ?? fetch;
  const sleep = opts?.sleep ?? ((ms: number) => Bun.sleep(ms));
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mode = opts?.proxyMode ?? "none";
  if (mode !== "none") throw new Error(`proxy mode '${mode}' not configured yet`);

  let uaIdx = 0;
  const nextUa = (): string => USER_AGENTS[uaIdx++ % USER_AGENTS.length] ?? USER_AGENTS[0]!;

  function buildUrl(url: string, query?: ReqOpts["query"]): string {
    if (!query) return url;
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async function request(url: string, reqOpts?: ReqOpts): Promise<Response> {
    const retries = reqOpts?.retries ?? 3;
    const full = buildUrl(url, reqOpts?.query);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(full, {
          headers: { "User-Agent": nextUa(), Accept: "application/json", ...(reqOpts?.headers ?? {}) },
          // A timeout abort surfaces as an AbortError/TimeoutError, which (not
          // being an "HTTP " error) falls through to the network-retry branch.
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (RETRYABLE.has(res.status)) {
          lastErr = new Error(`HTTP ${res.status}`);
          await sleep(Math.pow(2, attempt) * 250 + Math.random() * 150);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`); // permanent client error — do not retry
        return res;
      } catch (e) {
        // Permanent HTTP errors (thrown just above) must not be retried.
        if (e instanceof Error && e.message.startsWith("HTTP ")) throw e;
        // Genuine network-level failure (DNS / connection refused) — retry with backoff.
        lastErr = e;
        await sleep(Math.pow(2, attempt) * 250 + Math.random() * 150);
      }
    }
    throw new Error(`request failed for ${url}: ${String(lastErr)}`);
  }

  return {
    async getJson<T>(url: string, o?: ReqOpts): Promise<T> {
      return (await (await request(url, o)).json()) as T;
    },
    async getText(url: string, o?: ReqOpts): Promise<string> {
      return (await request(url, o)).text();
    },
  };
}
