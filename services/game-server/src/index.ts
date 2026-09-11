import Fastify from "fastify";
import websocket from "@fastify/websocket";
import os from "node:os";
import { Arena, type Conn } from "./game/arena.js";
import { startBus, stopBus, POD_ID } from "./redis/bus.js";
import { redis, redisHost } from "./redis/client.js";
import { startPresence, clusterPresence } from "./redis/presence.js";
import { migrate, dbHealthy, pool } from "./db/index.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { recentMatches, matchesForUser, leaderboard } from "./db/matches.js";
import * as metrics from "./metrics.js";
import { verifyToken } from "./auth/token.js";
import * as C from "./game/constants.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(websocket);

// Run migrations before serving traffic. Every replica does this; a Postgres
// advisory lock makes sure only one actually applies them.
const pending = await migrate((m) => app.log.info(m));
app.log.info({ pendingMigrations: pending }, "database ready");

// Record every HTTP request. `routerPath` is the ROUTE PATTERN (/matches),
// not the concrete URL - using the raw URL would create a new time series per
// distinct query string, which is the classic way to blow up a Prometheus
// instance ("high cardinality").
app.addHook("onResponse", async (req, reply) => {
  const route = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? "unmatched";
  if (route === "/metrics") return;                       // do not measure ourselves
  const labels = { method: req.method, route, status: String(reply.statusCode) };
  metrics.httpRequests.inc(labels);
  metrics.httpDuration.observe(labels, reply.elapsedTime / 1000);
});

app.get("/metrics", async (_req, reply) => {
  // Refresh gauges at scrape time rather than keeping them continuously
  // updated: a gauge only has to be correct when it is read.
  metrics.activeGames.set(arena.stats.activeGames);
  metrics.connectedPlayers.set(connections.size);
  try {
    metrics.matchmakingQueue.set(await arena.queueLength());
  } catch { /* Redis unavailable; leave the previous value */ }

  reply.header("content-type", metrics.registry.contentType);
  return metrics.registry.metrics();
});

registerAuthRoutes(app);

const arena = new Arena();
arena.onPersistError = (err, roomId) =>
  app.log.error({ err, roomId }, "failed to record match result");
arena.onOrphanRecovered = (roomId) =>
  app.log.warn({ roomId }, "match owner went away; released the local player");
arena.startWatchdog();

// Route messages arriving from other Pods into this Pod's connections/rooms.
await startBus({
  onPlayerMessage: (m) => arena.onPlayerMessage(m),
  onRoomInput: (m) => arena.onRoomInput(m),
});

// Liveness: "is this process alive?" Deliberately checks NOTHING external.
// If it depended on Postgres, a database blip would make Kubernetes restart
// every healthy game server - turning a small outage into a large one.
app.get("/health", async () => ({ status: "ok" }));

// Readiness: "can this process do useful work?" This one SHOULD check
// dependencies, because the right response to a broken dependency is to stop
// receiving traffic, not to be restarted. Wired to a probe in Phase 11.
let forceUnready = false;

app.get("/ready", async (_req, reply) => {
  if (forceUnready) {
    return reply.code(503).send({ ok: false, reason: "manually marked unready" });
  }
  const [db, redisOk] = [await dbHealthy(), redis.status === "ready"];
  const ok = db && redisOk;
  return reply.code(ok ? 200 : 503).send({ ok, postgres: db, redis: redisOk });
});

/**
 * Test hook: flip this Pod to "not ready" so we can watch Kubernetes pull it
 * out of the Service without killing it. Only enabled when ALLOW_CHAOS is set,
 * which the production manifests do not set.
 */
if (process.env.ALLOW_CHAOS === "true") {
  app.post("/debug/unready", async (req) => {
    forceUnready = (req.query as { on?: string }).on !== "false";
    return { forceUnready };
  });
}

app.get("/whoami", async () => ({
  instance: os.hostname(),
  uptimeSeconds: Math.round(process.uptime()),
  version: process.env.APP_VERSION ?? "v1",
}));

/** Game metrics. Prometheus will scrape a proper version of this in Phase 15. */
app.get("/cluster", async () => await clusterPresence());

app.get("/stats", async () => ({
  instance: os.hostname(),
  ...arena.stats,
  connections: connections.size,
  redis: { host: redisHost, status: redis.status, queueLength: await arena.queueLength().catch(() => -1) },
}));

/** Clamp a caller-supplied limit: never let a client ask for the whole table. */
const clampLimit = (raw: unknown, fallback: number, max: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
};

app.get("/matches", async (req) => {
  const q = req.query as { limit?: string; username?: string };
  const limit = clampLimit(q.limit, 20, 100);
  const matches = q.username
    ? await matchesForUser(q.username, limit)
    : await recentMatches(limit);
  return { matches };
});

app.get("/leaderboard", async (req) => {
  const limit = clampLimit((req.query as { limit?: string }).limit, 20, 100);
  return { leaderboard: await leaderboard(limit) };
});

/** Constants the client needs in order to draw the field at the right scale. */
app.get("/config", async () => ({
  fieldW: C.FIELD_W, fieldH: C.FIELD_H,
  paddleW: C.PADDLE_W, paddleH: C.PADDLE_H, paddleX: C.PADDLE_X,
  ballR: C.BALL_R, winScore: C.WIN_SCORE,
}));

const connections = new Set<Conn>();

const stopPresence = startPresence(() => ({
  players: connections.size,
  games: arena.stats.activeGames,
}));

app.get("/ws", { websocket: true }, (socket) => {
  const send = (msg: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  // Name is provisional until the client sends `join`.
  const conn: Conn = arena.newConn("anonymous", send);
  connections.add(conn);
  send({ t: "hello", instance: POD_ID, playerId: conn.playerId });

  socket.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ t: "error", message: "invalid JSON" });
    }

    switch (msg.t) {
      case "join": {
        if (conn.room || conn.remote) return send({ t: "error", message: "already in a game" });
        // Identity comes from the signed token, never from the client's claim
        // about who it is. This is why the `name` field is gone.
        void (async () => {
          const claims = await verifyToken(typeof msg.token === "string" ? msg.token : undefined);
          if (!claims) return send({ t: "unauthorized", message: "sign in to play" });
          conn.userId = claims.sub;
          conn.name = claims.username;
          try {
            await arena.join(conn);
          } catch (e) {
            app.log.error({ err: e }, "join failed");
            send({ t: "error", message: "matchmaking unavailable" });
          }
        })();
        break;
      }
      case "input": {
        // The ONLY thing a client may influence: its own paddle direction.
        if (!conn.side) return;
        const dir = msg.dir === -1 || msg.dir === 1 ? msg.dir : 0;
        arena.input(conn, dir);
        break;
      }
      case "ping":
        send({ t: "pong", ts: msg.ts });
        break;
      default:
        send({ t: "error", message: `unknown message type: ${msg.t}` });
    }
  });

  socket.on("close", () => {
    void arena.leave(conn);
    connections.delete(conn);
  });
});

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, "shutting down");
    arena.stopWatchdog();
    await stopPresence();
    await stopBus();
    await app.close();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
