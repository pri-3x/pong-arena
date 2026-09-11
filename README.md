# Pong Arena

Scalable real-time multiplayer Pong platform built with Docker, Kubernetes,
WebSockets, Redis and PostgreSQL.

> **Status:** all 20 phases complete (service, containerization,
> Kubernetes Deployment, real-time server-authoritative Pong over WebSockets,
> Redis-backed matchmaking across replicas, accounts + JWT auth on PostgreSQL,
> (service, containerization, Kubernetes, real-time Pong, Redis matchmaking,
> auth, history, config, storage, Ingress, probes, limits, autoscaling, load
> testing, observability, chaos testing, rolling deploys, CI/CD, Helm).
>
> **Known limitations**, documented rather than hidden:
> - If the Pod owning a match is hard-killed, the players are not notified and
>   the result is not recorded (to be fixed in Phase 16).
> - The PostgreSQL StatefulSet has no backups, no replication and no failover.
>   Fine for learning; see [docs/storage.md](docs/storage.md).

## Repository layout

```
services/game-server/    Node.js + TypeScript game service (HTTP + WebSocket)
services/web/            React + TypeScript + Vite client
scripts/                 create-secrets.sh, apply.sh
docker-compose.yml       local backing services (Redis, PostgreSQL) for development
k8s/                     Kubernetes manifests
docs/                    Architecture notes, runbooks, learning log
```

## Local development

Two processes. Vite proxies `/ws` and `/config` to the game server, so the
browser sees a single origin and there is no CORS to configure.

```bash
# terminal 0 - backing services
docker compose up -d

# terminal 1
cd services/game-server && npm install && \
  PORT=3100 REDIS_PORT=6380 POSTGRES_PORT=5433 npm run dev

# terminal 2
cd services/web && npm install && npm run dev
```

Then open <http://localhost:5173> in **two** browser tabs and click
"Find a match" in each.

Port 3100 is used instead of 3000 because port 3000 is occupied by another
project on this machine.

## Tests

```bash
cd services/game-server && npm test
```

`test/physics.test.mjs` tests the simulation as pure functions (no networking).
`test/match.test.mjs` drives two bot clients through a real match over
WebSockets.

`test/redis.test.mjs` needs two server instances sharing one Redis, to prove
matchmaking works across replicas:

```bash
docker compose up -d
cd services/game-server && npm run build
POD_NAME=pod-A PORT=3101 REDIS_PORT=6380 node dist/index.js &
POD_NAME=pod-B PORT=3102 REDIS_PORT=6380 node dist/index.js &
node test/redis.test.mjs http://localhost:3101 http://localhost:3102
```

## Docker

```bash
cd services/game-server
docker build -t pong-game-server:v1 .
docker run -d --name pong-game -p 3100:3000 pong-game-server:v1
curl localhost:3100/health
docker logs pong-game
docker rm -f pong-game
```

The image is a two-stage build: TypeScript is compiled in a `builder` stage and
only the compiled `dist/` plus production dependencies ship in the runtime
image. This takes the image from **1.66 GB to 210 MB**.

## Kubernetes

```bash
# once: install the ingress controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml

./scripts/create-secrets.sh     # once: generates POSTGRES_PASSWORD and JWT_SECRET
./scripts/apply.sh              # applies manifests, rolls Pods if config changed
kubectl get deploy,sts,pods,svc,ingress

# external access (NodePort is not published to macOS on this cluster)
kubectl port-forward svc/game-server 3100:3000
curl localhost:3100/health
```

### Cluster notes

Docker Desktop Kubernetes (kind-based provisioner, node `desktop-control-plane`).

- `imagePullPolicy: Never` **does not work** here. The node's containerd store is
  separate from the host Docker image store. Use `IfNotPresent`, which Docker
  Desktop resolves from the host store at pull time without a registry.
- NodePort services are reachable inside the cluster but are **not** published to
  macOS. Docker Desktop *does* map `LoadBalancer` Services to localhost, which is
  how the ingress controller is reachable on port 80.

## API

| Method | Path       | Response                                              |
|--------|------------|-------------------------------------------------------|
| POST   | `/auth/register` | `{username, password}` -> `{token, user}`; 409 if taken |
| POST   | `/auth/login`    | `{username, password}` -> `{token, user}`; 401 otherwise |
| GET    | `/auth/me`       | requires `Authorization: Bearer <token>` |
| GET    | `/health`  | liveness - checks nothing external                     |
| GET    | `/ready`   | readiness - checks PostgreSQL and Redis                |
| GET    | `/matches` | recent matches; `?username=` filters, `?limit=` capped at 100 |
| GET    | `/leaderboard` | wins/losses/win rate, ranked; abandoned matches excluded |
| GET    | `/whoami`  | `{"instance","uptimeSeconds","version"}` - which replica answered |
| GET    | `/stats`   | this Pod's local view: rooms it owns, its connections, Redis status |
| GET    | `/cluster` | cluster-wide view aggregated from every live Pod's presence record |
| GET    | `/config`  | field dimensions the client needs in order to draw |
| GET    | `/ws`      | WebSocket upgrade - see [protocol](docs/websocket-protocol.md) |

## Documentation

- [Learning log](docs/learning-log.md) - what was built in each phase and why
- [WebSocket protocol](docs/websocket-protocol.md)
- [Redis keys and channels](docs/redis-keys.md)
- [Database schema](docs/database-schema.md)
- [Configuration and secrets](docs/configuration.md)
- [Persistent storage](docs/storage.md)
- [Architecture](docs/architecture.md)
- [Observability](docs/observability.md)
- [Load testing results](docs/load-testing.md)
- [Chaos / failure testing](docs/failure-testing.md)
- [Resume bullets](docs/resume.md)
- [Portfolio page](docs/portfolio.html)
- [Architecture decisions](docs/decisions.md)
