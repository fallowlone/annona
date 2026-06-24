import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeartbeat, isHeartbeatFresh } from "../src/health";

test("heartbeat is fresh within maxAge, stale past it, unhealthy when missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "annona-hb-"));
  const path = join(dir, "heartbeat");
  writeHeartbeat(path, new Date("2026-06-24T12:00:00Z"));

  expect(isHeartbeatFresh(path, 90_000, new Date("2026-06-24T12:01:00Z"))).toBe(true); // 60s ≤ 90s
  expect(isHeartbeatFresh(path, 90_000, new Date("2026-06-24T12:05:00Z"))).toBe(false); // 5min > 90s
  expect(isHeartbeatFresh(join(dir, "missing"), 90_000, new Date())).toBe(false); // no file
});
