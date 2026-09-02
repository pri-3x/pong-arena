import { WebSocket } from "ws";

const URL = process.env.WS_URL ?? "ws://localhost:3100/ws";

function bot(name, aimErrorPx) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const log = { name, instance: null, side: null, roomId: null, states: 0, end: null };
    let side = null;
    const t = setTimeout(() => { ws.close(); reject(new Error(`${name}: timed out`)); }, 45000);

    ws.on("open", () => ws.send(JSON.stringify({ t: "join", name })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "hello") log.instance = m.instance;
      if (m.t === "waiting") log.waited = true;
      if (m.t === "matched") { side = m.side; log.side = m.side; log.roomId = m.roomId; }
      if (m.t === "state") {
        log.states++;
        const [bx, by] = m.b;
        const myPaddleY = side === "left" ? m.p[0] : m.p[1];
        const centre = myPaddleY + 40;
        // aiming error in pixels. The hit box is PADDLE_H + 2*BALL_R = 96px
        // tall, so an error must exceed 48px to actually miss.
        const target = by + aimErrorPx;
        const dir = target < centre - 6 ? -1 : target > centre + 6 ? 1 : 0;
        ws.send(JSON.stringify({ t: "input", dir }));
      }
      if (m.t === "end") { log.end = m; clearTimeout(t); ws.close(); resolve(log); }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

const a = bot("alice", 0);
await new Promise((r) => setTimeout(r, 300)); // ensure alice queues first
const b = bot("bob", 70);
const [ra, rb] = await Promise.all([a, b]);

console.log("alice:", JSON.stringify(ra));
console.log("bob:  ", JSON.stringify(rb));

let fail = 0;
const check = (c, msg) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${msg}`); if (!c) fail++; };
check(ra.roomId && ra.roomId === rb.roomId, "both players joined the SAME room");
check(ra.side === "left" && rb.side === "right", "first player got left, second got right");
check(ra.states > 100 && rb.states > 100, `both received many state updates (${ra.states}/${rb.states})`);
check(ra.end?.winner && ra.end.winner === rb.end?.winner, `both agree on the winner (${ra.end?.winner})`);
const sc = ra.end?.score ?? {};
check(Math.max(sc.left ?? 0, sc.right ?? 0) === 5, `winner reached 5 (score ${JSON.stringify(sc)})`);
check(sc[ra.end.winner] === 5, "the winner is the one with 5 points");
check(ra.instance === rb.instance, `both players are on the same server instance (${ra.instance})`);
process.exit(fail ? 1 : 0);
