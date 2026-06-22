import { test, expect, spyOn } from "bun:test";
import { formatLog, errInfo, log, setLogLevel } from "../src/log";

test("formatLog emits JSON with level, msg, fields and an ISO timestamp", () => {
  const rec = JSON.parse(formatLog("info", "started", { userId: 7 }));
  expect(rec.level).toBe("info");
  expect(rec.msg).toBe("started");
  expect(rec.userId).toBe(7);
  expect(typeof rec.ts).toBe("string");
  expect(() => new Date(rec.ts).toISOString()).not.toThrow();
});

test("errInfo summarizes an Error to name + message only (no extra fields leak)", () => {
  const e = new Error("rate limited");
  (e as unknown as { requestBody: string }).requestBody = "SECRET PROMPT with dish name";
  const info = errInfo(e);
  expect(info).toEqual({ err: "Error", msg: "rate limited" });
  expect(JSON.stringify(info)).not.toContain("SECRET PROMPT");
});

test("errInfo handles non-Error values", () => {
  expect(errInfo("boom")).toEqual({ err: "UnknownError", msg: "boom" });
});

test("log respects the minimum level", () => {
  setLogLevel("warn");
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  log.info("quiet");
  log.warn("loud");
  expect(out).not.toHaveBeenCalled(); // info suppressed at level warn
  expect(err).toHaveBeenCalledTimes(1); // warn emitted
  out.mockRestore();
  err.mockRestore();
  setLogLevel("info");
});
