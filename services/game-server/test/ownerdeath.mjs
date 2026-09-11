import { WebSocket } from "ws";
const [A, B] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (base, u, p) => {
  const r = await fetch(base + "/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: u, password: p }),
  });
  if (!r.ok) throw new Error(`login ${u}: ${r.status}`);
  return (await r.json()).token;
};

function player(url, token, label) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
  const p = { label, pod: null, side: null, room: null, msgs: [], states: 0, closed: false, endReason: null };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "hello") p.pod = m.instance;
    else if (m.t === "matched") { p.side = m.side; p.room = m.roomId; p.msgs.push("matched"); }
    else if (m.t === "state") p.states++;
    else { p.msgs.push(m.t); if (m.t === "end") p.endReason = m.reason; }
  });
  ws.on("close", () => { p.closed = true; });
  ws.on("error", () => {});
  return p;
}

const t1 = await login(A, "ada", "lovelace-1815");
const t2 = await login(B, "grace", "hopper-1906");
const p1 = player(A, t1, "on-A");
await sleep(500);
const p2 = player(B, t2, "on-B");
await sleep(2500);

console.log(JSON.stringify({ phase: "running", room: p1.room, p1: { pod: p1.pod, side: p1.side, states: p1.states }, p2: { pod: p2.pod, side: p2.side, states: p2.states } }));
// The owner is whichever pod does NOT report "waiting" first - i.e. the second joiner's pod.
console.log("OWNER_HINT " + p2.pod);
const s1 = p1.states, s2 = p2.states;
await sleep(1000);
console.log(JSON.stringify({ stillTicking: { p1: p1.states - s1, p2: p2.states - s2 } }));
process.stdout.write("READY\n");

await sleep(14000);
console.log("FINAL " + JSON.stringify({
  p1: { pod: p1.pod, msgs: p1.msgs, endReason: p1.endReason, closed: p1.closed },
  p2: { pod: p2.pod, msgs: p2.msgs, endReason: p2.endReason, closed: p2.closed },
}));
process.exit(0);
