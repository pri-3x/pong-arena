# Learning log

## Phase 0 - Environment

| Tool | Version |
|---|---|
| Node.js | v20.20.1 |
| npm | 10.8.2 |
| Docker | 29.4.1 (Docker Desktop) |
| Docker Compose | v5.1.3 |
| kubectl | v1.34.1 |
| Cluster | docker-desktop, 1 node, v1.34.3 |

## Phase 1 - Service, image, container

Built a minimal Fastify service exposing `GET /health` and `GET /whoami`.

**Image vs container.** An image is a read-only snapshot (a class / a recipe).
A container is a running process created from it (an object / a cooked meal).
One image ran three containers simultaneously, each with its own hostname.

**Measured:** naive `FROM node:20` + `COPY . .` produced a **1.66 GB** image.
Multi-stage build on `node:20-alpine` producing only `dist/` + prod deps:
**210 MB**. Same application, 8x smaller.

**Gotchas learned:**
- Bind to `0.0.0.0`, not `127.0.0.1`. A container's localhost is internal to
  the container, so `-p` port mapping would connect to nothing.
- The app runs as PID 1. PID 1 gets no default signal handlers, so `SIGTERM`
  must be handled explicitly or `docker stop` hangs for 10s then kills hard.
- Dockerfile layer order matters: copy `package*.json` and `npm ci` BEFORE
  copying `src/`, so a code edit does not invalidate the dependency cache.
- Port 3000 on this machine was already taken by another container, but the
  container could still listen on 3000 internally - separate network namespace.

## Phase 2 - Pod and Service

**Pod.** Smallest unit Kubernetes schedules; a wrapper around one or more
containers sharing a network namespace. Not the same thing as a container.

**Pod IPs are internal and unstable.** `10.244.0.9` was unreachable from macOS
and would change on every recreate.

**Service.** A stable name + virtual IP that routes to whatever Pods currently
match its `selector`. The link is plain label matching:

```
Pod   metadata.labels: app=game-server
Service spec.selector: app=game-server
```

Debug command when a Service "doesn't work":
`kubectl get endpoints <svc>` - empty ENDPOINTS means the selector matched
nothing, which is a labelling bug, not a network bug.

**ClusterIP vs NodePort.** ClusterIP is cluster-internal only. NodePort also
opens a 30000-32767 port on the node; on this cluster that port is reachable
from inside the cluster but not from macOS.

**Service discovery.** `http://game-server:3000` resolves via CoreDNS from any
Pod. Long form: `game-server.default.svc.cluster.local`.

### Troubleshooting: ErrImageNeverPull

`imagePullPolicy: Never` failed with `ErrImageNeverPull` even though
`docker images` listed the image. Cause: this Docker Desktop cluster runs the
node in an isolated VM with its own containerd image store, separate from the
host Docker store. `IfNotPresent` works because Docker Desktop resolves host
images at pull time. Diagnosed with `kubectl describe pod` -> Events section.

## Phase 3 - Deployment, ReplicaSet, rolling updates

**Bare Pods are not self-healing.** Deleting the Pod from Phase 2 removed it
permanently and left the Service with `ENDPOINTS: <none>`.

**Hierarchy:**
```
Deployment  (declares desired state + update strategy)
  └─ ReplicaSet  (keeps exactly N Pods alive)
       └─ Pods
```

**Demonstrated:**
- Load balancing: 10 requests through the Service hit both replicas
  (6 / 4 split - kube-proxy picks a backend at random, not round-robin).
- Self-healing: deleted a Pod, a replacement was created within 1 second.
- Scaling: `kubectl scale --replicas=5` then back to 2.
- Rolling update v1 -> v2 with `maxSurge: 1, maxUnavailable: 0`.
- Rollback.

**Measured:** 300 consecutive `/health` requests during a rollout:
`ok=300 fail=0`. Zero downtime, because `maxUnavailable: 0` guarantees the
Service always has ready endpoints.

**Gotcha learned - imperative commands create revisions.** Running
`kubectl set image` and `kubectl set env` as two separate commands created two
revisions. `kubectl rollout undo` reverts exactly ONE revision, which landed on
the half-applied intermediate state (new image, old env var). Fix: treat the
YAML manifest as the source of truth and use `kubectl apply`.

## Phase 4 - Real-time Pong over WebSockets

### Why WebSockets and not HTTP

HTTP is request/response: the server can only speak when spoken to. A game needs
the server to push 30 updates per second unprompted. A WebSocket starts as an
ordinary HTTP request carrying `Upgrade: websocket`, and after the handshake the
same TCP connection becomes a two-way message channel that stays open.

### Server-authoritative design

The client may influence exactly one value: `dir`, the direction of its own
paddle (-1/0/1). Ball position, collisions, and score exist only on the server.
A player editing the JavaScript in devtools can move their paddle but cannot
move the ball or change the score.

The server also clamps everything it is given: paddle position is clamped to the
field, `dir` is coerced to -1/0/1, and the display name is truncated to 20
characters. **Never trust the client** is not a slogan here, it is three
specific lines of code.

### Simulation

- Fixed timestep: 60 Hz with a **constant** dt, not measured wall-clock time.
  A constant dt keeps the simulation deterministic and stops a slow tick from
  teleporting the ball.
- Broadcast at 30 Hz (every 2nd tick) - half the bandwidth for the same game.
- Collision uses a **crossing** test (did the ball pass through the paddle's
  plane this tick?) rather than an **overlap** test. At 700 px/s the ball moves
  ~12 px per tick, which is the width of the paddle, so an overlap test would
  let fast balls tunnel straight through.

### Client rendering

The canvas draws only what the server sent. Snapshots arrive at 30 Hz but the
browser paints at 60 fps, so the client interpolates between the two most recent
snapshots. Snapshots are kept in a React `ref`, not state - calling `setState`
30 times a second would re-render the whole component tree.

Input is sent **on change only**. Holding a key is one message, not 60/second.

### Verification

Physics tests (`npm run test:physics`), pure functions, no networking:
```
PASS  ball never escapes the field vertically
PASS  paddle cannot leave the field
PASS  a perfectly-tracking paddle always returns the ball
PASS  ball speed is capped (no tunnelling at max speed)
PASS  game ends at WIN_SCORE with a winner
```

Integration test - two bot clients play a real match over WebSockets:
```
PASS  both players joined the SAME room
PASS  first player got left, second got right
PASS  both received many state updates (350/350)
PASS  both agree on the winner (left)
PASS  winner reached 5 (score {"left":5,"right":0})
PASS  the winner is the one with 5 points
PASS  both players are on the same server instance
```

Browser check: two tabs, both reported ball `[251,324]` at the same instant and
a final score of `[3,5]` - identical state, different perspectives ("You won!"
appeared only for the winner).

**Bug found and fixed:** the winning point ends the match instantly, so no
further `state` message ever carried it and the board froze one point short
(showing 4 while announcing a winner). Fixed by patching the last snapshot with
the authoritative score from the `end` message.

**Bug found in the test, not the server:** the first bot never scored because
the effective hit box is `PADDLE_H + 2*BALL_R` = 96 px tall, so a 42 px aiming
error still connects. Calibrated by measurement: an error of 45 px still returns
every ball, 55 px misses. The threshold is exactly 48 px, as the code implies.

### The problem this creates (-> Phase 5)

Matchmaking and rooms live in **one process's memory**. Deployed with
`replicas: 2` and one player port-forwarded to each Pod:

```
ws -> pod game-server-...-2gvf2   got: waiting          <- stuck forever
ws -> pod game-server-...-zcn49   got: waiting          <- stuck forever
```

Both players on the SAME Pod:

```
ws -> pod game-server-...-2gvf2   got: waiting, matched, start, score, score...
ws -> pod game-server-...-2gvf2   got: matched, start, score, score...

pod A /stats: {"activeGames":1,"rooms":1,"connections":2}
pod B /stats: {"activeGames":0,"rooms":0,"connections":0}
```

The Service load-balances each new connection to a random Pod, so with 2
replicas two players have roughly a 50% chance of never meeting. Scaling out
made the application *worse*. This is what shared state (Redis) fixes.

## Phase 5 - Redis: shared state across replicas

### The problem, restated

At the end of Phase 4, `replicas: 2` broke the game: the matchmaking queue lived
in one process's memory, so two players routed to different Pods each waited in
their own queue forever. Scaling out made the application worse.

Two separate things had to be fixed, and they are worth keeping distinct:

1. **Finding an opponent** - needs *shared state*. Solved by Redis.
2. **Playing the match** - needs the two players' sockets, which live on
   different Pods, to reach the one process running the simulation. Solved by
   Redis pub/sub messaging.

Only the first one is what people usually mean by "add Redis". The second is the
harder half.

### Atomic matchmaking

The queue is a Redis list. The operation "take an opponent, or queue myself" must
be atomic:

```lua
local opponent = redis.call('RPOP', KEYS[1])
if opponent then return opponent end
redis.call('LPUSH', KEYS[1], ARGV[1])
return false
```

Done as two separate commands (RPOP then LPUSH) there is a race: two players can
both RPOP nothing, then both LPUSH, and end up queued behind each other having
never matched. Redis executes a Lua script as a single atomic unit.

### Room ownership and the message bus

Whichever Pod completes the match **owns** the room and runs the simulation.
The other Pod holds a socket and acts as a relay:

```
  player A                                        player B
     |                                               |
     v                                               v
  pod-A  --- input via pod:<owner>:input --->  pod-B (OWNER)
     ^                                          | runs the 60Hz loop
     +------ state via pod:<pod-A>:msg ---------+
```

Each Pod subscribes to exactly **two** channels named after itself, not one
channel per room. Rooms are created and destroyed constantly; churning
SUBSCRIBE/UNSUBSCRIBE per match would be far more work than filtering two
channels in application code.

The key design detail is that `Room` never learns any of this. A player is just
`{ id, name, side, send }`. For a local player `send` writes to a socket; for a
remote player `send` publishes to Redis. One function pointer is the entire
difference.

**Pub/sub is fire-and-forget.** If nobody is subscribed when a message is
published, it is dropped. That is fine for paddle input and state snapshots
(another arrives in 33 ms). It would NOT be acceptable for "save this match
result", which is why Phase 7 will use PostgreSQL for that.

### Presence via TTL

Each Pod writes `presence:<pod>` every 2 s with a 10 s expiry. Nothing has to
clean up after a crashed Pod - it stops refreshing and Redis deletes the key.
TTL-as-liveness is far more robust than trying to detect crashes and delete
records explicitly.

Aggregation uses SCAN, not KEYS. KEYS walks the whole keyspace in one blocking
operation and stalls every other client; SCAN does the same work in small
interruptible batches.

### Verification

The same cross-pod test that failed in Phase 4, run against two real Pods:

```
PASS  joining enqueues the player (0 -> 1)
PASS  disconnecting removes the ticket (1 -> 0)
PASS  players are on different instances (...-hj872 vs ...-qgxcd)
PASS  both joined the same room (197949c4)
PASS  they got opposite sides (left / right)
PASS  both received state updates
PASS  BOTH paddles responded to input across pods {"left":-186,"right":-186}
PASS  both clients see the same world
PASS  cluster reports 2 live pods
PASS  cluster sees 2 more players online
PASS  cluster sees 1 more active game
PASS  both pods give the same cluster-wide answer
```

The intermediate broken state was observed deliberately. With the Redis queue in
place but input forwarding still missing, a cross-pod match ran and rendered
correctly for both players, but one paddle was dead:

```
paddle movement: {"left":0,"right":-186}     <- left player was holding UP
```

After adding input forwarding: `{"left":-186,"right":-186}`.

### Failure testing (preview of Phase 16)

**Graceful Pod deletion** (`kubectl delete pod`) is handled correctly. SIGTERM
runs our shutdown handler, the socket closes, the room awards the win to the
remaining player, and the `end` message reaches them over Redis:

```
p1 (surviving pod): msgs=[waiting,matched,start,score,score,end]  closed=false
p2 (dying pod):     msgs=[matched,start,score,score]              closed=true
```

**Hard failure** (`--force --grace-period=0`) is NOT handled:

```
p1 (surviving pod): msgs=[waiting,matched,start]  closed=false  msSinceState=8432
p2 (dying pod):     msgs=[matched,start]          closed=true
```

The surviving player is stranded: their socket stays open, state updates simply
stop, and they never learn the match is over. **Known limitation.** The fix is a
room heartbeat in Redis plus client-side stall detection, which we will build in
Phase 16 rather than pretending it already works.

**Incidental finding:** `kubectl exec <pod> -- kill -9 1` does nothing. The Linux
kernel refuses signals to PID 1 from inside its own PID namespace unless the
process installed a handler, and SIGKILL cannot be handled. The Pod stayed
`Running` with `RESTARTS 0`. To simulate a hard crash, force-delete the Pod.

## Phase 6 - Authentication and PostgreSQL

### Why a second database

Redis already stores state, so why add PostgreSQL? Because they answer different
questions:

| | Redis | PostgreSQL |
|---|---|---|
| Holds | matchmaking queue, presence, pub/sub | users, matches |
| If it is lost | players requeue; annoying | accounts destroyed; unacceptable |
| Access pattern | one key at a time, very fast | queries, joins, constraints |
| Guarantees | fire-and-forget | transactions, foreign keys, uniqueness |

The rule is not "Redis is a cache". It is: **can this data be recreated?** The
matchmaking queue can. A user account cannot.

### Password hashing

Stored as `scrypt$N$r$p$salt$hash`. The three things that matter:

1. **Slow on purpose.** SHA-256 is built to be fast, which is exactly wrong -
   a GPU tries billions of guesses per second. scrypt is deliberately slow and
   memory-hard.
2. **A random per-user salt.** Two people with the same password get different
   hashes, so cracking one reveals nothing about the other. Verified directly:
   two accounts with an identical password have different salts.
3. **Constant-time comparison.** `===` returns as soon as two bytes differ, and
   that timing difference leaks the hash a byte at a time. `timingSafeEqual`
   always takes the same time.

### Not leaking which usernames exist

A wrong password and a non-existent user return the *same* 401 and the *same*
message. Distinguishing them turns the login form into a tool for discovering
who has an account. There is a test asserting the two responses are identical.

### JWT

Identity comes from the signed token, never from what the client claims. The old
`{"t":"join","name":"alice"}` is gone; it is now `{"t":"join","token":"..."}` and
the server reads the username out of the verified signature.

Two details:
- The algorithm is **pinned** to HS256. Accepting the token's own `alg` header is
  a classic vulnerability - an attacker sends `alg: none` and the signature is
  no longer checked.
- A JWT is **signed, not encrypted**. Anyone can base64-decode and read it.
  Never put a secret inside one.

Tests cover a tampered signature and an edited payload; both are rejected.

### Migrations with a cluster-wide lock

Every replica runs migrations at startup, so they all try at once.
`pg_advisory_lock(727001)` is a Postgres-wide mutex: the first Pod applies the
migrations, the rest block and then find nothing to do.

```
game-server-546dd7ff7-ctw6j: 1 migration(s) applied
game-server-546dd7ff7-m5sfs: 0 migration(s) applied
```

Without it, concurrent `CREATE TABLE` statements race and a Pod crashes on boot.

### Liveness vs readiness (groundwork for Phase 11)

Two endpoints now exist, and the difference matters:

- `/health` checks **nothing** external. It answers "is this process alive?" If
  it depended on Postgres, a database blip would make Kubernetes restart every
  healthy game server and turn a small outage into a large one.
- `/ready` checks Postgres and Redis. It answers "can this process do useful
  work?" The right response to a broken dependency is to stop receiving traffic,
  not to be restarted.

### Bugs found

**A user could be matched against themselves.** Two tabs signed into one account
were paired into a match. It rendered as "grace vs grace". This would have
exploded in Phase 7, because `match_players` has `PRIMARY KEY (match_id,
user_id)` and recording that match would violate it. The matchmaker now puts
both tickets back and keeps waiting.

**localStorage is shared across tabs.** Signing in as a second player in a
second tab silently replaced the first tab's identity - which is how the
self-match bug surfaced. Switched to `sessionStorage`, which is per-tab.

### Proving why databases need persistent storage

PostgreSQL was deployed on `emptyDir` on purpose, then the Pod was deleted:

```
before:  users = k8suser, ada, grace
after:   ERROR: relation "users" does not exist
         \dt -> Did not find any relations.
```

Not just the rows - the entire schema. `emptyDir` is scratch space tied to the
Pod's lifetime.

One good property did show up: restarting the game servers rebuilt the schema
automatically, because migrations run on boot and `schema_migrations` was gone
too. The structure recovers on its own; the data does not.

This is the concrete motivation for **Phase 9: PersistentVolume,
PersistentVolumeClaim, StatefulSet.**

## Phase 7 - Match history and leaderboard

### One writer, one code path

Both ways a match can end - somebody reaches 5, or somebody disconnects - now
funnel through a single private `finish()` method on `Room`. It sets the final
state, stops the loop, broadcasts `end`, and emits the result for persistence,
guarded by a `finished` flag so a win and a disconnect racing cannot record the
same match twice.

Because only the Pod that *owns* a room runs its loop, there is exactly one
writer per match. No distributed coordination is needed to avoid duplicates -
the ownership model from Phase 5 gave us that for free.

A `roster` was added alongside `players`: `players` is removed from when someone
disconnects, but we still need to know who took part in order to record the
match. Two maps, different lifetimes.

### Transactions

A `matches` row without its `match_players` rows is worse than no row at all -
it would appear in history as a match with no participants. The insert is
wrapped in BEGIN/COMMIT so either all three rows land or none do.

### Avoiding N+1

The obvious history implementation fetches N matches, then queries participants
for each: 1 + N queries. Instead Postgres aggregates participants into JSON:

```sql
json_agg(json_build_object('username', u.username, 'side', mp.side,
                           'score', mp.score, 'won', mp.won) ORDER BY mp.side)
```

One query, regardless of how many matches are returned.

### A product decision encoded in a WHERE clause

Abandoned matches are stored with `end_reason = 'opponent_left'` and appear in
history, but the leaderboard joins only `end_reason = 'win'`. The remaining
player is still told they won - that is correct in-game - but a leaderboard win
for an opponent quitting would make disconnect-on-losing a winning strategy.

Verified: after an abandoned match, ada's history shows it, and her win count
went `1 -> 1`.

### Verification

19 assertions covering a full authenticated cross-pod match, persistence, and
the query endpoints:

```
PASS  exactly one new match was recorded (0 -> 1)
PASS  the stored room_id matches the played room (ca70a429)
PASS  both usernames stored (local_ada, local_grace)
PASS  the winner's stored score is 5
PASS  local_ada: 1W 0L   /   local_grace: 0W 1L
PASS  the leaderboard is sorted by wins
PASS  ?username= returns only that player's matches
PASS  limit is clamped server-side
```

Plus 6 covering abandonment, including that it does NOT add a leaderboard win.

### The durability gap, measured

If the Pod owning the simulation is SIGKILLed mid-match, the result is lost:

```
room dc9869d0 live, 73 state updates delivered
roomsOwnedHere: pod-A=0 pod-B=1      <- pod-B owns it
>>> SIGKILL pod-B
players received: {"p1end":null,"p2end":null}     <- nobody was told
matches before: 2   matches after: 2              <- nothing was written
```

This is the **same root cause** as the Phase 5 stranded-player gap: the owning
Pod is a single point of failure for a match in progress, and pub/sub is
fire-and-forget. One fix addresses both - a room heartbeat in Redis plus a
reaper that finalises orphaned rooms. Deferred to Phase 16 rather than claimed
as working.

### Methodology note

A test run through a single Service port-forward reported both players on the
same Pod. That is a property of `kubectl port-forward svc/...`, which pins to
one Pod - not a defect. The assertion now only runs when the two clients are
actually pointed at different endpoints, and says so otherwise. A test that
silently passes for the wrong reason is worse than no test.

## Phase 8 - ConfigMaps and Secrets

### The split

`ConfigMap` holds settings; `Secret` holds credentials. The useful test is not
"is it a string?" but **"would I mind this appearing in a screenshot?"**

The game server uses `envFrom` to pull in every key from both objects at once,
so adding a setting later means editing one ConfigMap rather than every
Deployment. PostgreSQL pulls individual keys with `configMapKeyRef` /
`secretKeyRef`, because the ConfigMap also carries `REDIS_HOST` and friends,
which mean nothing to a database.

`POD_NAME` stays as an inline `fieldRef`. It is a fact about the Pod, not
configuration.

### Secrets are base64, not encryption

Demonstrated rather than asserted:

```
$ kubectl get secret pong-secrets -o jsonpath='{.data.JWT_SECRET}' | base64 -d
af8a5bcc6a0895a1c35b4145…
```

What a Secret really buys you: it is a separate object that can be kept out of
git, it is covered by RBAC separately from ConfigMaps, and its values are not
echoed in `kubectl describe pod`. What it does not buy you: encryption at rest
(etcd stores it base64 unless the cluster has an `EncryptionConfiguration`), or
any protection from someone who can read Secrets in the namespace.

For anything real the Secret object is a *delivery mechanism*, not storage:
External Secrets Operator, Sealed Secrets, SOPS, or cloud IAM.

### Secrets already in git cannot be un-committed

The Phase 6 manifests had real values in plain text, and `git log -S` finds them
in `b16fdd7` permanently. Deleting them from HEAD is not a fix. **Rotation is.**
`scripts/create-secrets.sh` generated new values, so the committed ones are now
dead. The habit that generalises: once a secret has been pushed anywhere, assume
it is public.

### Changing a ConfigMap does NOT restart Pods

This is the practical trap of the phase:

```
ConfigMap now says: debug
LOG_LEVEL in the pod: info      <- 8 seconds later, same Pod, 0 new restarts
```

Environment variables are injected once, at container start. (A ConfigMap
mounted as a *volume* does update in place after a sync delay; env vars never
do.)

The fix used here is a **checksum annotation** on the Pod template. When the
config changes the checksum changes, the template changes, and the Deployment
performs an ordinary rolling update:

```
LOG_LEVEL info -> debug   checksum 08ce36c540812483 -> 6cde5f8bad87b433   pods replaced
no change                 checksum unchanged                              pods untouched
```

Helm automates this with `checksum/config` annotations (Phase 19).

### Rotation, measured

```
token before rotation: 200
>>> JWT_SECRET af8a5bcc6a08… -> 8bb86b0bbe22…
the SAME token:        401      <- every session invalidated
signing in again:      200
```

A subtlety worth knowing: **rotating `POSTGRES_PASSWORD` does not change an
existing database's password.** PostgreSQL reads that variable only when it
initialises an empty data directory. On a real database you would
`ALTER USER ... WITH PASSWORD` and then update the Secret.

### Gotcha: apply overwrites patch

`kubectl patch configmap` then `scripts/apply.sh` silently loses the patch,
because apply re-applies the file. This cost real debugging time - the checksum
refused to change and the symptom looked like a broken script. It is the same
lesson as `kubectl set image` versus `kubectl apply` in Phase 3: **the YAML file
is the source of truth.**

### emptyDir, a third time

Changing the postgres Secret reference replaced the Pod, and every user and
match was destroyed again. The schema came back on its own, because the game
servers re-run migrations on boot. The data did not.

Phase 9 is next, and at this point it is well earned.

## Phase 9 - PersistentVolumes and StatefulSets

### The model

You write a **PersistentVolumeClaim** ("I need 2Gi, read-write"). The
**StorageClass** dynamically provisions a **PersistentVolume** to satisfy it. You
rarely write a PV by hand.

Proved in isolation before touching the database: a PVC plus a busybox Pod that
appends a line to a file. Delete the Pod, recreate it, and the first line is
still there:

```
written at Fri Sep 11 17:15:29 UTC 2026     <- first pod
written at Fri Sep 11 17:27:25 UTC 2026     <- after deleting and recreating it
```

### WaitForFirstConsumer

A new PVC sits in `Pending` and no PV exists yet:

```
Normal  WaitForFirstConsumer  waiting for first consumer to be created before binding
```

Not a failure. The volume is created only once a Pod needs it, so it lands on the
node that Pod was scheduled to. Binding earlier could strand a Pod away from its
own disk.

### reclaimPolicy is a foot-gun

`standard` uses `reclaimPolicy: Delete`, so deleting the **claim** destroys the
**data**:

```
kubectl delete pvc demo-claim
kubectl get pv  ->  No resources found
```

`Retain` leaves the volume behind for a human to deal with.

### StatefulSet

Three things a Deployment does not give you:

1. **Stable names.** `postgres-0`, not `postgres-546fff955f-dmvcb`.
2. **Stable storage.** `volumeClaimTemplates` gives each replica its own PVC,
   named `data-postgres-0`, which follows that Pod forever.
3. **Stable network identity**, via a headless Service
   (`clusterIP: None`): `postgres-0.postgres.default.svc.cluster.local`.

The test for which to use is **are the replicas interchangeable?** Two
game-server Pods are. Two database Pods are not.

A headless Service deliberately has no virtual IP and does no load balancing -
spreading writes randomly across database replicas is exactly wrong. The plain
name `postgres` still resolves, so `POSTGRES_HOST=postgres` did not change.

### The test that emptyDir failed three times

```
before:  users=2  matches=1   PV=pvc-bb673dcc…
>>> kubectl delete pod postgres-0
after:   users=2  matches=1   PV=pvc-bb673dcc…   (same PV: YES)
         ada, grace
```

And the stronger version - deleting the whole StatefulSet:

```
kubectl delete statefulset postgres
  pods: (none)
  PVC:  data-postgres-0  Bound  2Gi       <- survives
kubectl apply -f k8s/05-postgres.yaml
  users: ada, grace                       <- reattached, intact
```

`volumeClaimTemplates` PVCs are deliberately not garbage-collected with the
StatefulSet. Kubernetes assumes the data is worth more than the tidiness.

### What "persistent" actually means here

Worth being precise about rather than feeling safe:

```
hostPath:      /var/local-path-provisioner/pvc-bb673dcc…_default_data-postgres-0
nodeAffinity:  desktop-control-plane
```

The volume is a **directory on the node**, pinned there by nodeAffinity. It
survives the Pod. It would not survive the node, and the Pod can never be
rescheduled to a different node. On a real cluster the provisioner would be EBS
or Persistent Disk, and the volume would detach and reattach elsewhere.

### Why Redis stayed a Deployment with emptyDir

Deliberate. Everything in Redis here is recreatable: the matchmaking queue,
presence records with a 10 s TTL, and fire-and-forget pub/sub. If Redis
restarts, players requeue.

Persistence is not about how important the data feels. It is about whether the
data can be rebuilt.

### Not production-ready, and why

This StatefulSet has no backups, no replication, no failover, no point-in-time
recovery, and one Pod - so any restart is downtime. For production you would
normally use a managed database, or an operator (CloudNativePG, Zalando,
Crunchy) that actually handles replication and backups. A StatefulSet gives you
a Pod with a disk; it does not give you a database service.

## Phase 10 - Ingress

### What an Ingress is, and is not

A **Service** gets traffic to a set of Pods. An **Ingress** is an HTTP router in
front of Services: it inspects the Host header and URL path and decides which
Service to send the request to. One entry point, many backends.

An Ingress is only a set of rules. Something has to implement them - an
**ingress controller**. We installed ingress-nginx, which is itself a Deployment
plus a LoadBalancer Service. Docker Desktop maps that to `localhost:80`, so the
app finally has a stable address and `kubectl port-forward` is gone.

```
            localhost:80
                 |
        ingress-nginx controller
                 |
     +-----------+------------------+
     | /ws /auth /matches ...       | /
     v                              v
  game-server:3000               web:80
```

### The detail that breaks real-time apps

```yaml
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

nginx defaults to a 60 second proxy read timeout. Without these annotations
every match would be silently disconnected after a minute of play, and it would
look like an application bug. Verified by playing a full authenticated match
over WebSockets through the Ingress: 19/19 assertions passed.

### Ingress vs Service

| | Service | Ingress |
|---|---|---|
| Layer | TCP/UDP (L4) | HTTP (L7) |
| Routes by | label selector | Host header and URL path |
| Gives you | a stable in-cluster address | one external entry point for many Services |
| Needs | nothing extra | a controller to implement it |

### Path routing

Paths are matched **longest-prefix-first**, not in file order. `/` being last in
the YAML is not what makes it the fallback - it is the fallback because every
other rule is a longer prefix.

## Phase 11 - Health probes

### Three probes, three different questions

| Probe | Question | On failure | Checks dependencies? |
|---|---|---|---|
| `startupProbe` | "has it finished booting?" | restart, but only after `failureThreshold` | no |
| `livenessProbe` | "is it alive?" | **restart the container** | **no** |
| `readinessProbe` | "can it serve traffic?" | **remove from Service endpoints** | **yes** |

The startup probe holds the other two off entirely while it runs, so a slow boot
(migrations, warm-up) is not mistaken for a hang and restarted in a loop.

### Why liveness must NOT check the database

This is the rule that matters. `/health` deliberately checks nothing external.
If liveness checked PostgreSQL, a database blip would make Kubernetes restart
*every* healthy game server simultaneously - turning a small dependency outage
into a total outage, and dropping every in-progress match along the way.

`/ready` does check PostgreSQL and Redis, because the correct response to a
broken dependency is to stop taking traffic, not to die.

### Readiness failure, demonstrated

Marked one Pod unready via a debug hook:

```
READY=0/1   STATUS=Running   RESTARTS=0        <- not killed, just deregistered

endpoints:
  10.244.0.85  ready=false
  10.244.0.86  ready=true

12 requests through the Ingress -> 12 served by the healthy pod, 0 errors
```

The Pod kept running the whole time. Had this been a real dependency problem, it
could recover and rejoin without ever being restarted.

### Liveness failure, demonstrated

```
Liveness probe failed: HTTP probe failed with statuscode: 404
Container app failed liveness probe, will be restarted
STATUS=CrashLoopBackOff  RESTARTS=4
```

Note `CrashLoopBackOff` - Kubernetes backs off exponentially rather than
restarting in a tight loop, which is why RESTARTS climbed unevenly.

### A confounded test, caught

The first liveness demo used the game-server image with no database
configuration. It did go to `CrashLoopBackOff`, but for the wrong reason - the
process was exiting because `migrate()` could not reach PostgreSQL, not because
the probe failed. `kubectl describe` showed only `BackOff`, with no
`Liveness probe failed` event, which is what gave it away.

Redone with `nginx:alpine`, which starts cleanly, the probe was unambiguously
the cause. **A test that produces the expected output for the wrong reason is
worse than no test** - the same lesson as the port-forward mix-up in Phase 7.

## Phase 12 - Resource requests and limits

### Requests vs limits

- **Requests** are what the scheduler *reserves*. The sum of requests on a node
  cannot exceed its capacity, so requests decide whether a Pod fits at all. They
  are also the baseline the HPA measures against - without a CPU request there
  is no "percentage of CPU" to autoscale on.
- **Limits** are a hard ceiling.

### The asymmetry that matters

CPU is **compressible**; memory is **not**.

| | At the limit | Measured |
|---|---|---|
| CPU | throttled - you get less, container survives | `limit=100m` -> 109M iterations; `limit=1000m` -> 1149M. Both `Completed`. |
| Memory | **OOMKilled**, SIGKILL, exit code 137 | allocating 300MB against a 100Mi limit -> `reason=OOMKilled exitCode=137`, logs stop at 76MB |

There is no such thing as "throttling" memory. A process asking for a page that
does not exist cannot be made to wait - it has to be killed.

### QoS classes

Kubernetes derives a class from what you set, and it decides eviction order when
a node runs out of memory:

| Class | Condition | Evicted |
|---|---|---|
| `Guaranteed` | requests == limits, for every resource | last |
| `Burstable` | requests < limits | second |
| `BestEffort` | nothing set | **first** |

Before this phase every Pod here was `BestEffort` - the first thing the kubelet
would kill. Now:

```
postgres-0     Guaranteed      <- the database should be the last thing sacrificed
game-server    Burstable
redis          Burstable
web            Burstable
```

### A false negative, caught

The first OOM test allocated 200MB of `Buffer.alloc` against a 100Mi limit and
**completed successfully**. The limit was genuinely applied
(`/sys/fs/cgroup/memory.max` read back exactly 104857600), and swap was disabled
(`memory.swap.max: 0`), so neither explained it.

The cause was the data: `Buffer.alloc` zero-fills, and 200 identical zero pages
are trivially deduplicated by the kernel, so very little physical memory was
ever used. Refilling each buffer with `crypto.randomFillSync` made the pages
incompressible and undedupable, and the Pod was OOMKilled immediately.

Worth remembering when benchmarking anything memory-related: **zeroed test data
does not measure real memory pressure.**

## Phase 13 - Horizontal Pod Autoscaling

### Kubernetes does not measure CPU by default

```
$ kubectl top pods
error: Metrics API not available
```

An HPA reads from the Metrics API, and nothing provides it out of the box.
`metrics-server` has to be installed, and on this cluster it needs
`--kubelet-insecure-tls` because the kubelet serves a self-signed certificate.

This is the step most explanations skip, and it is why "Kubernetes
automatically scales" is misleading: Kubernetes scales on numbers *somebody
supplies*.

### Utilization is a percentage of the REQUEST

```yaml
target:
  type: Utilization
  averageUtilization: 60      # 60% of the 100m CPU request, i.e. ~60m
```

Not a percentage of the limit, and not of the node. This is why Phase 12 had to
come first: **a Pod with no CPU request cannot be autoscaled on CPU at all**,
because there is no denominator.

### Asymmetric behaviour, on purpose

```yaml
scaleUp:   stabilizationWindowSeconds: 30    # react fast
scaleDown: stabilizationWindowSeconds: 300   # react slowly, 1 pod per minute
```

Scaling down is not the mirror image of scaling up. Removing a game-server Pod
drops every WebSocket connection it was holding, so we would rather waste a
little capacity for five minutes than disconnect players during a brief lull.

### minReplicas: 1, not 0

Scale-to-zero sounds attractive with no players, but for a WebSocket service
there would be nothing running to *receive* the connection that triggers the
scale-up. Knative and KEDA solve this with an activator that holds the request;
a plain HPA cannot.

## Phase 14 - Load testing with k6

Full results: [docs/load-testing.md](load-testing.md).

### HTTP load

120 virtual users against `/leaderboard` and `/matches`:

```
31,254 requests    260 req/s    0 errors
avg 188ms   p90 432ms   p95 670ms
HPA: 2 -> 4 -> 5 pods
```

### WebSocket game load

40 concurrent simulated players, each signing in and playing a real match:

```
142 matches started, 112 finished
68,298 state messages received (439/s)
100% WebSocket handshake success, 0 failed checks
median time to find a match: 77ms
```

Live cluster state during the run, from `/cluster`:

```
t+ 28s  pods=5  players=20  games=10
t+ 56s  pods=6  players=29  games=15
t+ 84s  pods=8  players=41  games=19    <- maxReplicas
```

**41 concurrent players in 20 simultaneous matches across 8 Pods**, zero failed
handshakes.

The median time-to-match of 77ms with players spread across 8 Pods is only
possible because the queue lives in Redis - this is Phase 5 paying off under
real load.

### Reading the numbers honestly

- p95 time-to-match of 2.3s is **not latency**. It is a player waiting for an
  opponent to exist. With an odd number of waiting players, somebody waits.
- CPU reached 138% of target at peak. That is not a failure of the HPA - it was
  already at `maxReplicas: 8` and had nothing left to do.
- Both runs were cut short of their full plan when the shell running the
  container timed out. The reported metrics cover the traffic that actually ran.
  Nothing is extrapolated.

## Phase 15 - Observability

Full notes: [docs/observability.md](observability.md).

### Pull, not push

Prometheus scrapes targets it discovers from the Kubernetes API, filtered to
Pods carrying `prometheus.io/scrape: "true"`. The app never pushes anywhere, so
a crashed Pod just stops appearing.

### Four metric types, and when each is right

- **Counter** (only up): requests, matches completed. Never averaged in the app -
  `rate()` is computed at query time.
- **Gauge** (up and down): active games, connected players, queue length.
- **Histogram** (buckets): request duration, match duration.

### Cardinality is the thing that kills Prometheus

Requests are labelled with the **route pattern** (`/matches`), not the URL. One
time series per distinct query string would be unbounded growth.

### Verified against real load

```
sum(pong_active_games)                          16
sum(pong_connected_players)                     35
count(count by (pod) (pong_connected_players))   8
p95 latency                                   0.25 s
matches completed            win=89  opponent_left=35
CPU per pod (cadvisor)          0.068 - 0.096 cores
```

### Two things that cost debugging time

**cAdvisor scrape returned 403.** The ClusterRole needs `nodes/proxy`, not just
`nodes`. Symptom is a target permanently `down`.

**Every time series panel was blank while stat panels worked.** Grafana
Prometheus targets need `"range": true`; without it they run as *instant*
queries, the panel gets one data point, and a line chart of one point draws
nothing. Stat panels want the opposite.

## Phase 16 - Chaos testing, and paying off the Phase 5 debt

Full results: [docs/failure-testing.md](failure-testing.md).

### The heartbeat fix

Since Phase 5 this project carried a measured defect: if the Pod simulating a
match died abruptly, the player on the *other* Pod was never told. Pub/sub is
fire-and-forget, so no message can announce a crash.

The fix is a **lease**, not a message:

- the owning Pod writes `room:<id>:alive` with a 6s TTL, refreshed every 2s
- every Pod sweeps the rooms it is only relaying for; an expired key means the
  owner is gone
- the relaying Pod ends the match locally with `reason: "server_lost"` and
  releases its player

Before / after, same test, same force-delete:

```
Phase 7:  p1 msgs=[waiting,matched,start]              stranded forever
Phase 16: p1 msgs=[waiting,matched,start,end,score]    reason="server_lost"
```

One deliberate choice: if **Redis** is unreachable the sweep assumes rooms are
alive. Declaring every match dead because the coordination layer blinked would
be much worse than a few seconds of delay.

### A failure the chaos suite found

Killing a Pod under live traffic lost **1 request in 60**. Not a fluke - a real
race. Deleting a Pod starts two things concurrently and in no guaranteed order:
the kubelet terminates the container, and the endpoint controller removes it
from the Service. In between, the Pod is still a routing target but already
refusing connections.

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sleep", "8"]
```

`preStop` runs *before* SIGTERM, so the Pod keeps serving while endpoint removal
propagates. Re-measured: **80 requests, 80 x 200, zero failures.**

### The result that validates Phase 11

```
PostgreSQL scaled to 0:
  /ready -> 503   /health -> 200   total restarts: 0
```

A complete database outage caused **zero container restarts**. If liveness had
checked the database, every game server would have been killed at once, every
match dropped, and the Pods would have restart-looped until the database
returned - converting a dependency outage into a total outage.

### The result that validates Phase 9

Restarting Redis lost the matchmaking state and nothing had to be repaired -
presence keys are rewritten every 2s with a TTL, so the state rebuilt itself.
Match history was untouched, because it lives in PostgreSQL.

## Phase 17 - Rolling deployments and rollback

An image whose process exits immediately was deployed under live traffic:

```
game-server-58bd956666-ltlvq  READY=0/1  CrashLoopBackOff  restarts=4
game-server-64c6458ff5-cb946  READY=1/1  Running
game-server-64c6458ff5-kvcxl  READY=1/1  Running

deployment:  READY=2/2   UP-TO-DATE=1   AVAILABLE=2
traffic:     100 requests, 100 x 200
```

`UP-TO-DATE=1, AVAILABLE=2` is the signature of a **stalled** rollout.
Kubernetes created one new Pod, it never became Ready, and so it refused to
remove either old Pod. A completely broken release produced **zero user-visible
impact**.

Rollback took one command and ~10 seconds.

### The safety net needs BOTH parts

`maxUnavailable: 0` alone is not enough, and neither is a readiness probe alone:

- without `maxUnavailable: 0`, Kubernetes may remove a healthy Pod before the
  replacement is ready
- without a **readiness probe**, Kubernetes considers a container "available" as
  soon as the process starts - so a container that starts and immediately
  crashes would still count, and the healthy Pods would be removed

Together they make a bad deploy a non-event.

### maxSurge and maxUnavailable

- `maxSurge: 1` - may temporarily run one extra Pod, so capacity never drops
- `maxUnavailable: 0` - may never have fewer ready Pods than desired

The cost is that a rollout needs room for one extra Pod, and is slightly slower.
For a service holding long-lived WebSocket connections that is the right trade.

## Phase 18 - CI/CD

The pipeline is in [.github/workflows/ci.yml](../.github/workflows/ci.yml):

```
push / PR
   |
   v
 test job          real Redis + PostgreSQL as GitHub Actions services
   |               build -> physics -> auth -> cross-replica -> history
   v
 images job        only on main, only after tests pass
   |               build and push to ghcr.io, tagged with the commit SHA
   v
 (deploy)
```

### Real dependencies, not mocks

The integration tests genuinely need a Redis and a PostgreSQL, so the workflow
declares them as `services:` with health checks. Mocking them would test the
mocks: the entire point of `redis.test.mjs` is that two *separate processes*
coordinate through one real Redis.

### Tag with the commit SHA, never only `:latest`

A mutable tag makes it impossible to know what is actually running, and makes
rollback meaningless - "roll back to :latest" means nothing if :latest just
moved.

`secrets.GITHUB_TOKEN` is injected by Actions and scoped to the repository, so
no long-lived registry credential is stored anywhere.

### Running CI locally found five real bugs

The pipeline was validated by running its exact sequence locally before
committing it. That is where it earned its keep.

**1. `redis.test.mjs` was stale.** It still joined with `{t:"join", name}`,
replaced by tokens in Phase 6. The test had not been run since auth landed.

**2. Heartbeat startup race.** The heartbeat interval fires every 2s, so a room
created just after a tick had no `alive` key for up to two seconds - and the
other Pod's sweep, on its own 2s timer, could look during that window and
declare a brand new match orphaned. Fixed by writing the first beat inside
`join()`, before anyone is told the room exists.

**3. Spurious `server_lost` after every normal match.** When a match ended
properly the owner deleted its heartbeat key (correctly), but the relaying Pod
never cleared `conn.remote`. Two seconds later its sweep found the missing key,
concluded the owner had died, and delivered a SECOND `end` with
`reason: "server_lost"` - overwriting the real result. Winners were being
reported as `null`. Fixed by clearing `conn.remote` when an `end` is relayed.

**4. A test that could not pass.** `history.test.mjs` compared `/matches`
(default limit 20) against `/matches?limit=5` and expected the counts to differ
by one. It worked only while fewer than 20 matches existed. Rewritten to
identify the new match by id.

**5. Leaderboard assertions assumed a small dataset.** After load testing
created 40 bot accounts, the two players under test were no longer in the
default top 20. Fixed by paging explicitly and asserting the ordering property
rather than a specific first row.

Bugs 2 and 3 were in the Phase 16 heartbeat - code that had already passed a
manual chaos test. **The manual test exercised only the failure path; the
automated suite exercised the normal path, which is where the bugs were.** That
is the argument for CI in one sentence.

## Phase 19 - Helm

### What a chart actually is

```
charts/pong-arena/
  Chart.yaml        name, chart version, appVersion
  values.yaml       every knob, with defaults
  templates/        the manifests, with {{ }} placeholders
```

**Chart version and appVersion move independently.** Editing a template bumps
`version`; shipping new application code bumps `appVersion`. The game-server
image tag defaults to `.Chart.AppVersion`, so a release is one line in
Chart.yaml.

A **release** is an installed instance. The same chart installed twice gives two
independent stacks, which is why every name is prefixed with `.Release.Name`.

### The payoff: Helm does the checksum trick for us

Phase 8 needed `scripts/apply.sh` to hash the ConfigMap by hand so that a config
change would actually roll the Pods. Helm does it in one line:

```yaml
checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

It hashes the *rendered* ConfigMap at template time, so a config change alters
the Pod template and triggers a normal rolling update.

### One template detail worth knowing

```yaml
{{- if not .Values.gameServer.autoscaling.enabled }}
replicas: {{ .Values.gameServer.replicas }}
{{- end }}
```

`replicas` is omitted entirely when the HPA is enabled. Leaving it in means
every `helm upgrade` resets the replica count and fights the autoscaler.

### Secrets are deliberately NOT templated

The chart references an existing Secret by name (`existingSecret:
pong-secrets`) created out of band. A credential can then never end up in a
values file that gets committed.

### Installing the chart found a real design flaw

`pong-web` crash-looped on install:

```
[emerg] host not found in upstream "game-server"
```

The nginx config hardcoded the Service name. Helm prefixes Services with the
release name, so it was looking for `game-server` while the Service was
`pong-game-server`.

That is not a Helm problem - it is a latent flaw in the image that only showed
up once something tried to run two copies. The image now reads the upstream
from `GAME_SERVER_HOST` via the nginx image's envsubst templating, with
`NGINX_ENVSUBST_FILTER` limiting substitution so nginx's own `$uri`/`$host`
variables survive.

**Making something reusable is how you discover it was never reusable.**

### Releases, upgrades, rollbacks

```
REVISION  STATUS      CHART             APP VERSION  DESCRIPTION
1         superseded  pong-arena-0.1.0  v18          Install complete
2         superseded  pong-arena-0.1.0  v18          Upgrade complete
3         deployed    pong-arena-0.1.0  v18          Rollback to 1
```

Helm tracks history per release, so `helm rollback pong 1` reverts every object
at once - not just a Deployment's image, which is all `kubectl rollout undo`
can do.

And on uninstall, the StatefulSet's PVC survives:

```
data-pong-postgres-0  Bound
```

Same rule as Phase 9: Kubernetes will not delete your data to tidy up.

### Helm vs plain manifests

| | Plain YAML | Helm |
|---|---|---|
| Parameterisation | copy the file and edit it | one chart, many values files |
| Config change triggers rollout | a script that hashes by hand | built in |
| Rollback | per-object `kubectl rollout undo` | whole release, one command |
| Learning value | you see exactly what is created | indirection hides it |

The raw manifests in `k8s/` are kept deliberately - they are the readable
version, and they are what the earlier phases teach against.

## Guest play and private match codes

Two features, added after the 20 phases: play without an account, and share a
code with a friend to play them directly.

### Guests, without a second code path

A guest gets a **normal signed token** with `guest: true`, whose subject is a
random `guest_<uuid>`. The WebSocket handshake needs no special case - it
verifies a token exactly as before.

The interesting constraint is the database. `match_players` has a foreign key to
`users`, so a guest match cannot be recorded. That turned out to need no new
code: `Room.finish()` already refused to report a result unless both players had
a real `userId`. Guest matches are excluded from history and the leaderboard for
free.

But one thing did need splitting. `Conn` now carries two identities:

```ts
userId: string | null      // real account, nullable. Becomes a foreign key.
identityId: string | null  // who you ARE, guests included. Stops self-matching.
```

Without that split, every guest would have had an empty `userId`, and the
self-match guard (`opponent.userId === conn.userId`) would have treated **two
different guests as the same person** - so no two guests could ever have played
each other.

### Invites: one Redis key, claimed atomically

```
SET invite:<code> <host ticket> EX 900 NX     # NX: two creations cannot collide
GETDEL invite:<code>                           # atomic claim: exactly one winner
```

`GETDEL` is the whole concurrency story. Without it, two people pasting the same
code would both read it as valid and both try to start a match.

The invite lives in Redis for the same reason the matchmaking queue does: the
host and the friend are usually on different Pods, and the host's Pod is not the
one that receives the join.

Codes avoid `0 O 1 I L`. They get read aloud and typed from phone screens.

The UI offers a code **and** a `/?join=CODE` link, because a link is much easier
to send. The client consumes the parameter once and strips it from the URL, so a
refresh does not retry a spent code.

### Refactor first, then add

Both paths now call one private `startRoom(host, joiner)`. The heartbeat, the
metrics, the persistence hook and the local/remote `send` wiring are all subtle;
duplicating them for invites would have created a second place to forget the
first heartbeat - which is precisely the bug described below.

### A bug found while adding a feature: the fix that never landed

Phase 18 claimed to fix a heartbeat startup race. **It did not.** The edit
targeted a code string that a refactor had already changed, so the replacement
silently did nothing - the import was added, the call never was. The commit
message said it was fixed. It was not.

The suite still went green, because the *other* fix in that commit (clearing
`conn.remote` on `end`) resolved the failures being investigated at the time.

The race is **phase-dependent**, which is why it hid for three phases: the
owner's heartbeat interval and the sweeper's interval both run every 2s, and
when both processes start together the timers align so the sweep lands just
after the beat. Matches created at varied offsets hit the gap.

A targeted regression test - many matches started at staggered times - made it
obvious immediately:

```
WITHOUT the fix:   matches started: 10/10    falsely orphaned: 9
WITH the fix:      matches started: 10/10    falsely orphaned: 0
```

**Nine out of ten cross-Pod matches were being killed seconds after starting.**

Two lessons, both already themes of this project:

1. **Verify the edit, not just the test.** A string replacement that matches
   nothing fails silently. `grep` for the change afterwards.
2. **A regression test must be shown to fail.** This one was run against a build
   with the fix removed before being trusted. A regression test that has never
   been red is an assumption wearing a test's clothes.
