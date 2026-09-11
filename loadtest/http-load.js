import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

// Read-heavy API load: the leaderboard and match-history queries, which are the
// most database-expensive endpoints we have.
const BASE = __ENV.BASE_URL || "http://host.docker.internal";

const leaderboardTime = new Trend("leaderboard_duration");
const errors = new Rate("errors");

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 40 },   // ramp up
        { duration: "90s", target: 120 },  // sustained load - should trigger the HPA
        { duration: "30s", target: 120 },  // hold
        { duration: "20s", target: 0 },    // ramp down
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    // Fail the test if latency or error rate degrade badly under load.
    http_req_duration: ["p(95)<1500"],
    errors: ["rate<0.05"],
  },
};

export default function () {
  const res = http.get(`${BASE}/leaderboard?limit=20`);
  leaderboardTime.add(res.timings.duration);
  const ok = check(res, {
    "leaderboard 200": (r) => r.status === 200,
    "has a body": (r) => r.body && r.body.length > 10,
  });
  errors.add(!ok);

  const m = http.get(`${BASE}/matches?limit=20`);
  errors.add(!check(m, { "matches 200": (r) => r.status === 200 }));

  sleep(0.1);
}
