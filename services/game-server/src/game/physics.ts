import * as C from "./constants.js";

export type Side = "left" | "right";
export type Phase = "waiting" | "playing" | "finished";

export interface GameState {
  phase: Phase;
  ball: { x: number; y: number; vx: number; vy: number };
  paddles: Record<Side, { y: number; dir: -1 | 0 | 1 }>;
  score: Record<Side, number>;
  winner: Side | null;
  tick: number;
}

export function createState(): GameState {
  return {
    phase: "waiting",
    ball: { x: C.FIELD_W / 2, y: C.FIELD_H / 2, vx: 0, vy: 0 },
    paddles: {
      left: { y: C.FIELD_H / 2 - C.PADDLE_H / 2, dir: 0 },
      right: { y: C.FIELD_H / 2 - C.PADDLE_H / 2, dir: 0 },
    },
    score: { left: 0, right: 0 },
    winner: null,
    tick: 0,
  };
}

/**
 * Put the ball back in the middle and launch it toward `towards`.
 * Deterministic angle range so a serve is never unreturnable.
 */
export function serve(state: GameState, towards: Side, rand = Math.random): void {
  const angle = (rand() - 0.5) * (Math.PI / 3); // +/- 30 degrees
  const dir = towards === "left" ? -1 : 1;
  state.ball = {
    x: C.FIELD_W / 2,
    y: C.FIELD_H / 2,
    vx: Math.cos(angle) * C.BALL_START_SPEED * dir,
    vy: Math.sin(angle) * C.BALL_START_SPEED,
  };
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Advance the world by `dt` seconds. Pure with respect to I/O: it only mutates
 * the state object it is given and returns what notable events occurred.
 */
export function step(state: GameState, dt: number, rand = Math.random): { scored: Side | null } {
  if (state.phase !== "playing") return { scored: null };
  state.tick++;

  // --- paddles ---------------------------------------------------------
  // The client sends only a direction. The SERVER decides the position,
  // so a modified client cannot teleport its paddle.
  for (const side of ["left", "right"] as const) {
    const p = state.paddles[side];
    p.y = clamp(p.y + p.dir * C.PADDLE_SPEED * dt, 0, C.FIELD_H - C.PADDLE_H);
  }

  // --- ball ------------------------------------------------------------
  const b = state.ball;
  const prevX = b.x;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // top / bottom walls
  if (b.y - C.BALL_R < 0 && b.vy < 0) {
    b.y = C.BALL_R;
    b.vy = -b.vy;
  } else if (b.y + C.BALL_R > C.FIELD_H && b.vy > 0) {
    b.y = C.FIELD_H - C.BALL_R;
    b.vy = -b.vy;
  }

  // --- paddle collision ------------------------------------------------
  // We test whether the ball CROSSED the paddle's face this frame rather than
  // whether it currently overlaps it. Overlap tests miss fast balls that jump
  // straight past a thin paddle in one tick ("tunnelling").
  const leftPlane = C.PADDLE_X + C.PADDLE_W + C.BALL_R;
  const rightPlane = C.FIELD_W - C.PADDLE_X - C.PADDLE_W - C.BALL_R;

  if (b.vx < 0 && prevX >= leftPlane && b.x <= leftPlane) {
    if (hits(state, "left", b.y)) bounce(state, "left", leftPlane);
  } else if (b.vx > 0 && prevX <= rightPlane && b.x >= rightPlane) {
    if (hits(state, "right", b.y)) bounce(state, "right", rightPlane);
  }

  // --- scoring ---------------------------------------------------------
  if (b.x + C.BALL_R < 0) return score(state, "right", rand);
  if (b.x - C.BALL_R > C.FIELD_W) return score(state, "left", rand);

  return { scored: null };
}

function hits(state: GameState, side: Side, ballY: number): boolean {
  const top = state.paddles[side].y;
  return ballY >= top - C.BALL_R && ballY <= top + C.PADDLE_H + C.BALL_R;
}

/**
 * Reflect the ball. Where it hit the paddle controls the outgoing angle, so
 * players can aim - that single detail is what makes Pong a game and not a
 * screensaver.
 */
function bounce(state: GameState, side: Side, plane: number): void {
  const b = state.ball;
  const paddleTop = state.paddles[side].y;
  const offset = (b.y - (paddleTop + C.PADDLE_H / 2)) / (C.PADDLE_H / 2); // -1..1
  const angle = clamp(offset, -1, 1) * (Math.PI / 4); // up to +/- 45 degrees

  const speed = Math.min(Math.hypot(b.vx, b.vy) * C.BALL_SPEEDUP, C.BALL_MAX_SPEED);
  const dir = side === "left" ? 1 : -1;

  b.x = plane;
  b.vx = Math.cos(angle) * speed * dir;
  b.vy = Math.sin(angle) * speed;
}

function score(state: GameState, side: Side, rand: () => number) {
  state.score[side]++;
  if (state.score[side] >= C.WIN_SCORE) {
    state.phase = "finished";
    state.winner = side;
    state.ball.vx = 0;
    state.ball.vy = 0;
  } else {
    // serve toward the player who just conceded
    serve(state, side === "left" ? "right" : "left", rand);
  }
  return { scored: side };
}
