// Minimal structured logger: one JSON line per record, level-filtered. No deps.
// Errors are summarized via `errInfo` so error bodies (e.g. an LLM request with
// the user's prompt) never get dumped into logs.

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function parseLevel(raw: string | undefined): LogLevel {
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

let minLevel: LogLevel = parseLevel(Bun.env.LOG_LEVEL);

/** Override the minimum level (env `LOG_LEVEL` sets the default). */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** Pure: render a structured log record as a single JSON line. */
export function formatLog(level: LogLevel, msg: string, fields?: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
}

/** Safe error summary — name + message only, never the full object/body. */
export function errInfo(e: unknown): { err: string; msg: string } {
  if (e instanceof Error) return { err: e.name, msg: e.message };
  return { err: "UnknownError", msg: String(e) };
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (RANK[level] < RANK[minLevel]) return;
  const line = formatLog(level, msg, fields);
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
