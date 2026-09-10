import * as C from "./constants.js";
import { createState, serve, step, type GameState, type Side } from "./physics.js";

export interface Player {
  id: string;
  /** Authenticated user id, used to persist the match result in Phase 7. */
  userId: string;
  name: string;
  side: Side;
  send: (msg: unknown) => void;
}

/**
 * One Pong match. Owns its own simulation loop.
 *
 * NOTE: a Room lives in the memory of ONE process. That is fine while we run a
 * single replica, and is exactly what breaks when we scale out - see Phase 5.
 */
export class Room {
  readonly id: string;
  readonly state: GameState = createState();
  players = new Map<Side, Player>();
  startedAt: number | null = null;
  endedAt: number | null = null;

  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private onEmpty: (room: Room) => void;

  constructor(id: string, onEmpty: (room: Room) => void) {
    this.id = id;
    this.onEmpty = onEmpty;
  }

  get full() {
    return this.players.size >= 2;
  }

  add(player: Player) {
    this.players.set(player.side, player);
    if (this.full) this.start();
  }

  remove(side: Side) {
    this.players.delete(side);
    if (this.state.phase === "playing") {
      // Opponent left mid-match: award the win to whoever is still here.
      const other: Side = side === "left" ? "right" : "left";
      this.state.phase = "finished";
      this.state.winner = this.players.has(other) ? other : null;
      this.endedAt = Date.now();
      this.stop();
      this.broadcast({ t: "end", winner: this.state.winner, reason: "opponent_left" });
    }
    if (this.players.size === 0) {
      this.stop();
      this.onEmpty(this);
    }
  }

  input(side: Side, dir: -1 | 0 | 1) {
    const p = this.state.paddles[side];
    if (p) p.dir = dir;
  }

  private start() {
    this.state.phase = "playing";
    this.startedAt = Date.now();
    serve(this.state, Math.random() < 0.5 ? "left" : "right");

    this.broadcast({
      t: "start",
      players: {
        left: this.players.get("left")?.name ?? "?",
        right: this.players.get("right")?.name ?? "?",
      },
    });

    // Fixed-timestep loop. We pass a CONSTANT dt rather than measuring elapsed
    // wall-clock time, so the simulation is deterministic and a slow tick can
    // never make the ball jump a huge distance.
    const dt = 1 / C.TICK_HZ;
    this.timer = setInterval(() => {
      const { scored } = step(this.state, dt);
      if (scored) this.broadcast({ t: "score", score: this.state.score, scored });

      if (this.state.phase === "finished") {
        this.endedAt = Date.now();
        this.stop();
        this.broadcast({ t: "end", winner: this.state.winner, score: this.state.score, reason: "win" });
        return;
      }
      // Simulate at 60 Hz, but only send every 2nd tick (30 Hz) to halve traffic.
      if (++this.ticks % C.BROADCAST_EVERY === 0) this.broadcast(this.snapshot());
    }, 1000 / C.TICK_HZ);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Compact wire format - short keys because this goes out 30x per second. */
  snapshot() {
    const s = this.state;
    return {
      t: "state",
      k: s.tick,
      b: [Math.round(s.ball.x), Math.round(s.ball.y)],
      p: [Math.round(s.paddles.left.y), Math.round(s.paddles.right.y)],
      s: [s.score.left, s.score.right],
    };
  }

  broadcast(msg: unknown) {
    for (const p of this.players.values()) p.send(msg);
  }
}
