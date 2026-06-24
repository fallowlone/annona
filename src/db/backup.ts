import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

/**
 * Write a consistent snapshot of the SQLite database at `srcPath` into `destDir`
 * and return the backup file path. Uses `VACUUM INTO`, an online backup that is
 * safe to run while the bot is using the DB (WAL mode). The caller passes `now`
 * so the timestamped filename is deterministic/testable.
 */
export function backupDatabase(srcPath: string, destDir: string, now: Date): string {
  mkdirSync(destDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dest = `${destDir}/annona-${stamp}.db`;
  const db = new Database(srcPath);
  try {
    db.run("VACUUM INTO ?", [dest]);
  } finally {
    db.close();
  }
  return dest;
}
