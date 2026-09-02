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
