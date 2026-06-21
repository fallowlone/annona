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
