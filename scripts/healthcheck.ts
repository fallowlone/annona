// Docker HEALTHCHECK entrypoint: exit 0 if the bot's heartbeat is fresh, else 1.
// The bot rewrites the heartbeat every 30s; allow ~3 missed ticks before failing.
import { isHeartbeatFresh } from "../src/health";

const MAX_AGE_MS = 90_000;
const path = Bun.env.ANNONA_HEARTBEAT ?? "data/heartbeat";
process.exit(isHeartbeatFresh(path, MAX_AGE_MS, new Date()) ? 0 : 1);
