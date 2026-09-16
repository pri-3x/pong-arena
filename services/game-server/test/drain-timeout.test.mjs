import { WebSocket } from "ws";
// The drain deadline expires with a match still running. The players must be
// TOLD, and the result must still be written - not silently dropped.
const [A, B] = process.argv.slice(2);
const PIDFILE = process.env.OWNER_PIDFILE;
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Real accounts, NOT guests: guest matches are deliberately never persisted,
// so a guest match could never test that the result survives shutdown.
async function account(base, username, password) {
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

// Both bots track perfectly, so the rally never ends and the match cannot
// finish inside the drain window.
function perfectBot(base, token) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const p = { side: null, room: null, end: null, states: 0 };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "state") {
      p.states++;
      const [, by] = m.b;
      const myY = p.side === "left" ? m.p[0] : m.p[1];
      const centre = myY + 40;
      ws.send(JSON.stringify({ t: "input", dir: by < centre - 4 ? -1 : by > centre + 4 ? 1 : 0 }));
      return;
    }
    if (m.t === "matched") { p.side = m.side; p.room = m.roomId; }
    if (m.t === "end") p.end = m;
  });
  ws.on("error", () => {});
  p.close = () => { try { ws.close(); } catch {} };
  return p;
}

const before = (await (await fetch(A + "/matches?limit=100")).json()).matches.map((m) => m.id);
const stamp = Date.now().toString().slice(-6);
const t1 = await account(A, `drain_a${stamp}`, "drain-test-password");
const t2 = await account(B, `drain_b${stamp}`, "drain-test-password");
const p1 = perfectBot(A, t1);
await sleep(400);
const p2 = perfectBot(B, t2);
await sleep(3000);
check(!!p1.room && p1.room === p2.room, `endless match running (${p1.room})`);
check(!p1.end, "and it has not ended on its own");

const ownerIsA = (await (await fetch(A + "/stats")).json()).roomsOwnedHere > 0;
const pids = (await (await import("node:fs/promises")).readFile(PIDFILE, "utf8")).trim().split(" ");
console.log(`  ----  owner is ${ownerIsA ? "pod-A" : "pod-B"}; SIGTERM with a 5s drain deadline`);
process.kill(Number(ownerIsA ? pids[0] : pids[1]), "SIGTERM");

for (let i = 0; i < 40 && !(p1.end && p2.end); i++) await sleep(500);

check(!!p1.end && !!p2.end, "both players were told the match was ending");
check(p1.end?.reason === "server_draining", `reason is server_draining (${p1.end?.reason})`);
check(p1.end?.reason === p2.end?.reason, "both got the same reason");

p1.close(); p2.close();
await sleep(1500);
const survivor = ownerIsA ? B : A;
const after = (await (await fetch(survivor + "/matches?limit=100")).json()).matches;
const fresh = after.filter((m) => !before.includes(m.id));
check(fresh.length === 1, `the interrupted match was still RECORDED (${fresh.length} new)`);
check(fresh[0]?.end_reason === "server_draining", `stored with end_reason=server_draining (${fresh[0]?.end_reason})`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
