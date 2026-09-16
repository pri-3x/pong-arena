import { WebSocket } from "ws";
// Graceful draining: a match in flight when its Pod is terminated must be
// allowed to FINISH, not dropped.
const [A, B] = process.argv.slice(2);
const PIDFILE = process.env.OWNER_PIDFILE;   // written by the harness
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const guest = async (base) => (await (await fetch(base + "/auth/guest", { method: "POST" })).json()).token;

function bot(base, token, aimErrorPx) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const p = { side: null, room: null, end: null, states: 0, msgs: [], closed: false };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "state") {
      p.states++;
      const [, by] = m.b;
      const myY = p.side === "left" ? m.p[0] : m.p[1];
      const centre = myY + 40, target = by + aimErrorPx;
      ws.send(JSON.stringify({ t: "input", dir: target < centre - 6 ? -1 : target > centre + 6 ? 1 : 0 }));
      return;
    }
    p.msgs.push(m.t);
    if (m.t === "matched") { p.side = m.side; p.room = m.roomId; }
    if (m.t === "end") p.end = m;
  });
  ws.on("close", () => { p.closed = true; });
  ws.on("error", () => {});
  p.close = () => { try { ws.close(); } catch {} };
  return p;
}

const t1 = await guest(A), t2 = await guest(B);
const p1 = bot(A, t1, 0);          // never misses
await sleep(400);
const p2 = bot(B, t2, 70);         // misses often, so the match ends quickly
await sleep(2500);

check(!!p1.room && p1.room === p2.room, `match running (${p1.room})`);
const statesBefore = p1.states;

// Which side owns it? Whoever reports a room it is simulating.
const ownerIsA = (await (await fetch(A + "/stats")).json()).roomsOwnedHere > 0;
const ownerBase = ownerIsA ? A : B;
console.log(`  ----  owner is ${ownerIsA ? "pod-A" : "pod-B"}; sending SIGTERM`);

const pid = (await (await import("node:fs/promises")).readFile(PIDFILE, "utf8")).trim();
process.kill(Number(ownerIsA ? pid.split(" ")[0] : pid.split(" ")[1]), "SIGTERM");

// The owner should now refuse new work immediately.
await sleep(1500);
let readyCode = 0;
try { readyCode = (await fetch(ownerBase + "/ready")).status; } catch { readyCode = -1; }
check(readyCode === 503, `the draining pod reports /ready 503 (got ${readyCode})`);

const newcomer = bot(ownerBase, await guest(ownerBase), 0);
await sleep(1500);
check(newcomer.msgs.includes("draining"), `new joins are refused while draining (${newcomer.msgs.join(",")})`);
newcomer.close();

// Now the point of the whole exercise: the match should keep running and finish.
for (let i = 0; i < 60 && !(p1.end && p2.end); i++) await sleep(500);

check(p1.states > statesBefore + 30, `the match kept being simulated after SIGTERM (${statesBefore} -> ${p1.states} states)`);
check(!!p1.end, `the match ENDED properly rather than being dropped (${p1.end?.reason})`);
check(p1.end?.reason === "win", `it ended with a real result, not a shutdown (${p1.end?.reason})`);
check(p1.end?.winner === p1.side, `the accurate bot won (${p1.end?.winner})`);
check(p1.end?.reason === p2.end?.reason, "both players were told the same thing");

p1.close(); p2.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
