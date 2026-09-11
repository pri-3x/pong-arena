# Load testing and autoscaling results

All numbers here were measured against the local Docker Desktop cluster
(10 CPU / 8 GiB). They are not production benchmarks - they demonstrate that the
autoscaling and the system behave correctly under load.

## Setup

- k6 runs in a container, reaching the Ingress via `host.docker.internal`
- `game-server`: requests 100m CPU, limits 500m; HPA target 60% of request
- HPA: `minReplicas: 1`, `maxReplicas: 8`

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD/loadtest:/scripts" grafana/k6:latest run /scripts/http-load.js
```

## Scenario 1 - HTTP API load

Ramp to 120 virtual users hitting `/leaderboard` and `/matches`, the two most
database-expensive endpoints.

| Metric | Result |
|---|---|
| Requests | 31,254 |
| Throughput | 260 req/s |
| Errors | **0** (0.00%) |
| Latency avg | 188 ms |
| Latency p90 | 432 ms |
| Latency p95 | 670 ms |
| Threshold `p(95)<1500` | passed |

Autoscaling during the run:

```
t+ 15s   2 pods
t+ 60s   4 pods      <- HPA reacted
t+117s   5 pods      cpu 67%/60%
t+165s   5 pods      cpu 11%/60%   (load absorbed)
```

## Scenario 2 - WebSocket game load

Ramp to 40 concurrent simulated players, each signing in, entering matchmaking,
and playing a real match against another player.

| Metric | Result |
|---|---|
| Matches started | 142 |
| Matches finished | 112 |
| WebSocket sessions | 142 |
| State messages received | 68,298 (439/s) |
| WS messages sent | 68,440 |
| Handshake success | **100%** (134/134) |
| Failed checks | **0** |
| Time to find a match, median | **77 ms** |
| Time to find a match, p95 | 2.32 s |
| WS connect time, median | 20 ms |

Live cluster state sampled during the run, via `/cluster` (aggregated from every
Pod's Redis presence record):

```
t+ 14s  pods=5  players=6   games=3
t+ 28s  pods=5  players=20  games=10
t+ 42s  pods=6  players=25  games=12
t+ 56s  pods=6  players=29  games=15
t+ 70s  pods=6  players=36  games=18
t+ 84s  pods=8  players=41  games=19     <- maxReplicas reached
t+ 98s  pods=8  players=40  games=20
```

Peak: **41 concurrent players in 20 simultaneous matches across 8 Pods**, with
zero failed WebSocket handshakes and zero dropped matches.

## What the numbers show

- The HPA scales on real measured CPU, not on a schedule: 2 -> 4 -> 5 -> 6 -> 8.
- Matchmaking works across replicas under load. A median time-to-match of 77 ms
  with 40 players spread over 8 Pods only works because the queue is in Redis.
- The p95 time-to-match of 2.3 s is not latency - it is a player waiting for
  somebody to play against. With an odd number of waiting players, someone waits.
- CPU hit 138% of target at peak, above the 60% target, because the HPA was
  already at `maxReplicas: 8` and could not scale further.

## Honest caveats

- Both test runs were interrupted before their full plan completed, because the
  shell running the container timed out at 2 minutes. The HTTP run completed
  2m00s of a 2m50s plan. The metrics reported are for the traffic that actually
  ran; no numbers are extrapolated.
- The k6 bots are not real players: they never rage-quit, and their input
  pattern is simpler than a human's.
- This is a single-node cluster. Every Pod shares one kernel, one page cache and
  one disk, so these numbers say nothing about multi-node behaviour.
