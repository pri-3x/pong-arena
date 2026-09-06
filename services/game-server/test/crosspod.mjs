import { WebSocket } from "ws";
// One player per URL. Each holds ArrowUp (dir=-1) once the match starts, so we
// can see whether the server actually moved their paddle.
const urls = process.argv.slice(2);
const run = urls.map((url, i) => new Promise((res) => {
  const ws = new WebSocket(url);
  const seen = { url, pod: null, side: null, room: null, msgs: [], states: 0, firstPaddles: null, lastPaddles: null };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name: `p${i + 1}` })));
  ws.on("message", (r) => {
    const m = JSON.parse(r.toString());
    if (m.t === "hello") seen.pod = m.instance;
    else if (m.t === "matched") {
      seen.side = m.side; seen.room = m.roomId; seen.msgs.push("matched");
      ws.send(JSON.stringify({ t: "input", dir: -1 }));   // hold UP forever
    } else if (m.t === "state") {
      seen.states++;
      if (!seen.firstPaddles) seen.firstPaddles = m.p;
      seen.lastPaddles = m.p;
    } else seen.msgs.push(m.t);
  });
  ws.on("error", (e) => { seen.error = e.message; });
  setTimeout(() => { ws.close(); res(seen); }, 5000);
}));
for (const r of await Promise.all(run)) {
  const moved = r.firstPaddles && r.lastPaddles
    ? { left: r.lastPaddles[0] - r.firstPaddles[0], right: r.lastPaddles[1] - r.firstPaddles[1] }
    : null;
  console.log(`  ${r.url}`);
  console.log(`    pod=${r.pod} side=${r.side} room=${r.room}`);
  console.log(`    msgs=[${r.msgs.join(",")}] states=${r.states}`);
  console.log(`    paddle movement: ${JSON.stringify(moved)}   (negative = moved UP)`);
}
