import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Write the current time (epoch ms) to `path` as a liveness heartbeat. */
export function writeHeartbeat(path: string, now: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(now.getTime()));
}

/**
 * True if the heartbeat at `path` was written no more than `maxAgeMs` before
 * `now`. A missing/unreadable/garbage heartbeat counts as unhealthy — the bot
 * writes one on a timer, so a stale file means the event loop has wedged.
 */
export function isHeartbeatFresh(path: string, maxAgeMs: number, now: Date): boolean {
  try {
    const ts = Number(readFileSync(path, "utf8").trim());
    if (!Number.isFinite(ts)) return false;
    return now.getTime() - ts <= maxAgeMs;
  } catch {
    return false;
  }
}
