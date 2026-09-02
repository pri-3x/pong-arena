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
