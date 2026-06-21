import { test, expect } from "bun:test";
import { loadConfig } from "../src/config";

const base = {
  TELEGRAM_BOT_TOKEN: "tok",
  ALLOWED_USER_IDS: "111,222",
  ANTHROPIC_API_KEY: "sk-test",
};

test("parses csv user ids and applies defaults", () => {
  const cfg = loadConfig(base);
  expect(cfg.allowedUserIds).toEqual([111, 222]);
  expect(cfg.locationPlz).toBe(30459);
  expect(cfg.llmModel).toBe("claude-haiku-4-5");
  expect(cfg.proxyMode).toBe("none");
});

test("throws when a required secret is missing", () => {
  expect(() => loadConfig({ ALLOWED_USER_IDS: "1" })).toThrow();
});

test("applies Phase 2 defaults: whitelist, coverage, digest limit", () => {
  const cfg = loadConfig(base);
  expect(cfg.storeWhitelist).toEqual([
    "lidl", "penny", "kaufland", "edeka", "dm", "aldi", "netto", "rewe",
  ]);
  expect(cfg.offerCoverageMin).toBe(0.7);
  expect(cfg.digestLimit).toBe(5);
});

test("parses a custom STORE_WHITELIST and rejects unknown store keys", () => {
  const cfg = loadConfig({ ...base, STORE_WHITELIST: "lidl, aldi , rewe" });
  expect(cfg.storeWhitelist).toEqual(["lidl", "aldi", "rewe"]);
  expect(() => loadConfig({ ...base, STORE_WHITELIST: "lidl,tesco" })).toThrow();
});

test("parses custom coverage and digest limit", () => {
  const cfg = loadConfig({ ...base, OFFER_COVERAGE_MIN: "0.5", DIGEST_LIMIT: "3" });
  expect(cfg.offerCoverageMin).toBe(0.5);
  expect(cfg.digestLimit).toBe(3);
});
