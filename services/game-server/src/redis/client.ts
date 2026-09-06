import Redis from "ioredis";

const HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const PORT = Number(process.env.REDIS_PORT ?? 6380);

function make(role: string) {
  const r = new Redis({
    host: HOST,
    port: PORT,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  r.on("error", (e) => console.error(JSON.stringify({ redis: role, error: e.message })));
  return r;
}

/**
 * We need THREE connections, not one.
 *
 * A Redis connection that has run SUBSCRIBE enters subscriber mode and may not
 * issue ordinary commands any more. So the subscriber gets its own connection,
 * and publishing gets another, leaving `redis` free for normal work.
 */
export const redis = make("commands");
export const publisher = make("publisher");
export const subscriber = make("subscriber");

export const redisHost = `${HOST}:${PORT}`;

/**
 * Atomically: take an opponent off the queue, or join the queue if it's empty.
 *
 * Doing this as two commands (RPOP then LPUSH) has a race: two players can both
 * RPOP nothing, then both LPUSH, and end up queued behind each other having
 * never matched. Redis runs a Lua script as a single atomic unit, so no other
 * client can interleave between the RPOP and the LPUSH.
 */
redis.defineCommand("matchOrQueue", {
  numberOfKeys: 1,
  lua: `
    local opponent = redis.call('RPOP', KEYS[1])
    if opponent then return opponent end
    redis.call('LPUSH', KEYS[1], ARGV[1])
    return false
  `,
});

export interface RedisWithMatch extends Redis {
  matchOrQueue(queueKey: string, ticket: string): Promise<string | null>;
}
