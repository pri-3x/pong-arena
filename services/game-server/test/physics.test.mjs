import { createState, serve, step } from "../dist/game/physics.js";
import * as C from "../dist/game/constants.js";
import assert from "node:assert/strict";

const dt = 1 / C.TICK_HZ;
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

// deterministic "random" so tests are repeatable
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

check("ball never escapes the field vertically", () => {
  const s = createState(); s.phase = "playing"; serve(s, "right", rand);
  for (let i = 0; i < 60 * 60; i++) {
    step(s, dt, rand);
    assert.ok(s.ball.y >= -0.01 && s.ball.y <= C.FIELD_H + 0.01, `ball.y=${s.ball.y} at tick ${i}`);
    if (s.phase === "finished") break;
  }
});

check("paddle cannot leave the field", () => {
  const s = createState(); s.phase = "playing"; serve(s, "right", rand);
  s.paddles.left.dir = -1;
  for (let i = 0; i < 600; i++) step(s, dt, rand);
  assert.equal(s.paddles.left.y, 0);
  s.paddles.left.dir = 1;
  for (let i = 0; i < 600; i++) step(s, dt, rand);
  assert.equal(s.paddles.left.y, C.FIELD_H - C.PADDLE_H);
});

check("a perfectly-tracking paddle always returns the ball", () => {
  const s = createState(); s.phase = "playing"; serve(s, "left", rand);
  let leftHits = 0, lastVx = s.ball.vx;
  for (let i = 0; i < 60 * 120; i++) {
    // cheat: snap both paddles to the ball
    s.paddles.left.y = s.ball.y - C.PADDLE_H / 2;
    s.paddles.right.y = s.ball.y - C.PADDLE_H / 2;
    step(s, dt, rand);
    if (lastVx < 0 && s.ball.vx > 0) leftHits++;
    lastVx = s.ball.vx;
  }
  assert.equal(s.score.left + s.score.right, 0, "no one should score against perfect paddles");
  assert.ok(leftHits > 10, `expected many rallies, got ${leftHits}`);
});

check("ball speed is capped (no tunnelling at max speed)", () => {
  const s = createState(); s.phase = "playing"; serve(s, "left", rand);
  for (let i = 0; i < 60 * 120; i++) {
    s.paddles.left.y = s.ball.y - C.PADDLE_H / 2;
    s.paddles.right.y = s.ball.y - C.PADDLE_H / 2;
    step(s, dt, rand);
    const sp = Math.hypot(s.ball.vx, s.ball.vy);
    assert.ok(sp <= C.BALL_MAX_SPEED + 1, `speed ${sp} exceeded cap at tick ${i}`);
  }
});

check("game ends at WIN_SCORE with a winner", () => {
  const s = createState(); s.phase = "playing"; serve(s, "left", rand);
  // left paddle does nothing -> right should win
  for (let i = 0; i < 60 * 300 && s.phase === "playing"; i++) {
    s.paddles.right.y = s.ball.y - C.PADDLE_H / 2;
    step(s, dt, rand);
  }
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "right");
  assert.equal(s.score.right, C.WIN_SCORE);
});

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
