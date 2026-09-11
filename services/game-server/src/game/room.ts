import * as C from "./constants.js";
import { createState, serve, step, type GameState, type Side } from "./physics.js";

/** What we persist about a finished match. */
export interface MatchResult {
  roomId: string;
  startedAt: Date;
  endedAt: Date;
  endReason: "win" | "opponent_left";
  winnerUserId: string | null;
  players: Array<{ userId: string; side: Side; score: number; won: boolean }>;
}

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

  /**
   * Everyone who ever joined, keyed by side. Unlike `players` this is never
   * removed from, so we can still record who played after someone disconnects.
   */
  readonly roster = new Map<Side, { userId: string; name: string }>();

  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private finished = false;
  private onEmpty: (room: Room) => void;
  private onFinished: (result: MatchResult) => void;

  constructor(
    id: string,
    onEmpty: (room: Room) => void,
    onFinished: (result: MatchResult) => void = () => {}
  ) {
    this.id = id;
    this.onEmpty = onEmpty;
    this.onFinished = onFinished;
  }

  get full() {
    return this.players.size >= 2;
  }

  add(player: Player) {
    this.players.set(player.side, player);
    this.roster.set(player.side, { userId: player.userId, name: player.name });
    if (this.full) this.start();
  }

  remove(side: Side) {
    this.players.delete(side);
    if (this.state.phase === "playing") {
      // Opponent left mid-match: award the win to whoever is still here.
      const other: Side = side === "left" ? "right" : "left";
      this.finish("opponent_left", this.players.has(other) ? other : null);
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
        this.finish("win", this.state.winner);
        return;
      }
      // Simulate at 60 Hz, but only send every 2nd tick (30 Hz) to halve traffic.
      if (++this.ticks % C.BROADCAST_EVERY === 0) this.broadcast(this.snapshot());
    }, 1000 / C.TICK_HZ);
  }

  /**
   * The single place a match ends. Both paths - somebody reached 5, or somebody
   * disconnected - funnel through here so the result is broadcast once and
   * persisted once. `finished` guards against a double call, which would
   * otherwise insert the same match twice.
   */
  private finish(reason: "win" | "opponent_left", winner: Side | null) {
    if (this.finished) return;
    this.finished = true;

    this.state.phase = "finished";
    this.state.winner = winner;
    this.state.ball.vx = 0;
    this.state.ball.vy = 0;
    this.endedAt = Date.now();
    this.stop();

    this.broadcast({ t: "end", winner, score: this.state.score, reason });

    // Only record a match that actually started and had two identified
    // players. A lobby that never began is not a match.
    const left = this.roster.get("left");
    const right = this.roster.get("right");
    if (!this.startedAt || !left?.userId || !right?.userId) return;

    this.onFinished({
      roomId: this.id,
      startedAt: new Date(this.startedAt),
      endedAt: new Date(this.endedAt),
      endReason: reason,
      winnerUserId: winner ? this.roster.get(winner)?.userId ?? null : null,
      players: (["left", "right"] as const).map((side) => ({
        userId: this.roster.get(side)!.userId,
        side,
        score: this.state.score[side],
        won: winner === side,
      })),
    });
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
