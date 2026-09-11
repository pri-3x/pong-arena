import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

// Every metric is labelled with the Pod name so a dashboard can break results
// down per replica, or sum across them.
registry.setDefaultLabels({ pod: process.env.POD_NAME ?? "local" });

// Node.js process metrics: heap, event loop lag, GC, open handles.
collectDefaultMetrics({ register: registry });

/**
 * A Counter only ever goes up. Rates are computed at query time with
 * rate(...[1m]) rather than being averaged in the application, which keeps the
 * app dumb and lets the dashboard choose the window.
 */
export const httpRequests = new Counter({
  name: "pong_http_requests_total",
  help: "HTTP requests handled",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

/**
 * Buckets matter more than the histogram itself. These are chosen around the
 * latencies we actually measured under load (median ~115ms, p95 ~670ms), so
 * the quantiles land inside buckets rather than being interpolated across a
 * huge one.
 */
export const httpDuration = new Histogram({
  name: "pong_http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// A Gauge goes up and down - the current value of something.
export const activeGames = new Gauge({
  name: "pong_active_games",
  help: "Matches currently being simulated by this pod",
  registers: [registry],
});

export const connectedPlayers = new Gauge({
  name: "pong_connected_players",
  help: "WebSocket connections held by this pod",
  registers: [registry],
});

export const matchmakingQueue = new Gauge({
  name: "pong_matchmaking_queue_length",
  help: "Players waiting in the shared Redis queue (cluster-wide)",
  registers: [registry],
});

export const matchesCompleted = new Counter({
  name: "pong_matches_completed_total",
  help: "Matches finished",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const matchDuration = new Histogram({
  name: "pong_match_duration_seconds",
  help: "How long a match lasted",
  buckets: [5, 10, 20, 30, 60, 120, 300],
  registers: [registry],
});

export const wsMessages = new Counter({
  name: "pong_ws_messages_total",
  help: "WebSocket messages",
  labelNames: ["direction"] as const,
  registers: [registry],
});
