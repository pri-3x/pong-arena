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

## ADR-008: scrypt for password hashing
**Decision:** hash passwords with Node's built-in `crypto.scrypt`
(N=32768, r=8, p=1), storing parameters and a per-user salt alongside the hash.
**Why:** general-purpose hashes (SHA-256) are designed to be fast, which is
exactly wrong for passwords - a GPU tries billions per second. scrypt is
deliberately slow and memory-hard. It ships inside Node, so there is no native
module to compile, which keeps the Alpine image small and the build simple.
**Alternative:** argon2 is the modern first choice and would be the pick if we
were willing to add a native dependency.
**Verification:** the stored value contains no plaintext, and two users with
identical passwords have different salts and different hashes.

## ADR-009: JWT for session state
**Decision:** stateless HS256 JWTs, verified with a pinned algorithm list.
**Why:** the WebSocket handshake needs to establish identity without a database
round trip, and a signed token does that. The algorithm is pinned because
accepting the token's own `alg` header is a classic vulnerability (`alg: none`).
**Trade-off:** a JWT cannot be revoked before it expires. TTL is 24h. If
revocation becomes necessary, the fix is a deny-list in Redis - which is exactly
the kind of small, fast, ephemeral state Redis is already there for.
**Note:** a JWT is signed, not encrypted. Anyone can read its contents.

## ADR-010: sessionStorage, not localStorage, for the token
**Decision:** keep the token in `sessionStorage`.
**Why:** `localStorage` is shared by every tab on an origin, so signing in as a
second player in a second tab silently replaces the first tab's identity. This
was observed directly - a match rendered as "grace vs grace". `sessionStorage`
is per-tab, which lets one browser hold two players.
**Trade-off:** closing the tab signs you out. Acceptable for a game session, and
it makes local two-player testing and demoing trivial.

## ADR-011: PostgreSQL on emptyDir (deliberately temporary)
**Decision:** for Phase 6 only, run PostgreSQL with `emptyDir` storage.
**Why:** to demonstrate the failure rather than assert it. Deleting the Pod
destroyed every account AND every table - `psql` reported "Did not find any
relations." That is the concrete motivation for PersistentVolumes.
**Revisit at:** Phase 9. This is not a defensible configuration for anything.

## ADR-012: the Pod that owns the room writes the result
**Decision:** the match result is persisted by the Pod running the simulation,
in the single `finish()` path, wrapped in a transaction.
**Why:** only one Pod runs the loop, so there is exactly one writer and no
coordination is needed to avoid duplicate rows. A `finished` flag guards against
`finish()` being called twice (win and disconnect can race).
**Known gap - measured, not theoretical:** if that Pod is SIGKILLed mid-match
the result is lost entirely. Demonstrated: a live match with 73 state updates,
owner killed, neither player received `end`, and the recorded match count stayed
at 2. This shares a root cause with the Phase 5 stranded-player gap; both are
fixed by a room heartbeat in Redis plus a reaper, in Phase 16.

## ADR-013: abandoned matches are stored but do not count for ranking
**Decision:** a match that ends because someone disconnected is written to
history with `end_reason = 'opponent_left'`, and the leaderboard query filters
to `end_reason = 'win'` only.
**Why:** the remaining player is told they won, which is the right in-game
behaviour, but awarding a leaderboard win for an opponent quitting makes the
ranking farmable - disconnect-on-losing would become a strategy.
**Trade-off:** a player who genuinely loses connection is not penalised either,
which is the more forgiving error.

## ADR-014: aggregate participants in SQL, not in application code
**Decision:** history queries use `json_agg` to build each match's player list
inside Postgres.
**Why:** the obvious implementation - fetch N matches, then query participants
for each - is a classic N+1. One query returns everything.

## ADR-015: ConfigMap by envFrom, Secret by envFrom, Pod facts inline
**Decision:** the game server pulls all of `pong-config` and `pong-secrets` with
`envFrom`; PostgreSQL pulls individual keys with `configMapKeyRef`/`secretKeyRef`.
**Why:** `envFrom` means new settings need one ConfigMap edit rather than a change
to every Deployment. PostgreSQL takes individual keys because the shared
ConfigMap carries Redis settings that are meaningless to it, and injecting
unrelated variables into a container is noise at best.
**Note:** `POD_NAME` stays an inline `fieldRef` - it is a property of the Pod,
not configuration.

## ADR-016: secrets generated by script, never committed
**Decision:** `scripts/create-secrets.sh` generates values with `openssl rand`
and pipes them straight into the cluster. `k8s/secret.example.yaml` documents the
required keys with placeholder values.
**Why:** the keys need to be discoverable by a new developer; the values must not
be in git. Generating in the script means no plaintext ever touches disk.
**On the values already committed in Phase 6:** they were rotated. Removing them
from HEAD would not remove them from history - `git log -S` still finds them in
b16fdd7. Rotation is the only real remedy for a leaked secret.

## ADR-017: config checksum annotation to force a rollout
**Decision:** `scripts/apply.sh` stamps a hash of the ConfigMap and Secret onto
the Pod template.
**Why:** Kubernetes does not restart Pods when a ConfigMap changes, because env
vars are injected once at container start. Without this, a config change appears
to succeed and silently does nothing.
**Alternative rejected:** mounting config as a volume does update in place, but
the application would need to watch the file and reload, which is more machinery
than a rolling restart.
**Superseded at:** Phase 19 - Helm does this with `checksum/config` annotations.

## ADR-018: PostgreSQL as a StatefulSet with volumeClaimTemplates
**Decision:** replace the Deployment + emptyDir with a StatefulSet, a headless
Service, and a 2Gi PVC from `volumeClaimTemplates`.
**Why:** emptyDir destroyed the database three times during Phases 6-8 - once
deliberately, once on an image rollout, once when the Secret reference changed.
A StatefulSet gives stable Pod identity and a claim that follows the Pod.
**Verified:** deleting `postgres-0` and even deleting the entire StatefulSet both
preserved the data; the recreated Pod rebound to the same PersistentVolume.
**Not production-ready:** no backups, no replication, no failover, single Pod.
Production would use a managed database or an operator such as CloudNativePG.

## ADR-019: Redis stays a Deployment with emptyDir
**Decision:** do not give Redis persistent storage.
**Why:** every key in Redis is recreatable - the matchmaking queue, presence
records with a 10s TTL, and fire-and-forget pub/sub. Losing them costs players a
requeue. Adding a PVC would imply the data matters more than it does and teach
the wrong instinct: persistence is about whether data can be rebuilt, not about
how important it feels.
**Revisit if:** Redis ever holds something authoritative, e.g. if match results
were buffered there before being written to PostgreSQL.

## ADR-020: Ingress for external access, replacing kubectl port-forward
**Decision:** install ingress-nginx and route by path at the Ingress rather than
inside the web Pod's nginx.
**Why:** port-forward is a developer tool, not an access method - it died
repeatedly during Phases 6-9 whenever a Pod was replaced. The Ingress controller
gets a LoadBalancer Service, which Docker Desktop maps to localhost:80, so the
app has a stable address.
**Critical detail:** `proxy-read-timeout` and `proxy-send-timeout` are raised to
3600s. nginx defaults to 60s, which would silently disconnect every match after
a minute. This is the most common way an Ingress breaks a WebSocket application.
**Note:** a second host-less rule is included so `http://localhost` works
without editing /etc/hosts; `pong.local` demonstrates host-based routing.

## ADR-021: liveness checks nothing, readiness checks everything
**Decision:** `/health` (liveness) has no external dependencies; `/ready`
(readiness) checks PostgreSQL and Redis.
**Why:** a liveness probe that checks the database converts a database blip into
a cluster-wide restart storm, killing every in-progress match. The correct
reaction to a broken dependency is to stop receiving traffic, which is what a
readiness failure does.
**Verified:** an unready Pod was removed from the Service endpoints with
`RESTARTS=0` and kept running; 12 requests through the Ingress all reached the
healthy Pod with zero errors.

## ADR-022: startupProbe rather than a long initialDelaySeconds
**Decision:** use a `startupProbe` with `failureThreshold: 30, periodSeconds: 2`.
**Why:** `initialDelaySeconds` on the liveness probe is a fixed guess - too short
and a slow boot is restarted in a loop, too long and a genuinely hung process is
left running. A startup probe suppresses liveness until boot completes, then
liveness runs at its normal fast cadence.

## ADR-023: Guaranteed QoS for PostgreSQL, Burstable for everything else
**Decision:** PostgreSQL gets `requests == limits` (250m CPU / 512Mi); the game
server, web and Redis get requests well below their limits.
**Why:** QoS class determines eviction order when a node is under memory
pressure. The database is the one component whose loss is expensive and slow to
recover, so it should be evicted last. Stateless replicas are cheap to lose and
are deliberately left Burstable so they can use spare capacity.
**Values:** chosen to fit comfortably on a 10-core / 8Gi laptop with room for
the HPA to scale game-server to ~8 replicas in Phase 13.
