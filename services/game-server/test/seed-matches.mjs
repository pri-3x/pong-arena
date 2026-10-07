import { WebSocket } from "ws";
const BASE = "http://localhost";
const WS = BASE.replace("http", "ws") + "/ws";
const PW = "demo-password-2026";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Skill = aiming error in pixels. The hit box is 96px tall, so an error above
// ~48px actually misses. Lower = stronger player.
const ROSTER = [
  { name: "ada",      err: 10 },
  { name: "grace",    err: 34 },
  { name: "alan",     err: 52 },
  { name: "margaret", err: 58 },
  { name: "linus",    err: 66 },
  { name: "edsger",   env: 0, err: 74 },
];

async function token(username) {
  await fetch(`${BASE}/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PW }),
  });
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PW }),
  });
  if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
  return (await r.json()).token;
}

function play(tok, err) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS);
    let side = null;
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done("timeout"), 90000);
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", token: tok })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "matched") side = m.side;
      else if (m.t === "state") {
        const by = m.b[1];
        const myY = side === "left" ? m.p[0] : m.p[1];
        const centre = myY + 40, target = by + err;
        ws.send(JSON.stringify({ t: "input", dir: target < centre - 6 ? -1 : target > centre + 6 ? 1 : 0 }));
      } else if (m.t === "end") { clearTimeout(t); done(m.reason); }
    });
    ws.on("error", () => { clearTimeout(t); done("error"); });
  });
}

const tokens = {};
for (const p of ROSTER) tokens[p.name] = await token(p.name);
console.log("accounts ready:", Object.keys(tokens).join(", "));

const ROUNDS = Number(process.argv[2] ?? 8);
for (let round = 1; round <= ROUNDS; round++) {
  // Shuffle so pairings vary, then connect everyone at once: the Redis queue
  // pairs them into three simultaneous matches.
  const order = [...ROSTER].sort(() => Math.random() - 0.5);
  const running = [];
  for (const p of order) {
    running.push(play(tokens[p.name], p.err));
    await sleep(220);          // stagger so pairing is deterministic-ish
  }
  const res = await Promise.all(running);
  console.log(`round ${round}/${ROUNDS}: ${res.join(", ")}`);
  await sleep(600);
}
console.log("done");
process.exit(0);
