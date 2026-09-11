import ws from "k6/ws";
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

// Simulated players: sign in, enter matchmaking, play, record what happened.
const BASE = __ENV.BASE_URL || "http://host.docker.internal";
const WS = BASE.replace("http", "ws");

const matched = new Counter("matches_started");
const finished = new Counter("matches_finished");
const stateMsgs = new Counter("state_messages");
const matchWait = new Trend("time_to_match_ms");

export const options = {
  scenarios: {
    players: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 20 },   // 20 concurrent players = 10 matches
        { duration: "60s", target: 40 },   // 40 players = 20 matches
        { duration: "30s", target: 40 },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "15s",
    },
  },
};

// One shared pool of accounts, created on the first iteration of each VU.
export function setup() {
  const users = [];
  for (let i = 0; i < 40; i++) {
    const username = `bot_${i}`;
    const password = "load-test-password";
    http.post(`${BASE}/auth/register`, JSON.stringify({ username, password }),
      { headers: { "content-type": "application/json" } });
    const r = http.post(`${BASE}/auth/login`, JSON.stringify({ username, password }),
      { headers: { "content-type": "application/json" } });
    if (r.status === 200) users.push(JSON.parse(r.body).token);
  }
  return { tokens: users };
}

export default function (data) {
  const token = data.tokens[__VU % data.tokens.length];
  if (!token) return;

  const joinedAt = Date.now();
  let side = null;
  let sawMatch = false;

  const res = ws.connect(`${WS}/ws`, {}, function (socket) {
    socket.on("open", () => socket.send(JSON.stringify({ t: "join", token })));

    socket.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.t === "matched") {
        side = m.side;
        sawMatch = true;
        matched.add(1);
        matchWait.add(Date.now() - joinedAt);
      } else if (m.t === "state") {
        stateMsgs.add(1);
        // chase the ball, imperfectly
        const by = m.b[1];
        const myY = side === "left" ? m.p[0] : m.p[1];
        const centre = myY + 40;
        const target = by + (__VU % 3 === 0 ? 60 : 5);
        socket.send(JSON.stringify({ t: "input", dir: target < centre - 6 ? -1 : target > centre + 6 ? 1 : 0 }));
      } else if (m.t === "end") {
        finished.add(1);
        socket.close();
      }
    });

    // Never hold a socket longer than 45s, so the ramp-down is clean.
    socket.setTimeout(() => socket.close(), 45000);
  });

  check(res, { "websocket handshake 101": (r) => r && r.status === 101 });
}
