import { test, expect } from "bun:test";
import { createFetcher } from "../src/net/fetcher";

function fakeFetch(sequence: Array<{ status: number; body: string }>) {
  let i = 0;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    const r = sequence[Math.min(i, sequence.length - 1)]!;
    i++;
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("retries on 429 then succeeds, sending a User-Agent", async () => {
  const { impl, calls } = fakeFetch([
    { status: 429, body: "" },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  const out = await f.getJson<{ ok: boolean }>("https://x.test/a");
  expect(out.ok).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0]?.headers["User-Agent"]).toBeTruthy();
});

test("throws after exhausting retries", async () => {
  const { impl, calls } = fakeFetch([{ status: 503, body: "" }]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  await expect(f.getJson("https://x.test/a", { retries: 2 })).rejects.toThrow();
  expect(calls.length).toBe(3);
});

test("appends query params", async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  await f.getJson("https://x.test/s", { query: { q: "Cola", zipCode: 30459 } });
  expect(calls[0]?.url).toContain("q=Cola");
  expect(calls[0]?.url).toContain("zipCode=30459");
});

test("does not retry on non-retryable status (404)", async () => {
  const { impl, calls } = fakeFetch([{ status: 404, body: "" }]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  await expect(f.getJson("https://x.test/a", { retries: 3 })).rejects.toThrow("HTTP 404");
  expect(calls.length).toBe(1);
});

test("does not retry on 403 (anti-bot block — retrying escalates it)", async () => {
  const { impl, calls } = fakeFetch([{ status: 403, body: "" }]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  await expect(f.getJson("https://x.test/a", { retries: 3 })).rejects.toThrow("HTTP 403");
  expect(calls.length).toBe(1);
});

test("retries network-level throws (ECONNREFUSED) then succeeds", async () => {
  let callCount = 0;
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    callCount++;
    if (callCount === 1) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  const out = await f.getJson<{ ok: boolean }>("https://x.test/a");
  expect(out.ok).toBe(true);
  expect(calls.length).toBe(2);
});

test("getText returns body as string", async () => {
  const { impl } = fakeFetch([{ status: 200, body: "hello world" }]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  const text = await f.getText("https://x.test/t");
  expect(text).toBe("hello world");
});

test("proxy mode 'pool' throws not-configured error", () => {
  expect(() => createFetcher({ proxyMode: "pool" })).toThrow("not configured yet");
});

test("proxy mode 'service' throws not-configured error", () => {
  expect(() => createFetcher({ proxyMode: "service" })).toThrow("not configured yet");
});

test("backoff delays increase exponentially", async () => {
  const delays: number[] = [];
  const sleep = async (ms: number) => { delays.push(ms); };
  const { impl } = fakeFetch([
    { status: 503, body: "" },
    { status: 503, body: "" },
    { status: 200, body: "{}" },
  ]);
  const f = createFetcher({ fetchImpl: impl, sleep });
  await f.getJson("https://x.test/a", { retries: 2 });
  // attempt 0: 2^0 * 250 = 250 base; attempt 1: 2^1 * 250 = 500 base
  expect(delays.length).toBe(2);
  expect(delays[0]).toBeGreaterThanOrEqual(250);
  expect(delays[1]).toBeGreaterThanOrEqual(500);
  // second delay should be larger than first
  expect(delays[1]!).toBeGreaterThan(delays[0]!);
});

test("passes a timeout AbortSignal to the underlying fetch", async () => {
  let sawSignal = false;
  const impl = (async (_url: string, init?: RequestInit) => {
    sawSignal = init?.signal instanceof AbortSignal;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  await f.getJson("https://x.test/a");
  expect(sawSignal).toBe(true);
});

test("times out a hung request and retries instead of hanging forever", async () => {
  let n = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    n++;
    const signal = init?.signal as AbortSignal | undefined;
    if (n === 1) {
      // First request hangs; only the timeout abort can settle it.
      return await new Promise<Response>((_res, rej) => {
        signal?.addEventListener("abort", () =>
          rej(signal.reason ?? new DOMException("aborted", "AbortError"))
        );
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {}, timeoutMs: 20 });
  const out = await f.getJson<{ ok: boolean }>("https://x.test/a");
  expect(out.ok).toBe(true);
  expect(n).toBe(2);
}, 2000);

test("User-Agent is set on every request including retries", async () => {
  const { impl, calls } = fakeFetch([
    { status: 429, body: "" },
    { status: 429, body: "" },
    { status: 200, body: "true" },
  ]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  await f.getJson("https://x.test/a", { retries: 3 });
  expect(calls.every((c) => c.headers["User-Agent"])).toBe(true);
});
