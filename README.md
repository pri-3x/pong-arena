# Pong Arena

Scalable real-time multiplayer Pong platform built with Docker, Kubernetes,
WebSockets, Redis and PostgreSQL.

> **Status:** in progress. Phases 1-4 complete (service, containerization,
> Kubernetes Deployment, real-time server-authoritative Pong over WebSockets).

## Repository layout

```
services/game-server/    Node.js + TypeScript game service (HTTP + WebSocket)
services/web/            React + TypeScript + Vite client
k8s/                     Kubernetes manifests
docs/                    Architecture notes, runbooks, learning log
```

## Local development

Two processes. Vite proxies `/ws` and `/config` to the game server, so the
browser sees a single origin and there is no CORS to configure.

```bash
# terminal 1
cd services/game-server && npm install && PORT=3100 npm run dev

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
kubectl apply -f k8s/
kubectl get deploy,rs,pods,svc

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
  macOS. Use `kubectl port-forward` until Ingress lands (Phase 10).

## API

| Method | Path       | Response                                              |
|--------|------------|-------------------------------------------------------|
| GET    | `/health`  | `{"status":"ok"}`                                      |
| GET    | `/whoami`  | `{"instance","uptimeSeconds","version"}` - which replica answered |
| GET    | `/stats`   | `{"activeGames","rooms","waitingPlayers","connections"}` |
| GET    | `/config`  | field dimensions the client needs in order to draw |
| GET    | `/ws`      | WebSocket upgrade - see [protocol](docs/websocket-protocol.md) |

## Documentation

- [Learning log](docs/learning-log.md) - what was built in each phase and why
- [WebSocket protocol](docs/websocket-protocol.md)
- [Architecture decisions](docs/decisions.md)
