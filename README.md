# Pong Arena

Scalable real-time multiplayer Pong platform built with Docker, Kubernetes,
WebSockets, Redis and PostgreSQL.

> **Status:** in progress. Phases 1-3 complete (service, containerization,
> Kubernetes Deployment with self-healing and rolling updates).

## Repository layout

```
services/game-server/    Node.js + TypeScript game service
k8s/                     Kubernetes manifests
docs/                    Architecture notes, runbooks, learning log
```

## Local development

```bash
cd services/game-server
npm install
PORT=3100 npm run dev
curl localhost:3100/health
```

Port 3100 is used instead of 3000 because port 3000 is occupied by another
project on this machine.

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

## Documentation

- [Learning log](docs/learning-log.md) - what was built in each phase and why
- [Architecture decisions](docs/decisions.md)
