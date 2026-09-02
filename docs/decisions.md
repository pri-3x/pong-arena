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
