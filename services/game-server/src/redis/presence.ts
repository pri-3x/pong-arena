import { redis } from "./client.js";
import { POD_ID } from "./bus.js";

const KEY = (pod: string) => `presence:${pod}`;
const TTL_SECONDS = 10;
const REFRESH_MS = 2000;

export interface PodPresence { pod: string; players: number; games: number }

/**
 * Each Pod writes its own small record and refreshes it every 5 seconds with a
 * 15 second expiry. Nothing has to clean up after a crashed Pod: if it stops
 * refreshing, Redis deletes the key on its own. TTL-as-liveness is much simpler
 * and more robust than trying to detect crashes and delete records explicitly.
 */
export function startPresence(sample: () => { players: number; games: number }) {
  const write = async () => {
    const s = sample();
    try {
      await redis
        .multi()
        .hset(KEY(POD_ID), { players: s.players, games: s.games })
        .expire(KEY(POD_ID), TTL_SECONDS)
        .exec();
    } catch { /* Redis will be retried on the next tick */ }
  };
  void write();
  const timer = setInterval(write, REFRESH_MS);
  timer.unref();
  return async () => { clearInterval(timer); await redis.del(KEY(POD_ID)).catch(() => {}); };
}

/**
 * Aggregate every live Pod's record.
 *
 * We use SCAN, not KEYS. KEYS walks the entire keyspace in one blocking
 * operation - on a busy Redis that stalls every other client. SCAN returns a
 * cursor and does the same work in small, interruptible batches.
 */
export async function clusterPresence(): Promise<{ pods: PodPresence[]; players: number; games: number }> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", "presence:*", "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");

  const pods: PodPresence[] = [];
  for (const key of keys) {
    const h = await redis.hgetall(key);
    pods.push({
      pod: key.slice("presence:".length),
      players: Number(h.players ?? 0),
      games: Number(h.games ?? 0),
    });
  }
  pods.sort((a, b) => a.pod.localeCompare(b.pod));
  return {
    pods,
    players: pods.reduce((n, p) => n + p.players, 0),
    games: pods.reduce((n, p) => n + p.games, 0),
  };
}
