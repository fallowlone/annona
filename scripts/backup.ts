// CLI: snapshot the SQLite DB to data/backups/annona-<ts>.db.
// Run on a host cron, e.g. daily at 03:00:
//   0 3 * * * cd ~/annona && docker compose run --rm annona bun run scripts/backup.ts
import { backupDatabase } from "../src/db/backup";
import { log } from "../src/log";

const src = Bun.env.ANNONA_DB ?? "data/annona.db";
const dest = backupDatabase(src, "data/backups", new Date());
log.info("backup_written", { src, dest });
