# Pong Arena

Scalable real-time multiplayer Pong platform built with Docker, Kubernetes,
WebSockets, Redis and PostgreSQL.

**This is a learning project you can run.** It was built infrastructure-first,
in 20 phases, where every piece of infrastructure exists to solve a problem that
was first observed breaking. The commit history and
[learning log](docs/learning-log.md) follow that order, so you can read it as a
course rather than a finished codebase.

![MIT licensed](https://img.shields.io/badge/license-MIT-blue) ![Kubernetes](https://img.shields.io/badge/kubernetes-1.34-blue) ![Node](https://img.shields.io/badge/node-20-green)

## Quick start

You need **Docker Desktop with Kubernetes enabled** (Settings -> Kubernetes ->
Enable Kubernetes) and `kubectl`. Nothing else - the script installs the
in-cluster pieces itself.

```bash
git clone https://github.com/pri-3x/pong-arena.git
cd pong-arena
./scripts/bootstrap.sh
```

That builds both images, installs ingress-nginx and metrics-server, generates
secrets, deploys everything including Prometheus and Grafana, and waits until
the app answers. It takes a few minutes the first time and is safe to re-run.

Then open **<http://localhost>** in **two** browser tabs, create an account in
each, and click "Find a match" in both. (Two tabs work because the token is kept
in `sessionStorage`, which is per-tab.)

| | |
|---|---|
| Play | <http://localhost> |
| Grafana dashboard | <http://localhost/grafana> |
| Failure tests | `./scripts/chaos.sh` |
| Remove everything | `./scripts/teardown.sh` |

## Learning path

Each phase solved a problem the previous phase created. Read in this order:

| Phase | Concept | Where to look |
|---|---|---|
| 1 | Images vs containers, multi-stage builds | [learning log](docs/learning-log.md#phase-1---service-image-container) |
| 2-3 | Pods, Services, labels, Deployments, self-healing | [learning log](docs/learning-log.md) |
| 4 | Server-authoritative real-time simulation | [WebSocket protocol](docs/websocket-protocol.md) |
| 5 | Why in-memory state breaks at 2 replicas | [Redis keys](docs/redis-keys.md) |
| 6-7 | Auth, password hashing, match history | [Database schema](docs/database-schema.md) |
| 8 | ConfigMaps, Secrets, and what a Secret is not | [Configuration](docs/configuration.md) |
| 9 | PersistentVolumes and StatefulSets | [Storage](docs/storage.md) |
| 10-12 | Ingress, probes, resource limits and QoS | [learning log](docs/learning-log.md) |
| 13-14 | Autoscaling and load testing | [Load testing results](docs/load-testing.md) |
| 15 | Prometheus and Grafana | [Observability](docs/observability.md) |
| 16-17 | Chaos testing and safe rollouts | [Failure testing](docs/failure-testing.md) |
| 18-19 | CI/CD and Helm | [CI workflow](.github/workflows/ci.yml) |
| 20 | The whole system | [Architecture](docs/architecture.md) |

Every non-obvious choice is recorded in
[docs/decisions.md](docs/decisions.md) - 35 short architecture decision records,
including the ones that document mistakes.

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
docker build -t pong-game-server:v18 .
docker run -d --name pong-game -p 3100:3000 pong-game-server:v18
curl localhost:3100/health
docker rm -f pong-game
```

The image is a two-stage build: TypeScript is compiled in a `builder` stage and
only the compiled `dist/` plus production dependencies ship in the runtime
image. That takes it from **1.66 GB to 210 MB**.

`scripts/bootstrap.sh` reads the required tags straight out of the manifests, so
the built images can never drift from what the Deployments reference.

## Kubernetes

`./scripts/bootstrap.sh` does all of this. To do it by hand:

```bash
# cluster add-ons
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
kubectl patch deployment metrics-server -n kube-system --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

./scripts/create-secrets.sh   # generates POSTGRES_PASSWORD and JWT_SECRET
./scripts/apply.sh            # applies manifests, rolls pods if config changed
kubectl get deploy,sts,pods,svc,ingress
```

Use `scripts/apply.sh` rather than a plain `kubectl apply`: it stamps a checksum
of the ConfigMap and Secret onto the pod template, so a config change actually
triggers a rolling update. (Kubernetes does not restart pods when a ConfigMap
changes - environment variables are injected once, at container start.)

`http://pong.local` also works if you add a hosts entry:

```bash
echo "127.0.0.1 pong.local" | sudo tee -a /etc/hosts
```

### Cluster notes

Developed against Docker Desktop Kubernetes (kind-based provisioner, single node).

- `imagePullPolicy: Never` **does not work** here. The node's containerd store is
  separate from the host Docker image store. Use `IfNotPresent`, which Docker
  Desktop resolves from the host store at pull time without a registry.
- NodePort services are reachable inside the cluster but are **not** published to
  macOS. Docker Desktop *does* map `LoadBalancer` Services to localhost, which is
  how the ingress controller is reachable on port 80.

### Helm

An equivalent parameterised chart lives in `charts/pong-arena`:

```bash
kubectl create namespace pong
kubectl create secret generic pong-secrets -n pong \
  --from-literal=POSTGRES_PASSWORD=$(openssl rand -hex 24) \
  --from-literal=JWT_SECRET=$(openssl rand -hex 32)
helm install pong charts/pong-arena -n pong --set ingress.enabled=false
```

The raw manifests in `k8s/` are kept deliberately - they are the readable
version, and they are what the earlier phases teach against.

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

## Contributing

Issues and pull requests are welcome, especially corrections - if something in
the learning log is wrong or unclear, that is a bug. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT - see [LICENSE](LICENSE).

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
