import { WebSocket } from "ws";
// Connect one player to each URL given on the command line, then report what
// each of them was told after 6 seconds.
const urls = process.argv.slice(2);
const results = urls.map((url, i) => new Promise((res) => {
  const ws = new WebSocket(url);
  const seen = { url, instance: null, msgs: [] };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name: `p${i + 1}` })));
  ws.on("message", (r) => {
    const m = JSON.parse(r.toString());
    if (m.t === "hello") seen.instance = m.instance;
    else if (m.t !== "state") seen.msgs.push(m.t);
  });
  ws.on("error", (e) => { seen.error = e.message; });
  setTimeout(() => { ws.close(); res(seen); }, 6000);
}));
for (const r of await Promise.all(results)) {
  console.log(`  ${r.url}\n    pod: ${r.instance}\n    got: ${r.msgs.join(", ") || r.error || "(nothing)"}`);
}
