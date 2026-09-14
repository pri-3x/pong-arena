import { WebSocket } from "ws";
const [A, B] = process.argv.slice(2);
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const guest = async (base) =>
  (await (await fetch(base + "/auth/guest", { method: "POST" })).json());

function client(base, token) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const p = { msgs: [], code: null, side: null, room: null, end: null, err: null, states: 0, pod: null };
  const ready = new Promise((res) => ws.on("open", res));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "state") { p.states++; return; }
    p.msgs.push(m.t);
    if (m.t === "hello") p.pod = m.instance;
    if (m.t === "invite") p.code = m.code;
    if (m.t === "invite_error") p.err = m.reason;
    if (m.t === "matched") { p.side = m.side; p.room = m.roomId; }
    if (m.t === "end") p.end = m;
  });
  ws.on("error", () => {});
  p.send = async (o) => { await ready; ws.send(JSON.stringify(o)); };
  p.close = () => { try { ws.close(); } catch {} };
  return p;
}

// ---- guests can play each other -----------------------------------------
const g1 = await guest(A), g2 = await guest(B);
check(/^Guest-[A-Z0-9]{4}$/.test(g1.user.username), `guest gets a readable name (${g1.user.username})`);
check(g1.user.guest === true && g1.user.id.startsWith("guest_"), "guest id is not a database id");
check(g1.user.id !== g2.user.id, "two guests get different identities");

const p1 = client(A, g1.token);
await p1.send({ t: "join", token: g1.token });
await sleep(400);
const p2 = client(B, g2.token);
await p2.send({ t: "join", token: g2.token });
await sleep(2500);
check(!!p1.room && p1.room === p2.room, `two guests matched into one room (${p1.room})`);
check(p1.states > 20 && p2.states > 20, `both guests receive game state (${p1.states}/${p2.states})`);
if (A !== B) check(p1.pod !== p2.pod, `and they were on different pods (${p1.pod} / ${p2.pod})`);
p1.close(); p2.close();
await sleep(500);

// ---- the same guest in two tabs must NOT be matched ----------------------
const solo = await guest(A);
const s1 = client(A, solo.token), s2 = client(B, solo.token);
await s1.send({ t: "join", token: solo.token });
await sleep(400);
await s2.send({ t: "join", token: solo.token });
await sleep(2000);
check(!s1.room && !s2.room, "the SAME guest in two tabs is not matched with itself");
s1.close(); s2.close();
await sleep(500);

// ---- invite: host on A, join from B -------------------------------------
const h = await guest(A), j = await guest(B);
const host = client(A, h.token);
await host.send({ t: "host", token: h.token });
await sleep(800);
check(/^[A-HJ-NP-Z2-9]{6}$/.test(host.code ?? ""), `host receives a shareable code (${host.code})`);
check(!/[01OIL]/.test(host.code ?? ""), "the code avoids ambiguous characters (0/O/1/I/L)");

const joiner = client(B, j.token);
await joiner.send({ t: "join_code", token: j.token, code: host.code });
await sleep(2500);
check(!!host.room && host.room === joiner.room, `the friend joined the host's match (${host.room})`);
check(host.side === "left" && joiner.side === "right", "the host takes the left paddle");
check(host.states > 20 && joiner.states > 20, `the private match is really running (${host.states}/${joiner.states})`);

// ---- a code can only be used once ---------------------------------------
const late = client(B, (await guest(B)).token);
await late.send({ t: "join_code", token: (await guest(B)).token, code: host.code });
await sleep(1200);
check(late.err !== null, `a used code cannot be reused (${late.err})`);
late.close(); host.close(); joiner.close();
await sleep(500);

// ---- lowercase and bad codes --------------------------------------------
const h2 = await guest(A);
const host2 = client(A, h2.token);
await host2.send({ t: "host", token: h2.token });
await sleep(800);
const j2 = await guest(B);
const joiner2 = client(B, j2.token);
await joiner2.send({ t: "join_code", token: j2.token, code: host2.code.toLowerCase() });
await sleep(2000);
check(!!joiner2.room, "codes are case-insensitive");
host2.close(); joiner2.close();

const bad = await guest(A);
const badc = client(A, bad.token);
await badc.send({ t: "join_code", token: bad.token, code: "ZZZZZZ" });
await sleep(1000);
check(badc.err !== null, `an unknown code is rejected cleanly (${badc.err})`);
badc.close();

// ---- guest matches are NOT persisted ------------------------------------
const before = (await (await fetch(A + "/matches?limit=100")).json()).matches.length;
check(true, `(guest matches played above; stored match count is ${before})`);
const anyGuest = (await (await fetch(A + "/matches?limit=100")).json()).matches
  .some((m) => m.players.some((pl) => (pl.username ?? "").startsWith("Guest-")));
check(!anyGuest, "no guest appears in stored match history");

const lb = (await (await fetch(A + "/leaderboard?limit=100")).json()).leaderboard;
check(!lb.some((r) => r.username.startsWith("Guest-")), "no guest appears on the leaderboard");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
