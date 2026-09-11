import { WebSocket } from "ws";
const [A, B] = process.argv.slice(2);
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (base, u, p) => (await (await fetch(base + "/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: u, password: p }),
})).json()).token;

function connect(base, token) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const p = { ws, side: null, room: null, end: null };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "matched") { p.side = m.side; p.room = m.roomId; }
    if (m.t === "end") p.end = m;
  });
  return p;
}

const t1 = await login(A, "local_ada", "lovelace-1815");
const t2 = await login(B, "local_grace", "hopper-1906");

const lbBefore = await (await fetch(A + "/leaderboard")).json();
const beforeRow = lbBefore.leaderboard.find((r) => r.username === "local_ada");

const p1 = connect(A, t1);
await sleep(400);
const p2 = connect(B, t2);
await sleep(2000);
check(!!p1.room && p1.room === p2.room, `match started (room ${p1.room})`);

// p2 rage-quits mid-match
p2.ws.close();
await sleep(2000);

check(p1.end?.reason === "opponent_left", `the remaining player is told (reason=${p1.end?.reason})`);
check(p1.end?.winner === p1.side, "the remaining player is awarded the win");

await sleep(1200);
const { matches } = await (await fetch(A + "/matches?limit=5")).json();
const abandoned = matches.find((m) => m.room_id === p1.room);
check(!!abandoned, "the abandoned match IS stored in history");
check(abandoned?.end_reason === "opponent_left", `stored with end_reason=opponent_left (got ${abandoned?.end_reason})`);

const lbAfter = await (await fetch(A + "/leaderboard")).json();
const afterRow = lbAfter.leaderboard.find((r) => r.username === "local_ada");
check((afterRow?.wins ?? 0) === (beforeRow?.wins ?? 0),
  `but it does NOT add a leaderboard win (${beforeRow?.wins ?? 0} -> ${afterRow?.wins ?? 0})`);

p1.ws.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
