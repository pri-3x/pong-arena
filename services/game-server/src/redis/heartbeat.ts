import { redis } from "./client.js";
import { POD_ID } from "./bus.js";

/**
 * The problem this solves
 * -----------------------
 * A match is simulated by exactly one Pod. If that Pod dies abruptly:
 *   - the player connected to the OTHER Pod is never told; their socket stays
 *     open and state updates simply stop
 *   - the match result is never written to PostgreSQL
 *
 * Both were measured in Phases 5 and 7. Pub/sub is fire-and-forget, so no
 * message announces the death.
 *
 * The fix: the owning Pod writes a short-lived key per room and refreshes it.
 * If the owner dies, the key expires on its own. Every Pod periodically scans
 * for rooms it is waiting on whose owner has gone silent, and finalises them
 * locally - telling its own player the match is over.
 */
const ROOM_KEY = (roomId: string) => `room:${roomId}:alive`;
const TTL_SECONDS = 6;
const BEAT_MS = 2000;

export interface RoomBeat { ownerPod: string; startedAt: number }

/** Called by the Pod that owns a room, every BEAT_MS while the match runs. */
export async function beat(roomId: string, startedAt: number) {
  await redis.set(
    ROOM_KEY(roomId),
    JSON.stringify({ ownerPod: POD_ID, startedAt } satisfies RoomBeat),
    "EX", TTL_SECONDS
  ).catch(() => {});
}

export async function clearBeat(roomId: string) {
  await redis.del(ROOM_KEY(roomId)).catch(() => {});
}

/** Is the owning Pod still alive for this room? */
export async function isRoomAlive(roomId: string): Promise<boolean> {
  try {
    return (await redis.exists(ROOM_KEY(roomId))) === 1;
  } catch {
    // If Redis itself is unreachable we must NOT declare every match dead.
    // Assume alive and let the next sweep decide.
    return true;
  }
}

/**
 * Start both halves: a heartbeat for rooms we own, and a sweep for rooms we are
 * only relaying for.
 */
export function startHeartbeat(opts: {
  ownedRooms: () => Array<{ id: string; startedAt: number }>;
  remoteRooms: () => Array<{ roomId: string }>;
  onOrphaned: (roomId: string) => void;
}) {
  const timer = setInterval(async () => {
    for (const r of opts.ownedRooms()) await beat(r.id, r.startedAt);

    for (const r of opts.remoteRooms()) {
      if (!(await isRoomAlive(r.roomId))) opts.onOrphaned(r.roomId);
    }
  }, BEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}
