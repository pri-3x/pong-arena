# The tech guide

Every technology in this project, explained.

This is the companion to [learning-log.md](learning-log.md). The learning log is
**chronological** - what happened, in the order it happened. This guide is
**organised by technology**, so you can look something up.

Each section follows the same shape:

> **The problem** - what goes wrong without it
> **The mental model** - the one idea to hold in your head
> **How it is used here** - real files in this repository
> **What bit us** - the specific mistakes, with measurements
> **Try it** - something to run yourself

A note on how to use this: **do not read it front to back.** Build the phase,
then read the section. The explanations land very differently once you have seen
the thing fail.

---

## Table of contents

**Containers** · [Docker](#1-docker) · [Docker Compose](#2-docker-compose)

**Kubernetes** · [Core objects](#3-kubernetes-core-objects) · [Networking](#4-kubernetes-networking) · [Configuration](#5-kubernetes-configuration) · [Storage](#6-kubernetes-storage) · [Health probes](#7-kubernetes-health-probes) · [Resources and QoS](#8-kubernetes-resources-and-qos) · [Autoscaling](#9-kubernetes-autoscaling)

**Application** · [Node, TypeScript, Fastify](#10-nodejs-typescript-and-fastify) · [WebSockets](#11-websockets) · [React, Vite, Canvas](#12-react-vite-and-canvas)

**Data** · [Redis](#13-redis) · [PostgreSQL](#14-postgresql) · [Authentication](#15-authentication)

**Operations** · [Prometheus](#16-prometheus) · [Grafana](#17-grafana) · [k6](#18-k6) · [Helm](#19-helm) · [GitHub Actions](#20-github-actions) · [NGINX](#21-nginx)

[Glossary](#glossary) · [Ten ideas worth keeping](#ten-ideas-worth-keeping)

---

# Containers

## 1. Docker

### The problem

"It works on my machine." Your app needs a particular Node version, particular
system libraries, particular environment variables. Moving it to another machine
means reproducing all of that by hand, and the machine you are moving it to
already has three other projects' requirements installed.

### The mental model

**An image is a class. A container is an object.**

An image is a read-only, layered filesystem snapshot plus metadata (what command
to run, what ports, what environment). A container is a running process using
that snapshot, with its own network namespace, its own process tree, its own
view of the filesystem.

One image, many containers. In Phase 1 we ran three containers from one image
simultaneously; each reported a different hostname.

```
Dockerfile  --build-->  Image  --run-->  Container
 (recipe)              (frozen)          (running)
```

### How it is used here

[`services/game-server/Dockerfile`](../services/game-server/Dockerfile) is a
**two-stage build**:

```dockerfile
FROM node:20-alpine AS builder     # stage 1: has TypeScript, dev dependencies
COPY package.json package-lock.json ./
RUN npm ci                          # cached unless the manifests change
COPY src ./src
RUN npm run build                   # produces dist/

FROM node:20-alpine AS runtime      # stage 2: a fresh, empty image
RUN npm ci --omit=dev               # production dependencies only
COPY --from=builder /app/dist ./dist
USER node                           # do not run as root
```

Nothing from stage 1 reaches the final image except the files explicitly copied.
No TypeScript compiler, no dev dependencies, no build cache.

**Measured: 1.66 GB → 210 MB.** Same application.

### Layer caching, and why the order matters

Each instruction creates a layer. Docker reuses a layer if that instruction and
everything before it are unchanged. So:

```dockerfile
COPY package.json package-lock.json ./   # changes rarely
RUN npm ci                                # slow, but cached
COPY src ./src                            # changes constantly
RUN npm run build                         # fast
```

Reverse those two `COPY` lines and every one-character code edit re-runs
`npm ci`. Rebuild time goes from ~2 seconds to ~30.

### What bit us

**Bind to `0.0.0.0`, not `127.0.0.1`.** A container's `localhost` means *inside
this container*. Bind to `127.0.0.1` and your `-p 3100:3000` port mapping
connects to nothing. This is the single most common first-time Docker bug.

**Your app is PID 1.** Normally PID 1 is the OS init process, which has special
signal behaviour: it gets no default handlers. If you do not handle `SIGTERM`
explicitly, `docker stop` waits 10 seconds and then kills you hard, dropping
in-flight work. See the signal handlers at the bottom of
[`src/index.ts`](../services/game-server/src/index.ts). Kubernetes uses exactly
the same mechanism to stop Pods.

**Port conflicts are not what you think.** Host port 3000 was already taken on
the dev machine, but the container still listened on 3000 *internally* - it has
its own network namespace. Only the host side of the mapping had to change.

**`.dockerignore` matters.** Without it, `COPY . .` ships your local
`node_modules` (wrong architecture, possibly) and `.git`.

### Try it

```bash
cd services/game-server
docker build -t pong:test .
docker images pong:test                    # see the size
docker run -d --name t1 -p 3100:3000 pong:test
docker run -d --name t2 -p 3101:3000 pong:test    # same image, second container
curl localhost:3100/whoami; curl localhost:3101/whoami   # different hostnames
docker stop t1                             # stopped, but still exists
docker ps -a                               # <- proof
docker rm -f t1 t2
docker images pong:test                    # the image is untouched
```

---

## 2. Docker Compose

### The problem

Your app needs Redis and PostgreSQL to run locally. Starting them by hand is
three long `docker run` commands with the right ports, volumes and passwords,
every time.

### The mental model

**Compose is many containers on one machine, declared in a file.** It has no
scheduler, no self-healing, no scaling across machines. It is a convenience for
local development, *not* a small Kubernetes.

### How it is used here

[`docker-compose.yml`](../docker-compose.yml) provides only the backing services
- Redis and PostgreSQL - for running the game server directly on your machine
during development. The application itself is not in there, because during
development you want it running under a file watcher, not in a container.

```yaml
services:
  redis:
    image: redis:7.4-alpine
    ports: ["6380:6379"]        # 6380 on the host, because 6379 was taken
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
  postgres:
    image: postgres:16-alpine
    ports: ["5433:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]   # named volume: data survives
```

Note the asymmetry, and that it is deliberate: Redis gets no volume (its data is
recreatable), PostgreSQL gets a named volume (its data is not). That is the same
rule applied later in Kubernetes.

### Try it

```bash
docker compose up -d
docker compose ps
docker compose exec redis redis-cli PING
docker compose exec postgres psql -U pong -d pong -c '\dt'
docker compose down          # containers gone
docker compose up -d         # ...but the postgres data is still there
```

---

# Kubernetes

Kubernetes is large. The way to learn it is not to read the API reference but to
understand **what problem each object solves**. Every object below was added to
this project at the moment something broke without it.

## 3. Kubernetes: core objects

### The problem

You have a container. You want it to be running. Always. Even if it crashes,
even if the machine it is on dies, and you want ten of them when traffic is high.

### The mental model

**You declare desired state; a controller works continuously to make reality
match.** You never tell Kubernetes to *do* things. You tell it what should be
true, and controllers close the gap. That is the whole system, and every object
below is a variation on it.

```
Cluster           the whole system
  Node            one machine in it
    Pod           the smallest schedulable unit: 1+ containers sharing an IP
```

A **Pod** is not a container. It is a box around one or more containers that
share a network namespace and can share volumes. In practice most Pods hold
exactly one container; the extra layer exists so you can bolt a helper (a log
shipper, a proxy) onto the same IP.

### The hierarchy that actually matters

```
Deployment        "I want 2 of these, and here is HOW to update them"
   └─ ReplicaSet  "I keep exactly 2 Pods alive. That is all I do."
        └─ Pods   the running containers
```

You never create Pods or ReplicaSets by hand. You edit the Deployment; it creates
a new ReplicaSet; that ReplicaSet creates Pods.

**Why the extra layer?** When you change the image, the Deployment creates a
*second* ReplicaSet and scales it up while scaling the first down. The old
ReplicaSet is kept at zero replicas - which is what makes `kubectl rollout undo`
instant. It just scales the old one back up.

### How it is used here

[`k8s/01-deployment.yaml`](../k8s/01-deployment.yaml) - `game-server`, 2 replicas.

### What bit us

**A bare Pod is not self-healing.** In Phase 2 we created a Pod directly, deleted
it, and it stayed dead. The Service's endpoints went to `<none>`. Nobody runs
bare Pods.

A Deployment-managed Pod, deleted, was replaced **in about one second**.

**Imperative commands create revisions you did not intend.** Running
`kubectl set image` and then `kubectl set env` created *two* revisions.
`kubectl rollout undo` reverts exactly one, which landed on the half-applied
intermediate state (new image, old env var). The fix is the habit, not a flag:
**the YAML file is the source of truth**, and you `kubectl apply` it.

### Try it

```bash
kubectl get deploy,rs,pods -l app=game-server
kubectl delete pod -l app=game-server --field-selector=status.phase=Running | head -1
kubectl get pods -l app=game-server -w      # watch the replacement appear
kubectl scale deployment game-server --replicas=5
kubectl scale deployment game-server --replicas=2
```

---

## 4. Kubernetes: networking

### The problem

Pods get IP addresses. Those addresses are internal to the cluster and change
every time a Pod is recreated. You cannot hardcode them anywhere.

### The mental model

**A Service is a stable name that points at whatever Pods currently match a
label selector.** The link is plain string matching - there is nothing clever
about it:

```
Pod     metadata.labels:  app: game-server
                                ↕  must match exactly
Service spec.selector:    app: game-server
```

### Service types

| Type | What it gives you | Used here for |
|---|---|---|
| `ClusterIP` | a virtual IP reachable only inside the cluster | everything internal |
| `NodePort` | additionally opens a port (30000-32767) on every node | demonstrated, then abandoned |
| `LoadBalancer` | additionally asks the cloud for an external IP | how ingress-nginx is reachable |
| headless (`clusterIP: None`) | **no** virtual IP; DNS returns Pod IPs directly | PostgreSQL |

A **headless** Service is what you want for a database: you do *not* want writes
load-balanced randomly across replicas. It gives each Pod its own DNS record:
`postgres-0.postgres.default.svc.cluster.local`.

### Service discovery

CoreDNS runs inside the cluster. From any Pod:

```
http://game-server:3000                              # same namespace
http://game-server.default.svc.cluster.local:3000     # fully qualified
```

This is why nothing in this codebase contains an IP address. `REDIS_HOST` is
`redis`, not `10.96.x.x`.

### Ingress

A Service gets traffic to Pods. An **Ingress** is an HTTP router *in front of*
Services: it reads the Host header and URL path and picks a backend. One entry
point, many services.

An Ingress is only a set of rules - something must implement them. That is an
**ingress controller** (we use ingress-nginx), which is itself just a Deployment
plus a LoadBalancer Service.

```
localhost:80
     |
ingress-nginx controller
     |
     ├── /ws /auth /matches /leaderboard ──> game-server:3000
     └── /                                ──> web:80
```

See [`k8s/06-ingress.yaml`](../k8s/06-ingress.yaml).

### What bit us

**Empty `ENDPOINTS` is a labelling bug, not a network bug.** When a Service
"does not work", the first command is:

```bash
kubectl get endpoints <service-name>
```

Empty means the selector matched no Pods. You have a typo, not a networking
problem.

**WebSockets die silently at 60 seconds without this:**

```yaml
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

nginx's default proxy read timeout is 60s. Every match would be cut off after a
minute of play and it would look like an application bug. This is the most
common way an Ingress breaks a real-time app.

**Path matching is longest-prefix-first**, not file order. `/` being last in the
YAML is not what makes it the fallback.

### Try it

```bash
kubectl get endpoints game-server           # the Pods behind the Service
kubectl run t --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  -s http://game-server:3000/whoami          # DNS from inside the cluster
curl -H "Host: pong.local" http://localhost/ready    # host-based routing
```

---

## 5. Kubernetes: configuration

### The problem

Hostnames, ports, log levels and passwords must not be baked into an image. The
same image should run in dev and prod with different settings.

### The mental model

**ConfigMap holds settings. Secret holds credentials.** The useful test is not
"is it a string?" but **"would I mind this appearing in a screenshot?"**

### How it is used here

[`k8s/00-config.yaml`](../k8s/00-config.yaml) holds `REDIS_HOST`, `LOG_LEVEL`,
`POSTGRES_USER`, and so on. The Secret is **not** in the repository - it is
generated by [`scripts/create-secrets.sh`](../scripts/create-secrets.sh) with
`openssl rand`, and [`k8s/secret.example.yaml`](../k8s/secret.example.yaml)
documents the required keys without the values.

Two ways to consume them:

```yaml
envFrom:                          # inject EVERY key
  - configMapRef: { name: pong-config }
  - secretRef:    { name: pong-secrets }

env:                              # inject ONE key
  - name: POSTGRES_PASSWORD
    valueFrom:
      secretKeyRef: { name: pong-secrets, key: POSTGRES_PASSWORD }
```

The game server uses `envFrom` (it wants everything). PostgreSQL takes individual
keys, because the shared ConfigMap also carries Redis settings that mean nothing
to a database.

### A Secret is base64, not encryption

This is worth being blunt about:

```bash
kubectl get secret pong-secrets -o jsonpath='{.data.JWT_SECRET}' | base64 -d
# af8a5bcc6a0895a1c35b4145…    <- the real signing key
```

What a Secret **does** give you:
- a separate object, so it can be excluded from git
- separate RBAC from ConfigMaps
- values not echoed in `kubectl describe pod`; mounted secrets live in tmpfs

What it does **not** give you:
- encryption at rest (etcd stores it base64 unless the cluster has an
  `EncryptionConfiguration`)
- any protection from someone who can read Secrets in the namespace

For real systems, the Secret object is a *delivery mechanism*, not storage:
External Secrets Operator, Sealed Secrets, SOPS, or cloud IAM.

### What bit us

**Changing a ConfigMap does not restart Pods.**

```
ConfigMap now says: debug
LOG_LEVEL in the pod: info        <- 8 seconds later, same Pod, 0 restarts
```

Environment variables are injected **once, at container start**. Your config
change appears to succeed and silently does nothing.

Two fixes. Manual: `kubectl rollout restart deployment/game-server`. Automatic:
stamp a hash of the config onto the Pod template, so a config change alters the
template and triggers an ordinary rolling update. That is what
[`scripts/apply.sh`](../scripts/apply.sh) does, and what Helm does natively.

(A ConfigMap mounted as a **volume** *does* update in place, after a delay. Env
vars never do.)

**You cannot un-commit a secret.** Early phases committed real values. Deleting
them from HEAD does nothing - `git log -S` still finds them. **Rotation is the
only fix.**

### Try it

```bash
kubectl get cm pong-config -o yaml
kubectl get secret pong-secrets -o go-template='{{range $k,$v := .data}}{{$k}}={{$v | base64decode}}{{"\n"}}{{end}}'
kubectl exec deploy/game-server -- printenv LOG_LEVEL
# now edit LOG_LEVEL in k8s/00-config.yaml and run ./scripts/apply.sh
```

---

## 6. Kubernetes: storage

### The problem

Containers are ephemeral. Their filesystem dies with them. Databases cannot work
that way.

### The mental model

```
StorageClass          "how to make storage"       (a provisioner)
      │ dynamically provisions
      ▼
PersistentVolume      "an actual piece of storage" (created for you)
      ▲ bound to
      │
PersistentVolumeClaim "I need 2Gi, read-write"     ← this is what you write
      ▲ mounted by
      │
     Pod
```

You write the **claim**. The StorageClass creates the **volume**. On any cluster
with dynamic provisioning you almost never hand-write a PersistentVolume.

### StatefulSet vs Deployment

| | Deployment | StatefulSet |
|---|---|---|
| Pod names | `postgres-546fff955f-dmvcb` | `postgres-0` |
| Identity across restarts | none | stable |
| Storage | shared or none | one PVC per replica, follows the Pod |
| Startup / shutdown | all at once | ordered: 0, 1, 2… and reverse |
| DNS | one Service IP | `postgres-0.postgres.default.svc…` |

The decision rule is one question: **are the replicas interchangeable?** Two
game-server Pods are. Two database Pods are not - one is primary, one is a
replica, they hold different data.

`volumeClaimTemplates` is the defining feature: each replica gets its own claim,
named `<template>-<statefulset>-<ordinal>` (`data-postgres-0`), and it follows
that Pod forever.

### How it is used here

[`k8s/05-postgres.yaml`](../k8s/05-postgres.yaml) - headless Service +
StatefulSet + 2Gi `volumeClaimTemplate`.

Redis deliberately stays a Deployment with `emptyDir`. **Persistence is not
about how important the data feels; it is about whether it can be rebuilt.** The
matchmaking queue can be. A user account cannot.

### What bit us

**`emptyDir` destroyed the database three times** before Phase 9 - once
deliberately, once on an image rollout, once when a Secret reference changed.
Not just the rows; `psql` reported *"Did not find any relations."*

**`reclaimPolicy: Delete` means deleting the CLAIM destroys the DATA.** For
anything you care about, use a StorageClass with `Retain`.

**`WaitForFirstConsumer` is not a failure.** A new PVC sits `Pending` with no
PersistentVolume until a Pod actually needs it, so the volume is created on the
right node.

**"Persistent" is narrower than it sounds.** On this cluster the provisioner is
`local-path`: the volume is a directory on the node, pinned there by
nodeAffinity. It survives the Pod. It would **not** survive the node.

### Try it

```bash
kubectl get pvc,pv
kubectl exec postgres-0 -- psql -U pong -d pong -c "SELECT count(*) FROM users;"
kubectl delete pod postgres-0            # then wait for it to come back
kubectl exec postgres-0 -- psql -U pong -d pong -c "SELECT count(*) FROM users;"
# stronger: delete the whole StatefulSet, re-apply it, and note the PVC survived
```

---

## 7. Kubernetes: health probes

### The problem

A container can be *running* but useless: deadlocked, or unable to reach its
database. Kubernetes needs to know the difference between "restart this" and
"stop sending it traffic".

### The mental model

**Three probes, three different questions.**

| Probe | Question | On failure | Checks dependencies? |
|---|---|---|---|
| `startupProbe` | has it finished booting? | restart, after a generous threshold | no |
| `livenessProbe` | is it alive? | **restart the container** | **no** |
| `readinessProbe` | can it serve traffic? | **remove from Service endpoints** | **yes** |

### The rule that matters most

**Liveness must not check your dependencies.**

`/health` in this project checks *nothing external*. If it checked PostgreSQL,
then a database blip would make Kubernetes restart **every** game server
simultaneously - dropping every in-progress match and restart-looping until the
database returned. A dependency outage would become a total outage.

`/ready` *does* check PostgreSQL and Redis, because the correct response to a
broken dependency is to stop taking traffic, not to die.

Measured, with PostgreSQL scaled to zero:

```
/ready   -> 503
/health  -> 200
restarts -> 0
```

**Zero restarts during a complete database outage.** That is the rule paying off.

### Why a startupProbe instead of a long initialDelaySeconds

`initialDelaySeconds` on the liveness probe is a fixed guess: too short and a
slow boot gets restart-looped, too long and a genuinely hung process is left
running. A startup probe suppresses liveness until boot completes, then liveness
runs at its normal fast cadence.

### What bit us

Nothing in the design - but a *test* of it was wrong. The first liveness demo
used the game-server image with no database configured. It did go to
`CrashLoopBackOff`, but because the process was exiting on a failed migration,
**not** because the probe failed. `kubectl describe` showed no
`Liveness probe failed` event, which gave it away. Redone with `nginx:alpine`,
which starts cleanly, the probe was unambiguously the cause.

### Try it

```bash
# readiness failure: pod stays up but leaves the load balancer
POD=$(kubectl get pods -l app=game-server -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POD -- node -e "fetch('http://localhost:3000/debug/unready',{method:'POST'}).then(r=>r.text()).then(console.log)"
sleep 15
kubectl get pod $POD          # READY 0/1, STATUS Running, RESTARTS 0
kubectl get endpointslice -l kubernetes.io/service-name=game-server -o yaml | grep -A2 conditions
```

(The `/debug/unready` hook only exists when `ALLOW_CHAOS=true`.)

---

## 8. Kubernetes: resources and QoS

### The problem

Without limits, one runaway container can starve everything else on the node.
Without requests, the scheduler has no idea what fits where.

### The mental model

- **Requests** are what the scheduler *reserves*. The sum of requests on a node
  cannot exceed capacity, so requests decide **whether a Pod fits**.
- **Limits** are a hard ceiling.

And the asymmetry that people forget:

| | At the limit | Measured here |
|---|---|---|
| **CPU** is compressible | **throttled** - you get less, container survives | `limit=100m` → 109M iterations; `limit=1000m` → 1149M. Both completed. |
| **Memory** is not | **OOMKilled** - SIGKILL, exit code 137 | 300MB against a 100Mi limit → `reason=OOMKilled exitCode=137` |

There is no such thing as throttling memory. A process asking for a page that
does not exist cannot be made to wait.

### QoS classes

Kubernetes derives a class from what you set, and it decides **eviction order**:

| Class | Condition | Evicted |
|---|---|---|
| `Guaranteed` | requests == limits, for every resource | last |
| `Burstable` | requests < limits | second |
| `BestEffort` | nothing set | **first** |

In this project PostgreSQL is `Guaranteed` (the one component that is expensive
to lose); everything else is `Burstable` so it can use spare capacity.

### What bit us

A memory-limit test **passed when it should have failed**. Allocating 200MB of
`Buffer.alloc` against a 100Mi limit completed successfully. The limit was
genuinely applied (`/sys/fs/cgroup/memory.max` read back exactly 104857600) and
swap was disabled - neither explained it.

The cause was the *data*: `Buffer.alloc` zero-fills, and 200 identical zero pages
are trivially deduplicated by the kernel. Refilling with
`crypto.randomFillSync` made the pages incompressible and the Pod was OOMKilled
immediately.

**Zeroed test data does not measure real memory pressure.**

### Try it

```bash
kubectl get pods -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass
kubectl describe node | grep -A6 "Allocated resources"
```

---

## 9. Kubernetes: autoscaling

### The problem

Two replicas is wrong at 3am and wrong at peak. You want the number to follow
demand.

### The mental model

**An HPA is a control loop over a metric.** It reads a number, compares it to a
target, and adjusts the replica count. It does not know anything about traffic -
only about the number you point it at.

And the thing most explanations skip:

```bash
$ kubectl top pods
error: Metrics API not available
```

**Kubernetes does not measure CPU by default.** Nothing provides the Metrics API
out of the box; `metrics-server` must be installed. "Kubernetes automatically
scales" is misleading - it scales on numbers *somebody supplies*.

### Utilization is a percentage of the REQUEST

```yaml
target:
  type: Utilization
  averageUtilization: 60      # 60% of the 100m CPU request ≈ 60m
```

Not of the limit, not of the node. **A Pod with no CPU request cannot be
autoscaled on CPU at all** - there is no denominator. This is why resource
requests have to come first.

### Scale up fast, scale down slowly

```yaml
scaleUp:   stabilizationWindowSeconds: 30     # react quickly
scaleDown: stabilizationWindowSeconds: 300    # 1 pod per minute
```

Scaling down is **not** the mirror image of scaling up. Removing a game-server
Pod drops every WebSocket connection it holds, so it is better to waste a little
capacity than to disconnect players during a lull.

### minReplicas: 1, not 0

Scale-to-zero sounds attractive, but for a WebSocket service there would be
nothing running to *receive* the connection that triggers the scale-up. Knative
and KEDA solve this with an activator that holds the request; a plain HPA cannot.

### Measured

```
t+28s  pods=5  players=20  games=10
t+56s  pods=6  players=29  games=15
t+84s  pods=8  players=41  games=19    ← maxReplicas reached
```

### Why CPU is the wrong metric here - and what replaced it

CPU correlates with load in this app because the 60Hz simulation loop is
CPU-bound. But a Pod holding 200 *idle* WebSocket connections uses almost no CPU
while being near its real capacity. The honest signal is `active_games`.

That is now implemented. `prometheus-adapter` serves `pong_active_games` through
the `custom.metrics.k8s.io` API, so the HPA asks Kubernetes for it exactly the
way it asks for CPU - **the HPA never learns that Prometheus exists.**

The HPA lists *both* metrics and takes whichever recommends more replicas, so
CPU still protects against a workload that is expensive but not match-shaped.

Measured with the CPU target deliberately raised to 300% so only games could
trigger scaling:

```
  t+48s    cpu 99%/300%    games/pod 11     pods 1
  t+96s    cpu 142%/300%   games/pod 4.75   pods 4
  t+120s   cpu 107%/300%   games/pod 3.5    pods 7    <- converged on target 3
```

CPU never reached its target, so its recommendation stayed at one Pod; the
1 → 2 → 4 → 7 scale-up was driven entirely by active games. Full write-up:
[docs/custom-metrics.md](custom-metrics.md).

### Try it

```bash
kubectl get hpa game-server -w
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD/loadtest:/scripts" grafana/k6:latest run /scripts/http-load.js
```

---

# Application

## 10. Node.js, TypeScript and Fastify

### The mental model

**Node is single-threaded and event-driven.** One thread runs your JavaScript;
I/O happens elsewhere and calls you back. This is excellent for many concurrent
connections doing little work each - exactly a WebSocket game server - and
terrible for CPU-heavy work, because a long synchronous function blocks
*everything*, including other players' games.

Our 60Hz loop is a `setInterval` that does a few hundred floating-point
operations. That is fine. If it did something heavy, every room on that Pod
would stutter.

**TypeScript is erased at build time.** It gives you compile-time checking and
produces plain JavaScript; there is no runtime type checking. Data arriving from
a WebSocket is `any` no matter what interface you declare, which is why
[`src/index.ts`](../services/game-server/src/index.ts) validates and clamps
every field rather than trusting the type.

**Fastify** is the HTTP framework: schema-friendly, fast, with a plugin model
(`@fastify/websocket` is how `/ws` is added).

### How it is used here

The layering is deliberate:

```
src/game/physics.ts    pure functions. No I/O. No networking. Fully testable.
src/game/room.ts       one match: owns the loop, broadcasts via a `send` callback
src/game/arena.ts      matchmaking and routing; knows about Redis
src/index.ts           HTTP + WebSocket transport
```

`physics.ts` does not know what a WebSocket is, which is why
`test/physics.test.mjs` can simulate 7,200 ticks in milliseconds with no server
running.

And the key abstraction: a player is `{ id, userId, name, side, send }`. For a
local player, `send` writes to a socket; for a player on another Pod, `send`
publishes to Redis. **One function pointer is the entire local/remote
distinction**, and `Room` never learns which it has.

### Try it

```bash
cd services/game-server
npm run build && node test/physics.test.mjs     # no server, no network
```

---

## 11. WebSockets

### The problem

HTTP is request/response: the server can only speak when spoken to. A game needs
the server to push 30 updates per second, unprompted.

### The mental model

**A WebSocket starts as an HTTP request and then stops being one.** The client
sends a normal GET with `Upgrade: websocket`; the server replies `101 Switching
Protocols`; the same TCP connection becomes a bidirectional message channel that
stays open.

Consequences worth internalising:
- The connection is **stateful and long-lived**, which is why load balancers,
  rolling deploys and autoscaling all become harder.
- It is **sticky to one process**. That single fact is why this project needs
  Redis at all.

### Server-authoritative design

The client may influence exactly one value: `dir`, the direction of its own
paddle (`-1`/`0`/`1`). Ball position, collisions and score exist **only** on the
server. Someone editing the JavaScript in devtools can move their paddle and
nothing else.

"Never trust the client" is three concrete lines here: paddle position is
clamped to the field, `dir` is coerced to one of three values, the display name
comes from a *verified token* rather than from what the client claims.

### Rate design

```
simulate at 60 Hz   →   broadcast at 30 Hz   →   render at 60 fps
```

Halving the send rate halves bandwidth; the client interpolates between the two
most recent snapshots to fill the gap. Input is sent **on change only** - holding
a key is one message, not sixty per second.

Wire format uses short keys (`b`, `p`, `s`) because state messages go out 30
times per second per player. Full protocol:
[`docs/websocket-protocol.md`](websocket-protocol.md).

### What bit us

**The winning point never arrived.** The match ends the instant someone reaches
5, so no further `state` message ever carried the final score - the board froze
at 4 while announcing a winner. Fixed by patching the last snapshot from the
authoritative `end` message.

**nginx cut every match at 60 seconds** until the Ingress timeouts were raised.

### Try it

```bash
cd services/game-server
node test/match.test.mjs        # two bot clients play a real match
```

---

## 12. React, Vite and Canvas

### The mental model

**React is for the UI around the game; Canvas is for the game.** Re-rendering a
React tree 60 times a second to move a ball would be absurd. The canvas is drawn
imperatively in a `requestAnimationFrame` loop, and React only manages the
things that change rarely: login state, score text, status messages.

This is why snapshots live in a **ref**, not state:

```ts
const snaps = useRef<{ prev, curr }>(...)   // 30 updates/sec, zero re-renders
```

Calling `setState` 30 times a second would re-render the whole component tree 30
times a second.

### Interpolation

Snapshots arrive at 30Hz; the browser paints at 60fps. Drawing the latest
snapshot directly looks choppy. So the renderer keeps the last two and
interpolates between them:

```ts
const t = Math.min(1, (performance.now() - curr.at) / SNAPSHOT_MS);
const bx = lerp(prev.ball[0], curr.ball[0], t);
```

That is the whole trick, and it is why the game looks smooth at half the network
rate. See [`services/web/src/Field.tsx`](../services/web/src/Field.tsx).

### Vite

A dev server with instant hot reload, and a bundler for production. Its proxy
config makes the API look same-origin during development so there is no CORS to
configure:

```ts
proxy: { "/ws": { target: "ws://localhost:3100", ws: true }, "/auth": "..." }
```

In production there is no Vite at all - the build produces static files served
by nginx. No Node.js runs in the web container.

### What bit us

**`localStorage` is shared across tabs.** Signing in as a second player in a
second tab silently replaced the first tab's identity, and a match rendered as
"grace vs grace". Switched to `sessionStorage`, which is per-tab - which is why
you can demo two players in one browser.

### Try it

```bash
cd services/web && npm run dev      # then open localhost:5173 in two tabs
```

---

# Data

## 13. Redis

### The problem

With two replicas, a matchmaking queue in process memory means two queues. Two
players who land on different Pods never meet. **Scaling out made the
application worse**, which is the single most instructive failure in this
project.

### The mental model

**Redis is a shared, single-threaded, in-memory data structure server.**
Single-threaded is a feature: commands are atomic with respect to each other
because there is no concurrency to worry about.

Three roles here, using three different capabilities:

| Role | Redis feature | Key |
|---|---|---|
| Matchmaking queue | list + **Lua** (atomicity) | `mm:queue` |
| Presence | hash + **TTL** (liveness) | `presence:<pod>` |
| Cross-Pod messaging | **pub/sub** | `pod:<id>:msg`, `pod:<id>:input` |
| Room ownership | string + **TTL** (leases) | `room:<id>:alive` |

### Atomicity: why the queue needs Lua

The obvious implementation has a race:

```
player A: RPOP → nothing        player B: RPOP → nothing
player A: LPUSH self            player B: LPUSH self
```

Both are now queued behind each other, having never matched. A Lua script runs
as a **single atomic unit** - nothing can interleave:

```lua
local opponent = redis.call('RPOP', KEYS[1])
if opponent then return opponent end
redis.call('LPUSH', KEYS[1], ARGV[1])
return false
```

### TTL as a liveness signal

Two places use the same trick, and it is worth understanding as a pattern:

**Presence.** Each Pod writes `presence:<pod>` every 2s with a 10s expiry.
Nothing has to clean up after a crashed Pod - it simply stops refreshing and
Redis deletes the key. Far simpler than detecting crashes.

**Room heartbeats.** The Pod simulating a match refreshes `room:<id>:alive`
every 2s with a 6s TTL. Other Pods sweep the rooms they are relaying for; an
expired key means the owner died, so they end the match locally with
`reason: "server_lost"`.

That inverts the problem neatly: **pub/sub is fire-and-forget, so a crashing Pod
cannot announce its own death - but absence of a heartbeat works no matter how
it died.**

### Pub/sub is fire-and-forget

If nobody is subscribed when a message is published, it is gone. That is
acceptable for paddle input and state snapshots (another arrives in 33ms) and
would **not** be acceptable for "save this match result".

We subscribe to two channels *per Pod*, not per room, because rooms are created
and destroyed constantly and SUBSCRIBE/UNSUBSCRIBE churn would cost more than
filtering in application code.

### Three connections, not one

A Redis connection that has run `SUBSCRIBE` enters subscriber mode and may not
issue ordinary commands. So: one for commands, one for publishing, one for
subscribing. See [`src/redis/client.ts`](../services/game-server/src/redis/client.ts).

### Private matches: invites as a Redis key

Public matchmaking pairs strangers; an invite pairs two specific people. Both
end up calling the same `startRoom()`, so both get the heartbeat, the metrics
and the persistence hook identically.

The invite lives in Redis for the same reason the queue does - the host and the
friend will usually be on different Pods, and the host's Pod is not the one that
receives the join.

```
SET invite:<code> <host ticket> EX 900 NX      # NX: two creations cannot collide
GETDEL invite:<code>                            # atomic claim: exactly one winner
```

`GETDEL` is the whole concurrency story. Without it, two people pasting the same
code would both read it as valid and both try to start a match.

The code alphabet omits `0 O 1 I L` - codes get read aloud and typed from a
phone screen, and ambiguous glyphs cost more than the extra entropy is worth.

### What bit us

**Redis fixed pairing but not play.** After the shared queue landed, players on
different Pods matched — and one paddle was completely dead, because input still
had nowhere to go. Measured: `left: 0, right: -186`. Both players' clients agreed,
so it was genuinely server-side.

**A heartbeat startup race.** The interval fires every 2s, so a room created just
after a tick had no `alive` key for up to two seconds - and another Pod's sweep
could look during that window and declare a brand-new match orphaned. Fixed by
writing the first beat *before* anyone is told the room exists.

**A spurious death notice after every normal match.** When a match ended
properly the owner deleted its heartbeat key (correctly), but the relaying Pod
never cleared its room reference. Two seconds later its sweep found the missing
key and sent a *second* `end` with `reason: "server_lost"`, overwriting the real
result. Winners were reported as `null`. **Found by CI, not by the manual chaos
test** - because the manual test only exercised the failure path.

**A heartbeat startup race that shipped for three phases.** The `alive` key is
refreshed by a 2s interval, so a room created just after a tick had no key for
up to two seconds - and the relaying Pod's sweep, on its own 2s timer, could
look in that window and kill a brand new match with `server_lost`.

It survived because it is *phase-dependent*: when both processes start together
their timers align and the sweep lands just after the beat. A targeted
regression test that creates matches at varied offsets exposed it immediately -
**9 of 10 matches falsely killed.** The fix is one line: write the first beat
before anyone is told the room exists.

**`SCAN`, never `KEYS`.** `KEYS` walks the whole keyspace in one blocking
operation and stalls every other client.

### Try it

```bash
kubectl exec deploy/redis -- redis-cli --scan --pattern 'presence:*'
kubectl exec deploy/redis -- redis-cli TTL presence:$(kubectl get pods -l app=game-server -o jsonpath='{.items[0].metadata.name}')
kubectl exec deploy/redis -- redis-cli LLEN mm:queue
curl -s localhost/cluster | python3 -m json.tool     # presence, aggregated
```

---

## 14. PostgreSQL

### The problem

Match history and user accounts must survive everything. Redis explicitly cannot
promise that here.

### The mental model

**Use the database's guarantees instead of reimplementing them.** Uniqueness,
referential integrity, atomicity and locking are all things Postgres does
correctly and you probably will not.

### Schema

```
users                      matches                     match_players
id            UUID PK  ←┐  id             UUID PK  ←┐  match_id  UUID FK
username      TEXT      │  room_id        TEXT      └─ user_id   UUID FK
password_hash TEXT      │  started_at     TIMESTAMPTZ  side      TEXT
created_at    TIMESTAMPTZ  ended_at       TIMESTAMPTZ  score     INT
                        └─ winner_user_id UUID FK      won       BOOLEAN
                           end_reason     TEXT         PK (match_id, user_id)
```

Three design decisions worth copying:

**`UNIQUE INDEX ON users (lower(username))`** - nobody can register "Alice" when
"alice" exists, and login is case-insensitive, without needing the `citext`
extension.

**`match_players` as a separate table**, not `player1_id`/`player2_id` columns.
With two columns, "every match alice played" becomes
`WHERE player1_id = $1 OR player2_id = $1`, which indexes badly and breaks
entirely if a mode ever has three players.

**`PRIMARY KEY (match_id, user_id)`** - the same user cannot appear twice in one
match. This constraint caught a real bug before it shipped: two tabs on one
account could be matched together, and recording that match would have violated
the key.

### Techniques used here

**Transactions.** A `matches` row without its `match_players` rows is *worse*
than no row - it appears in history as a match with no participants. BEGIN/COMMIT
means all three land or none do.

**Advisory locks for migrations.** Every replica runs migrations on boot, so they
all try at once. `pg_advisory_lock(727001)` is a cluster-wide mutex: the first
Pod migrates, the rest block and then find nothing to do.

```
game-server-546dd7ff7-ctw6j: 1 migration(s) applied
game-server-546dd7ff7-m5sfs: 0 migration(s) applied
```

Without it, concurrent `CREATE TABLE` statements race and a Pod crashes on boot.

**`json_agg` to avoid N+1.** The obvious history query fetches N matches then
queries participants for each: 1 + N round trips. Instead Postgres aggregates
them into JSON in one query.

**`count(*) FILTER (WHERE ...)`** for the leaderboard - conditional aggregation
without subqueries.

**Let the database decide uniqueness.** Registration inserts and catches error
`23505` (unique_violation) rather than checking first - a check-then-insert has a
race where two simultaneous registrations both pass the check.

**A connection pool, not a connection.** Opening a TCP connection and
authenticating costs milliseconds, far too slow to do per request.

### Try it

```bash
kubectl exec -it postgres-0 -- psql -U pong -d pong
\dt
\d+ match_players
SELECT name FROM schema_migrations;
SELECT u.username, count(*) FILTER (WHERE mp.won) AS wins
FROM match_players mp JOIN users u ON u.id = mp.user_id
GROUP BY u.username ORDER BY wins DESC LIMIT 5;
```

---

## 15. Authentication

### Password hashing

**Three things matter, and all three are easy to get wrong.**

**1. Slow on purpose.** SHA-256 is designed to be *fast* - a GPU tries billions
of guesses per second. scrypt (like bcrypt and argon2) is deliberately slow
*and* memory-hard. We use scrypt specifically because it ships inside Node, so
there is no native module to compile and the Alpine image stays small. argon2 is
the modern first choice if you will accept the dependency.

**2. A random per-user salt.** Two people with the same password get different
hashes, so cracking one reveals nothing about the other. Verified directly in
Phase 6: two accounts with identical passwords have completely different stored
values.

**3. Constant-time comparison.** `===` returns the instant two bytes differ, and
that timing difference leaks the hash a byte at a time. `timingSafeEqual` always
takes the same time.

Stored format keeps the parameters, so they can be raised later without
invalidating existing passwords:

```
scrypt$32768$8$1$<base64 salt>$<base64 hash>
```

### Not leaking which usernames exist

A wrong password and a non-existent user return the **same** 401 with the
**same** message. Distinguishing them turns your login form into a tool for
discovering who has an account. There is a test asserting the two responses are
byte-identical.

### JWT

A JSON Web Token is three base64 parts: header, payload, signature. The server
can verify it without a database lookup - which is exactly what you want on a
WebSocket handshake.

Two details that are genuinely security-critical:

**Pin the algorithm.**

```ts
jwtVerify(token, SECRET, { algorithms: ["HS256"] })
```

Accepting the token's own `alg` header is a classic vulnerability: an attacker
sends `alg: none` and the signature stops being checked.

**A JWT is signed, not encrypted.** Anyone can base64-decode and read it. Never
put a secret inside one.

The trade-off: a JWT cannot be revoked before it expires (TTL here is 24h). If
you need revocation, the fix is a deny-list in Redis - exactly the kind of small,
fast, ephemeral state Redis is already there for.

### Try it

```bash
TOKEN=$(curl -s -X POST localhost/auth/login -H 'content-type: application/json' \
  -d '{"username":"ada","password":"lovelace-1815"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null; echo   # readable!
curl -s localhost/auth/me -H "authorization: Bearer $TOKEN"
cd services/game-server && node test/auth.test.mjs http://localhost
```

---

# Operations

## 16. Prometheus

### The mental model

**Prometheus pulls; your app never pushes.** It scrapes an HTTP endpoint on a
schedule. A crashed Pod simply stops appearing - there is no half-written push to
reason about.

Targets are discovered by asking the Kubernetes API what exists, then filtered
to Pods that opt in:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "3000"
  prometheus.io/path: "/metrics"
```

### The four metric types

| Type | Meaning | Ours |
|---|---|---|
| **Counter** | only goes up | `pong_http_requests_total` |
| **Gauge** | goes up and down | `pong_active_games`, `pong_connected_players` |
| **Histogram** | bucketed distribution | `pong_http_request_duration_seconds` |
| Summary | client-side quantiles | not used - histograms aggregate across Pods, summaries do not |

**Never average a counter in the application.** Export the raw total and compute
`rate(...[1m])` at query time. That keeps the app dumb and lets the dashboard
choose the window.

### Cardinality is what kills Prometheus

Every unique combination of label values is a separate time series. Label
requests with the **route pattern** (`/matches`), never the concrete URL:

```ts
const route = req.routeOptions?.url ?? "unmatched";   // /matches
// NOT req.url, which would be /matches?limit=20&username=ada
```

One series per distinct query string is unbounded growth, and it is the classic
way to destroy a Prometheus instance.

### Histogram buckets

```js
buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
```

`histogram_quantile` interpolates *within* a bucket, so a quantile is only as
precise as the bucket it lands in. Choose buckets around latencies you have
actually measured.

### PromQL you will use constantly

```promql
sum(rate(pong_http_requests_total[1m]))                        # requests/sec
sum by (route) (rate(pong_http_requests_total[1m]))            # broken down
histogram_quantile(0.95, sum by (le) (rate(..._bucket[1m])))   # p95 latency
sum(pong_active_games)                                         # across all pods
count(count by (pod) (pong_connected_players))                 # how many pods
```

### What bit us

**The cAdvisor scrape returned 403 Forbidden.** The ClusterRole needs
`nodes/proxy`, not just `nodes`. The symptom is a target permanently `down`.

### Try it

```bash
kubectl -n monitoring port-forward deploy/prometheus 9090:9090
# then http://localhost:9090 → Status → Targets, and try the queries above
```

---

## 17. Grafana

### The mental model

**Grafana is a query-and-draw layer.** It stores no metrics; it asks Prometheus.

The one idea worth taking seriously: **dashboards belong in git**. A dashboard
clicked together in the UI lives only in Grafana's database and disappears when
the Pod is replaced. Ours is a JSON file, mounted as a ConfigMap and provisioned
at start, along with the datasource:
[`k8s/monitoring/dashboards/pong-arena.json`](../k8s/monitoring/dashboards/pong-arena.json).

### What bit us

Every stat panel worked and **every time series panel was blank.** Grafana's
Prometheus targets need `"range": true`; without it the query runs as an
*instant* query, the panel receives a single data point, and a line chart of one
point draws nothing. Stat panels want the opposite (`"instant": true`).

Hand-writing panel JSON is genuinely error-prone. A reasonable workflow is to
build a panel in the UI, then export its JSON and commit that.

### Try it

Open <http://localhost/grafana>, then generate load and watch it move:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD/loadtest:/scripts" grafana/k6:latest run /scripts/ws-load.js
```

---

## 18. k6

### The mental model

**Load tests are code, and thresholds make them pass/fail.** k6 scripts are
JavaScript; a scenario describes virtual users over time, and thresholds turn
the run into a test rather than a report you have to interpret.

```js
export const options = {
  scenarios: { ramp: { executor: "ramping-vus", stages: [
    { duration: "30s", target: 40 }, { duration: "90s", target: 120 },
  ]}},
  thresholds: { http_req_duration: ["p(95)<1500"], errors: ["rate<0.05"] },
};
```

### Two scenarios here

[`loadtest/http-load.js`](../loadtest/http-load.js) hammers the two most
database-expensive endpoints. [`loadtest/ws-load.js`](../loadtest/ws-load.js)
simulates real players: sign in, enter matchmaking, play a match, with custom
metrics for `time_to_match_ms` and `matches_started`.

### Reading results honestly

```
31,254 requests · 260 req/s · 0 errors · p95 670ms
142 matches started · 68,298 state messages · 100% handshake success
median time to match: 77ms · p95: 2.32s
```

That p95 of 2.32s is **not latency** - it is a player waiting for an opponent to
*exist*. With an odd number of waiting players, somebody waits. Knowing what
your own numbers mean is most of the skill.

Equally: CPU hit 138% of target at peak. That is not an HPA failure - it was
already at `maxReplicas: 8`.

### Try it

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD/loadtest:/scripts" grafana/k6:latest run /scripts/http-load.js
```

No k6 installation needed - it runs in a container and reaches the Ingress via
`host.docker.internal`.

---

## 19. Helm

### The problem

You have manifests for dev. Now you need them for staging with different
replicas, images and resources. Copy-paste-and-edit does not scale.

### The mental model

```
Chart      a package: templates + default values
Values     the knobs (values.yaml, --set, -f prod.yaml)
Release    an installed instance of a chart, with a name and a history
```

Because every object is named `{{ .Release.Name }}-...`, the same chart installs
twice into one namespace without colliding.

**Chart version and appVersion move independently.** Editing a template bumps
`version`; shipping new application code bumps `appVersion`.

### The payoff

Phase 8 needed a hand-written script to hash the ConfigMap so config changes
would actually roll the Pods. Helm does it in one line:

```yaml
checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

### Two details worth copying

**Omit `replicas` when an HPA is enabled**, or every `helm upgrade` resets the
replica count and fights the autoscaler.

**Do not template Secrets.** This chart references an existing Secret by name,
so a credential can never end up in a values file that gets committed.

### What bit us

Installing the chart crash-looped the web Pod:

```
[emerg] host not found in upstream "game-server"
```

The nginx config hardcoded the Service name; Helm prefixes Services with the
release name, so it was looking for `game-server` while the Service was
`pong-game-server`. That was a latent flaw in the *image*, not a Helm problem -
it only surfaced when something tried to run two copies.

**Making something reusable is how you discover it was never reusable.**

### Try it

```bash
helm lint charts/pong-arena
helm template pong charts/pong-arena | less             # see the rendered YAML
helm template pong charts/pong-arena --set gameServer.replicas=6 | grep replicas
```

---

## 20. GitHub Actions

### The mental model

**A workflow is jobs; jobs are steps; jobs can depend on other jobs.** Each job
gets a fresh VM.

```
push / PR
   ↓
 test job        real Redis + PostgreSQL as `services:` containers
   ↓ (needs: test, and only on main)
 images job      build and push to ghcr.io, tagged with the commit SHA
```

### Real dependencies, not mocks

```yaml
services:
  redis:    { image: redis:7.4-alpine,   ports: ["6380:6379"] }
  postgres: { image: postgres:16-alpine, ports: ["5433:5432"] }
```

The properties under test are **cross-process** - two server instances
coordinating through one real Redis. A mock would assert that the mock behaves
as written, which is exactly the thing that cannot fail.

### Tag with the commit SHA, never only `:latest`

A mutable tag makes "what is actually running?" unanswerable and rollback
meaningless - "roll back to `:latest`" means nothing if `:latest` just moved.

`secrets.GITHUB_TOKEN` is injected automatically and scoped to the repository,
so no long-lived registry credential is stored anywhere.

### Why this earned its keep immediately

Validating this pipeline locally, before committing it, found **five real bugs** -
two of them in heartbeat code that had *already passed a manual chaos test*. The
manual test exercised only the failure path; the bugs were in the normal path.

**That is the argument for CI in one sentence.**

### Try it

Run CI's exact sequence locally — see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 21. NGINX

Two completely different jobs in this project, worth separating:

**1. Serving the frontend** ([`services/web/`](../services/web/)). The React
build is just static files. No Node.js runs in the web container at all - a
static server is smaller and faster. `try_files $uri $uri/ /index.html` makes an
unknown path return the SPA so client-side routing works.

**2. The ingress controller.** A cluster-wide reverse proxy that watches the
Kubernetes API for Ingress objects and rewrites its own config accordingly.

### WebSocket proxying

Three headers, all required:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;     # or matches die at 60s
```

Without the first three, nginx treats `/ws` as an ordinary HTTP request and the
upgrade fails. Without the fourth it works perfectly for 60 seconds.

### What bit us

The upstream host was hardcoded, which broke under Helm. It now comes from
`GAME_SERVER_HOST`, rendered at container start by the nginx image's envsubst
templating, with `NGINX_ENVSUBST_FILTER` limiting substitution so nginx's own
`$uri` and `$host` survive.

---

# Glossary

| Term | Meaning |
|---|---|
| **Image** | read-only filesystem snapshot + metadata |
| **Container** | a running process using an image |
| **Pod** | smallest Kubernetes unit; 1+ containers sharing an IP |
| **ReplicaSet** | keeps N Pods alive |
| **Deployment** | manages ReplicaSets; owns update strategy |
| **StatefulSet** | like a Deployment, but stable names and per-replica storage |
| **Service** | stable name/IP for Pods matching a label selector |
| **Endpoints** | the Pod IPs a Service currently points at |
| **Ingress** | HTTP routing rules in front of Services |
| **ConfigMap / Secret** | non-sensitive / sensitive key-value config |
| **PV / PVC** | a piece of storage / a request for storage |
| **StorageClass** | how to provision a PV |
| **HPA** | scales replicas based on a metric |
| **QoS class** | eviction priority derived from requests/limits |
| **Liveness / Readiness** | restart me / stop sending me traffic |
| **Namespace** | a scope for names within a cluster |
| **RBAC** | who may do what to which API objects |
| **kubelet** | the agent on each node that runs containers |
| **CoreDNS** | in-cluster DNS; resolves Service names |
| **cAdvisor** | per-container resource metrics, exposed by the kubelet |

---

# Ten ideas worth keeping

Everything above compresses to roughly these.

1. **Declare desired state; let controllers converge.** You never tell
   Kubernetes to do something, only what should be true.

2. **Scaling out breaks things that worked at one replica.** In-memory state is
   the usual culprit, and the failure looks like an application bug.

3. **Ask "can this data be rebuilt?"** That single question decides Redis vs
   PostgreSQL, `emptyDir` vs PVC, Deployment vs StatefulSet.

4. **Liveness must not check dependencies.** Otherwise a dependency outage
   becomes a total outage. Measured here: zero restarts during a full database
   outage.

5. **CPU is compressible; memory is not.** Over the CPU limit you get throttled.
   Over the memory limit you get SIGKILL.

6. **Config changes do not restart Pods.** Environment variables are injected
   once, at container start. Hash the config into the Pod template.

7. **A Kubernetes Secret is base64, not encryption.** It is a delivery
   mechanism. And you cannot un-commit a secret - rotate it.

8. **A test that passes for the wrong reason is worse than no test.** This
   project hit it three times: a port-forward that pinned both clients to one
   Pod, a CrashLoopBackOff caused by a missing database rather than the probe
   under test, and an OOM test defeated by page-deduplicated zero-filled buffers.

9. **Automated tests exercise the path humans skip.** The manual chaos test
   covered the failure path; two real bugs were sitting in the normal path.

10. **Measure, do not assert.** Every claim in this repository has a number
    behind it. "Zero downtime" means 300 requests with 0 failures, not a feeling.
