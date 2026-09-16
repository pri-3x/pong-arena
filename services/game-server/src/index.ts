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
import { drain, isDraining } from "./drain.js";
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
  // A draining Pod is alive but must stop receiving traffic. Reporting this
  // through readiness is what removes it from the Service endpoints.
  if (isDraining()) {
    return reply.code(503).send({ ok: false, reason: "draining" });
  }
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
  draining: isDraining(),
  playersInMatches: arena.playersInMatches(),
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
        if (isDraining()) return send({ t: "draining", message: "this server is shutting down - reconnect to be matched elsewhere" });
        if (conn.room || conn.remote) return send({ t: "error", message: "already in a game" });
        // Identity comes from the signed token, never from the client's claim
        // about who it is. This is why the `name` field is gone.
        void (async () => {
          const claims = await verifyToken(typeof msg.token === "string" ? msg.token : undefined);
          if (!claims) return send({ t: "unauthorized", message: "sign in to play" });
          conn.isGuest = claims.guest === true;
          // identityId is who you ARE (guests included); userId is only set
          // for real accounts, because it becomes a foreign key.
          conn.identityId = claims.sub;
          conn.userId = claims.guest ? null : claims.sub;
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
      // Private match: create a code to share with a friend.
      case "host": {
        if (isDraining()) return send({ t: "draining", message: "this server is shutting down - reconnect to host elsewhere" });
        void (async () => {
          const claims = await verifyToken(typeof msg.token === "string" ? msg.token : undefined);
          if (!claims) return send({ t: "unauthorized", message: "sign in or continue as a guest" });
          conn.isGuest = claims.guest === true;
          conn.identityId = claims.sub;
          conn.userId = claims.guest ? null : claims.sub;
          conn.name = claims.username;
          await arena.host(conn).catch((e) => {
            app.log.error({ err: e }, "host failed");
            send({ t: "error", message: "could not create a match code" });
          });
        })();
        break;
      }

      // Private match: join a friend's code.
      case "join_code": {
        if (isDraining()) return send({ t: "draining", message: "this server is shutting down - reconnect to join elsewhere" });
        void (async () => {
          const claims = await verifyToken(typeof msg.token === "string" ? msg.token : undefined);
          if (!claims) return send({ t: "unauthorized", message: "sign in or continue as a guest" });
          conn.isGuest = claims.guest === true;
          conn.identityId = claims.sub;
          conn.userId = claims.guest ? null : claims.sub;
          conn.name = claims.username;
          await arena.joinByCode(conn, msg.code).catch((e) => {
            app.log.error({ err: e }, "join_code failed");
            send({ t: "error", message: "could not join that match" });
          });
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

const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS ?? 60_000);

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    // Kubernetes can send SIGTERM more than once; a second one must not
    // restart the drain or race the first to process.exit().
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    await drain({
      timeoutMs: DRAIN_TIMEOUT_MS,
      pollMs: 500,
      playersInMatches: () => arena.playersInMatches(),
      matchesOwnedHere: () => arena.matchesOwnedHere(),
      clearQueue: () => arena.clearLocalQueueTickets(),
      endAll: () => arena.endAllForShutdown(),
      log: (msg, extra) => app.log.info(extra ?? {}, msg),
    });

    // Give the final `end` messages a moment to actually leave the socket.
    await new Promise((r) => setTimeout(r, 300));

    // Wait for result writes before closing the pool. Ending a match schedules
    // an INSERT; exiting underneath it loses a match that was really played.
    const flushed = await arena.flushPendingWrites(5000);
    if (flushed) app.log.info({ pendingWrites: flushed }, "draining: flushed match results");

    arena.stopWatchdog();
    await stopPresence();
    await stopBus();
    await app.close();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
