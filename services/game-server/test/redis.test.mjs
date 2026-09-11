import { WebSocket } from "ws";
import assert from "node:assert/strict";

// Two independent server instances sharing one Redis.
// Usage: node test/redis.test.mjs <httpA> <httpB>
const [A, B] = process.argv.slice(2);
if (!A || !B) { console.error("usage: redis.test.mjs http://a http://b"); process.exit(2); }
const wsUrl = (http) => http.replace(/^http/, "ws") + "/ws";

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };
const get = async (base, path) => (await fetch(base + path)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Auth was added in Phase 6: joining now requires a signed token, not a name.
async function token(base, username, password) {
  await fetch(base + "/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const r = await fetch(base + "/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
  return (await r.json()).token;
}

function player(url, { holdUp = false } = {}) {
  const ws = new WebSocket(url);
  const p = { pod: null, side: null, room: null, msgs: [], first: null, last: null, ws };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "hello") p.pod = m.instance;
    else if (m.t === "matched") {
      p.side = m.side; p.room = m.roomId; p.msgs.push("matched");
      if (holdUp) ws.send(JSON.stringify({ t: "input", dir: -1 }));
    } else if (m.t === "state") { if (!p.first) p.first = m.p; p.last = m.p; }
    else p.msgs.push(m.t);
  });
  p.join = (tok) => new Promise((res) => {
    const go = () => { ws.send(JSON.stringify({ t: "join", token: tok })); res(); };
    ws.readyState === WebSocket.OPEN ? go() : ws.once("open", go);
  });
  return p;
}

// --- 1. a queued player who disconnects must not be left in the queue -------
{
  const before = (await get(A, "/stats")).redis.queueLength;
  const ghostToken = await token(A, "rt_ghost", "load-test-password");
  const solo = player(wsUrl(A));
  await solo.join(ghostToken);
  await sleep(600);
  const queued = (await get(A, "/stats")).redis.queueLength;
  solo.ws.close();
  await sleep(600);
  const after = (await get(A, "/stats")).redis.queueLength;
  check(queued === before + 1, `joining enqueues the player (${before} -> ${queued})`);
  check(after === before, `disconnecting removes the ticket (${queued} -> ${after})`);
}

// --- 2. players on DIFFERENT instances play one shared game -----------------
{
  // Other clients (browser tabs) may be connected, so measure a DELTA rather
  // than assuming the cluster is idle.
  const baseline = await get(A, "/cluster");
  const t1 = await token(A, "rt_alice", "load-test-password");
  const t2 = await token(B, "rt_bob", "load-test-password");
  const p1 = player(wsUrl(A), { holdUp: true });
  await p1.join(t1);
  await sleep(400);                       // make sure alice queues first
  const p2 = player(wsUrl(B), { holdUp: true });
  await p2.join(t2);
  await sleep(4000);

  check(p1.pod !== p2.pod, `players are on different instances (${p1.pod} vs ${p2.pod})`);
  check(!!p1.room && p1.room === p2.room, `both joined the same room (${p1.room})`);
  check(p1.side !== p2.side, `they got opposite sides (${p1.side} / ${p2.side})`);
  check(!!p1.last && !!p2.last, "both received state updates");
  assert.ok(p1.first && p1.last);
  const moved = { left: p1.last[0] - p1.first[0], right: p1.last[1] - p1.first[1] };
  check(moved.left < -20 && moved.right < -20,
    `BOTH paddles responded to input across pods ${JSON.stringify(moved)}`);
  check(JSON.stringify(p1.last) === JSON.stringify(p2.last) ||
        Math.abs(p1.last[0] - p2.last[0]) < 40,
    "both clients see the same world");

  // --- 3. presence is cluster-wide, not per-pod ----------------------------
  const ca = await get(A, "/cluster");
  const cb = await get(B, "/cluster");
  // Assert that BOTH of our instances report in, rather than that exactly two
  // exist: another instance sharing this Redis (a stray `npm run dev`, or a
  // second CI job) must not make this test fail for an unrelated reason.
  const names = ca.pods.map((p) => p.pod);
  check(names.includes(p1.pod) && names.includes(p2.pod),
    `both instances report into the shared cluster view (${names.join(", ")})`);
  // Presence records refresh on a 2s timer with a 10s TTL, so an exact delta is
  // racy - a record written just before the baseline can expire during the
  // test. Assert the property that actually matters: while a match is running,
  // the cluster-wide view sees at least those two players and that game.
  check(ca.players >= 2, `cluster-wide player count includes both (${ca.players}, baseline ${baseline.players})`);
  check(ca.games >= 1, `cluster-wide game count includes the running match (${ca.games})`);
  check(cb.players === ca.players && cb.games === ca.games,
    "both pods give the same cluster-wide answer");

  p1.ws.close(); p2.ws.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
