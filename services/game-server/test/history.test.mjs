import { WebSocket } from "ws";
const [A, B] = process.argv.slice(2);
const U1 = process.env.U1 ?? "local_ada";
const U2 = process.env.U2 ?? "local_grace";
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(base, username, password) {
  const r = await fetch(base + "/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
  return (await r.json()).token;
}

/** A bot with a fixed aiming error in pixels. >48px actually misses. */
function bot(base, token, aimErrorPx) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const p = { side: null, room: null, end: null, pod: null };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "hello") p.pod = m.instance;
    if (m.t === "matched") { p.side = m.side; p.room = m.roomId; }
    if (m.t === "state") {
      const [, by] = m.b;
      const myY = p.side === "left" ? m.p[0] : m.p[1];
      const centre = myY + 40, target = by + aimErrorPx;
      ws.send(JSON.stringify({ t: "input", dir: target < centre - 6 ? -1 : target > centre + 6 ? 1 : 0 }));
    }
    if (m.t === "end") { p.end = m; ws.close(); }
  });
  return p;
}

const t1 = await login(A, U1, "lovelace-1815");
const t2 = await login(B, U2, "hopper-1906");

const before = await (await fetch(A + "/matches")).json();
const p1 = bot(A, t1, 0);        // never misses
await sleep(400);
const p2 = bot(B, t2, 70);       // misses often
for (let i = 0; i < 120 && !(p1.end && p2.end); i++) await sleep(500);

check(!!p1.end && !!p2.end, "the match finished for both players");
// Only meaningful when the two clients were pointed at different instances.
// Through a single Service port-forward both land on the same Pod, which is a
// property of the harness, not of the system.
if (A !== B) check(p1.pod !== p2.pod, `players were on different pods (${p1.pod} vs ${p2.pod})`);
else console.log(`  ----  both clients used one endpoint, so both landed on ${p1.pod}`);
check(p1.end?.winner === p1.side, `the accurate bot won (winner=${p1.end?.winner}, it was ${p1.side})`);

await sleep(1200);  // the owning pod writes asynchronously

const { matches } = await (await fetch(A + "/matches?limit=5")).json();
check(matches.length === before.matches.length + 1, `exactly one new match was recorded (${before.matches.length} -> ${matches.length})`);

const m = matches[0];
check(m?.room_id === p1.room, `the stored room_id matches the played room (${m?.room_id})`);
check(m?.end_reason === "win", `end_reason is "win" (got ${m?.end_reason})`);
check(m?.players?.length === 2, "two participants were stored");
const names = (m?.players ?? []).map((x) => x.username).sort();
check(JSON.stringify(names) === JSON.stringify([U1, U2].sort()), `both usernames stored (${names.join(", ")})`);
const winner = (m?.players ?? []).find((x) => x.won);
check(winner?.username === U1, `the winner row is ${U1} (got ${winner?.username})`);
check(winner?.score === 5, `the winner's stored score is 5 (got ${winner?.score})`);
check(new Date(m.ended_at) > new Date(m.started_at), "ended_at is after started_at");

const { leaderboard } = await (await fetch(A + "/leaderboard")).json();
const row1 = leaderboard.find((r) => r.username === U1);
const row2 = leaderboard.find((r) => r.username === U2);
check(!!row1 && !!row2, "both players appear on the leaderboard");
check(row1?.wins >= 1 && row1?.losses === 0, `${U1}: ${row1?.wins}W ${row1?.losses}L`);
check(row2?.losses >= 1 && row2?.wins === 0, `${U2}: ${row2?.wins}W ${row2?.losses}L`);
check(row1?.win_rate === 100, `${U1} win rate is 100% (got ${row1?.win_rate})`);
check(leaderboard[0].username === U1, "the leaderboard is sorted by wins");

const mine = await (await fetch(`${A}/matches?username=${U1}&limit=50`)).json();
check(mine.matches.length >= 1 && mine.matches.every((x) => x.players.some((pl) => pl.username === U1)),
  "?username= returns only that player's matches");
const other = await (await fetch(`${A}/matches?username=nobody_at_all&limit=50`)).json();
check(other.matches.length === 0, "an unknown username returns no matches");

const capped = await (await fetch(`${A}/matches?limit=99999`)).json();
check(capped.matches.length <= 100, "limit is clamped server-side");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
