import { WebSocket } from "ws";
const mk = (name, skill, onState) => {
  const ws = new WebSocket("ws://localhost:3100/ws"); let side = null;
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name })));
  ws.on("message", (r) => {
    const m = JSON.parse(r.toString());
    if (m.t === "matched") side = m.side;
    if (m.t === "state") {
      const [, by] = m.b; const py = side === "left" ? m.p[0] : m.p[1];
      const c = py + 40, target = by + skill;
      ws.send(JSON.stringify({ t: "input", dir: target < c - 6 ? -1 : target > c + 6 ? 1 : 0 }));
      onState(m);
    }
  });
  return ws;
};
let last = null;
const skill = Number(process.argv[2] ?? 0);  // aiming error in PIXELS
mk("alice", 0, (m) => { last = m; });
await new Promise(r => setTimeout(r, 300));
mk("bob", skill, () => {});
await new Promise(r => setTimeout(r, 12000));
console.log(`bob offsetPx=${skill} -> after 12s score=${JSON.stringify(last?.s)} tick=${last?.k}`);
process.exit(0);
