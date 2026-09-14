import { WebSocket } from "ws";
// Regression test for the heartbeat startup race.
//
// A room's `alive` key is refreshed by a 2s interval. If the FIRST beat is not
// written synchronously at room creation, a room created just after a tick has
// no key for up to 2s - and the relaying Pod's sweep can declare it orphaned.
//
// The race is timing-dependent, so we start many matches in quick succession
// and assert that none of them ends with reason "server_lost".
const [A, B] = process.argv.slice(2);
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function guest(base) {
  const r = await fetch(base + "/auth/guest", { method: "POST" });
  if (!r.ok) throw new Error(`guest: ${r.status}`);
  return (await r.json()).token;
}

function play(base, token) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const p = { end: null, matched: false };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "matched") p.matched = true;
    if (m.t === "end") { p.end = m; ws.close(); }
  });
  ws.on("error", () => {});
  p.close = () => { try { ws.close(); } catch {} };
  return p;
}

let started = 0, orphaned = 0;
for (let i = 0; i < ROUNDS; i++) {
  const [t1, t2] = await Promise.all([guest(A), guest(B)]);
  const p1 = play(A, t1);
  await sleep(120);
  const p2 = play(B, t2);
  // Wait longer than one sweep interval (2s) so a false orphan would surface.
  await sleep(3000);
  if (p1.matched && p2.matched) started++;
  for (const p of [p1, p2]) {
    if (p.end?.reason === "server_lost") orphaned++;
  }
  p1.close(); p2.close();
}

const pass = started === ROUNDS && orphaned === 0;
console.log(`  matches started: ${started}/${ROUNDS}`);
console.log(`  falsely orphaned: ${orphaned}`);
console.log(pass ? "\n  PASS  no match was declared orphaned at startup"
                 : `\n  FAIL  ${orphaned} spurious server_lost across ${ROUNDS} rounds`);
process.exit(pass ? 0 : 1);
