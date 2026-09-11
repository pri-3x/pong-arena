# Resume bullets

Only figures that were actually measured appear here. Nothing is extrapolated,
and nothing describes capacity the project has not demonstrated.

## Three bullets

> **Pong Arena** — Real-time multiplayer game platform on Kubernetes
> *Docker, Kubernetes, WebSockets, Redis, PostgreSQL, Prometheus/Grafana, Helm, GitHub Actions*

- Built a server-authoritative real-time game platform on Kubernetes, running a
  60 Hz simulation with 30 Hz state broadcast over native WebSockets; sustained
  **41 concurrent players in 20 simultaneous matches** across 8 autoscaled pods
  with **zero failed WebSocket handshakes** and a **median 77 ms** time to match.

- Made the service horizontally scalable by moving matchmaking into Redis with
  an atomic Lua script and a room-ownership model that relays input and state
  between pods over pub/sub — the game had previously failed outright at two
  replicas, with players on different pods never matching.

- Hardened the deployment against real failures measured with k6 and chaos
  testing: a **full database outage produced zero container restarts** (liveness
  deliberately checks no dependencies), a deliberately broken release served
  **100/100 requests** while its rollout stalled, and a `preStop` hook removed
  the endpoint-drain race that had cost 1 request in 60 on pod termination.

## Two-bullet version

- Built and operated a real-time multiplayer game platform on Kubernetes
  (Docker, WebSockets, Redis, PostgreSQL, Prometheus/Grafana, Helm, GitHub
  Actions), sustaining **41 concurrent players in 20 simultaneous matches**
  across 8 CPU-autoscaled pods with zero failed handshakes and a median 77 ms
  matchmaking time.

- Diagnosed and fixed the distributed-systems failures that emerged at scale:
  cross-pod matchmaking via an atomic Redis queue, a heartbeat-lease reaper so a
  crashed pod no longer strands its opponent, and a `preStop` drain that took
  pod-termination request loss from 1-in-60 to 0-in-80.

## Notes for interviews

Strongest talking points, in order:

1. **Scaling out made the application worse before it made it better.** At two
   replicas, two players routed to different pods each waited in their own
   in-memory queue forever. Shared state fixed pairing; a pub/sub relay was
   still needed to make the match actually playable.
2. **Why liveness must not check the database.** Verified: scaling PostgreSQL to
   zero produced `/ready 503`, `/health 200`, and **0 restarts**.
3. **A test that passes for the wrong reason is worse than no test.** Caught
   three times in this project: a port-forward that pinned both clients to one
   pod, a CrashLoopBackOff caused by a missing database rather than the probe
   under test, and an OOM test defeated by page-deduplicated zero-filled buffers.
4. **CI found two bugs that manual chaos testing missed**, because the manual
   test exercised only the failure path and the bugs were in the normal path.

## What NOT to claim

- These are single-node local-cluster numbers. They demonstrate correct
  behaviour under load, not production capacity.
- The system is not production-ready: no database backups or replication, a
  single Redis with no failover, and no graceful match draining across rollouts.
