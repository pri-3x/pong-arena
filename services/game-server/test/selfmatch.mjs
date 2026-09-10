import { WebSocket } from "ws";
const BASE = process.argv[2];
const wsUrl = BASE.replace(/^http/, "ws") + "/ws";

const r = await fetch(BASE + "/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "ada", password: "lovelace-1815" }),
});
const { token } = await r.json();

const open = (label) => new Promise((res) => {
  const ws = new WebSocket(wsUrl);
  const seen = { label, msgs: [] };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t !== "state") seen.msgs.push(m.reason ? `${m.t}(${m.reason})` : m.t);
  });
  setTimeout(() => { ws.close(); res(seen); }, 4000);
});

const a = open("tab1");
await new Promise((r) => setTimeout(r, 300));
const b = open("tab2");
const [x, y] = await Promise.all([a, b]);
console.log(`  ${x.label}: [${x.msgs.join(", ")}]`);
console.log(`  ${y.label}: [${y.msgs.join(", ")}]`);
const matched = [...x.msgs, ...y.msgs].some((m) => m.startsWith("matched"));
console.log(matched ? "\n  FAIL  a user was matched against themselves" : "\n  PASS  the same user is NOT matched against themselves");
process.exit(matched ? 1 : 0);
