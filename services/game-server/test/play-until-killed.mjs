import { WebSocket } from "ws";
const [A, B] = process.argv.slice(2);
const login = async (base, u, p) => (await (await fetch(base + "/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: u, password: p }) })).json()).token;
const bot = (base, token, err) => {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const p = { side: null, room: null, end: null, states: 0 };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", token })));
  ws.on("message", (raw) => { const m = JSON.parse(raw.toString());
    if (m.t === "matched") { p.side = m.side; p.room = m.roomId; }
    if (m.t === "state") { p.states++; const [, by] = m.b; const my = p.side === "left" ? m.p[0] : m.p[1];
      const c = my + 40, tgt = by + err;
      ws.send(JSON.stringify({ t: "input", dir: tgt < c - 6 ? -1 : tgt > c + 6 ? 1 : 0 })); }
    if (m.t === "end") p.end = m; });
  return p;
};
const t1 = await login(A, "local_ada", "lovelace-1815");
const t2 = await login(B, "local_grace", "hopper-1906");
const p1 = bot(A, t1, 0);
await new Promise(r => setTimeout(r, 400));
const p2 = bot(B, t2, 70);
await new Promise(r => setTimeout(r, 2500));
console.log("ROOM=" + p1.room + " states=" + p1.states);
await new Promise(r => setTimeout(r, 15000));
console.log("FINAL " + JSON.stringify({ p1end: p1.end?.reason ?? null, p2end: p2.end?.reason ?? null }));
process.exit(0);
