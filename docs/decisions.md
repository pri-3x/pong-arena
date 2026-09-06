# Architecture decisions

## ADR-001: Multi-stage Docker build on Alpine
**Decision:** compile TypeScript in a `builder` stage; ship only `dist/` and
production dependencies on `node:20-alpine`.
**Why:** measured 1.66 GB -> 210 MB. Smaller images pull faster, which directly
affects how quickly Kubernetes can start a new Pod during scaling and rollouts.
**Trade-off:** Alpine uses musl libc; native modules occasionally need extra
build tooling. Acceptable so far - revisit if a dependency breaks.

## ADR-002: imagePullPolicy IfNotPresent, no registry (local development)
**Decision:** build images locally and reference them by tag with
`imagePullPolicy: IfNotPresent`.
**Why:** avoids running a registry during early learning phases. `Never` does
not work on this Docker Desktop cluster (separate containerd store on the node).
**Revisit at:** Phase 18 (CI/CD), where images will be pushed to GitHub
Container Registry and pulled by digest.

## ADR-003: kubectl port-forward for external access (temporary)
**Decision:** access services from macOS via `kubectl port-forward`.
**Why:** NodePort is not published to the host on this cluster.
**Revisit at:** Phase 10 (Ingress).

## ADR-004: maxUnavailable 0 for the game server
**Decision:** `maxSurge: 1, maxUnavailable: 0`.
**Why:** game servers hold long-lived WebSocket connections. Never reducing the
ready replica count below the desired count avoids dropping capacity mid-match.
**Note:** this alone does not protect an in-progress match - a terminating Pod
still drops its connections. Graceful match draining is a later problem.

## ADR-005: Redis for matchmaking, not sticky sessions
**Decision:** shared matchmaking queue in Redis; whichever Pod completes the
match owns the simulation; the other Pod relays over Redis pub/sub.
**Alternatives considered:**
- *Sticky sessions / session affinity* - route both players to one Pod. Needs
  the client to be redirected to a specific Pod, which needs individually
  addressable Pods (headless Service + StatefulSet) and a client reconnect. It
  avoids relaying state through Redis, and is what a latency-sensitive
  production system would likely do.
- *One Pod per game* - maximum isolation, but Pod startup is seconds and a match
  is tens of seconds. Rejected as disproportionate.
**Why this one:** it works with an ordinary ClusterIP Service and a stateless
Deployment, which is what we want to keep learning against. The cost is that a
cross-Pod match's state snapshots pass through Redis at 30 Hz.
**Measured cost:** not yet. To be quantified under load in Phase 14.

## ADR-006: Redis on a Deployment with emptyDir, not a StatefulSet
**Decision:** run Redis as a 1-replica Deployment with `emptyDir` storage and
persistence disabled.
**Why:** everything we keep in Redis is ephemeral. If Redis restarts, queued
players requeue and in-flight matches are lost - annoying, not corrupting.
Paying for PersistentVolumes here would teach the wrong lesson about when
persistence is actually required.
**Revisit at:** Phase 9, where PostgreSQL genuinely needs durable storage.
**Not production-ready:** a single Redis replica is a single point of failure
with no failover. Production would use Redis Sentinel or a managed service.

## ADR-007: Pod-scoped pub/sub channels, not room-scoped
**Decision:** each Pod subscribes to `pod:<name>:msg` and `pod:<name>:input`.
**Why:** rooms are created and destroyed constantly. Subscribing per room means
a SUBSCRIBE/UNSUBSCRIBE round trip on every match start and end. Two fixed
channels per Pod plus a map lookup in application code is cheaper and simpler.
**Trade-off:** every Pod receives messages for all of its own players rather
than only the rooms it participates in. That is the same volume of traffic,
just not partitioned by room.
