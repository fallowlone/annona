import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase } from "../src/db/backup";

test("backupDatabase writes a timestamped, queryable snapshot of the source db", () => {
  const dir = mkdtempSync(join(tmpdir(), "annona-bk-"));
  const src = join(dir, "src.db");
  const seed = new Database(src);
  seed.run("CREATE TABLE t(x)");
  seed.run("INSERT INTO t(x) VALUES(42)");
  seed.close();

  const dest = backupDatabase(src, join(dir, "backups"), new Date("2026-06-24T03:00:00Z"));

  expect(dest).toContain("annona-2026-06-24T03-00-00");
  const bk = new Database(dest, { readonly: true });
  const row = bk.query("SELECT x FROM t").get() as { x: number };
  bk.close();
  expect(row.x).toBe(42);
});
