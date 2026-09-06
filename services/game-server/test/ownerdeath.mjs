import { WebSocket } from "ws";
const [A, B] = process.argv.slice(2);
const wsUrl = (h) => h.replace(/^http/, "ws") + "/ws";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function player(url, label) {
  const ws = new WebSocket(url);
  const p = { label, pod: null, side: null, room: null, msgs: [], states: 0, closed: false, lastStateAt: 0 };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "hello") p.pod = m.instance;
    else if (m.t === "matched") { p.side = m.side; p.room = m.roomId; p.msgs.push("matched"); }
    else if (m.t === "state") { p.states++; p.lastStateAt = Date.now(); }
    else p.msgs.push(m.t);
  });
  ws.on("close", () => { p.closed = true; });
  p.join = (n) => new Promise((res) => {
    const go = () => { ws.send(JSON.stringify({ t: "join", name: n })); res(); };
    ws.readyState === WebSocket.OPEN ? go() : ws.once("open", go);
  });
  return p;
}

const p1 = player(wsUrl(A), "on-A"); await p1.join("alice");
await sleep(400);
const p2 = player(wsUrl(B), "on-B"); await p2.join("bob");
await sleep(2000);
console.log(JSON.stringify({ phase: "match running", room: p1.room, p1: { pod: p1.pod, side: p1.side, states: p1.states }, p2: { pod: p2.pod, side: p2.side, states: p2.states } }));
console.log("OWNER_HINT " + (p1.msgs[0] === "matched" ? p1.pod : p2.pod));
const s1 = p1.states, s2 = p2.states;
await sleep(1000);
console.log(JSON.stringify({ stillTicking: { p1: p1.states - s1, p2: p2.states - s2 } }));
process.stdout.write("READY\n");
await sleep(9000);
console.log(JSON.stringify({
  phase: "after owner deleted",
  p1: { states: p1.states, msgs: p1.msgs, closed: p1.closed, msSinceState: Date.now() - p1.lastStateAt },
  p2: { states: p2.states, msgs: p2.msgs, closed: p2.closed, msSinceState: Date.now() - p2.lastStateAt },
}));
process.exit(0);
