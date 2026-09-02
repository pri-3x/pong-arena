import Fastify from "fastify";
import websocket from "@fastify/websocket";
import os from "node:os";
import { Arena, type Conn } from "./game/arena.js";
import * as C from "./game/constants.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(websocket);

const arena = new Arena();

app.get("/health", async () => ({ status: "ok" }));

app.get("/whoami", async () => ({
  instance: os.hostname(),
  uptimeSeconds: Math.round(process.uptime()),
  version: process.env.APP_VERSION ?? "v1",
}));

/** Game metrics. Prometheus will scrape a proper version of this in Phase 15. */
app.get("/stats", async () => ({
  instance: os.hostname(),
  ...arena.stats,
  connections: connections.size,
}));

/** Constants the client needs in order to draw the field at the right scale. */
app.get("/config", async () => ({
  fieldW: C.FIELD_W, fieldH: C.FIELD_H,
  paddleW: C.PADDLE_W, paddleH: C.PADDLE_H, paddleX: C.PADDLE_X,
  ballR: C.BALL_R, winScore: C.WIN_SCORE,
}));

const connections = new Set<Conn>();

app.get("/ws", { websocket: true }, (socket) => {
  const send = (msg: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  // Name is provisional until the client sends `join`.
  const conn: Conn = arena.newConn("anonymous", send);
  connections.add(conn);
  send({ t: "hello", instance: os.hostname(), playerId: conn.playerId });

  socket.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ t: "error", message: "invalid JSON" });
    }

    switch (msg.t) {
      case "join": {
        if (conn.room) return send({ t: "error", message: "already in a game" });
        // Never trust client input: clamp the name before storing it.
        conn.name = String(msg.name ?? "anonymous").slice(0, 20) || "anonymous";
        arena.join(conn);
        break;
      }
      case "input": {
        // The ONLY thing a client may influence: its own paddle direction.
        if (!conn.room || !conn.side) return;
        const dir = msg.dir === -1 || msg.dir === 1 ? msg.dir : 0;
        conn.room.input(conn.side, dir);
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
    arena.leave(conn);
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
    await app.close();
    process.exit(0);
  });
}
