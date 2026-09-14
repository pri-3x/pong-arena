# Contributing

Thanks for looking. This is a **learning project**, so the most valuable
contributions are probably not new features.

New to the codebase? Start with [docs/tech-guide.md](docs/tech-guide.md), then
[docs/architecture.md](docs/architecture.md).

## What is most welcome

**Corrections.** If something in [docs/tech-guide.md](docs/tech-guide.md),
[docs/learning-log.md](docs/learning-log.md) or
[docs/decisions.md](docs/decisions.md) is wrong, misleading, or out of date,
that is a bug worth filing. An explanation that is confidently incorrect is
worse here than in most repositories, because people are reading it to learn.

**"This didn't work on my machine."** Development was done entirely against
**Docker Desktop Kubernetes on macOS (Apple Silicon)**. Reports from minikube,
kind, k3s, Rancher Desktop, Linux or Windows are genuinely useful — and so are
the fixes. Please include:

```bash
kubectl version --short
kubectl get nodes -o wide
docker version --format '{{.Server.Version}}'
uname -sm
```

**Better explanations.** If a phase took you a long time to follow, say where
you got stuck. That is data we cannot get any other way.

**More failure scenarios.** [`scripts/chaos.sh`](scripts/chaos.sh) covers four.
Obvious gaps: network partitions, disk pressure, a slow (rather than dead)
dependency, clock skew.

### Good first issues

- Run `./scripts/bootstrap.sh` on a non-Docker-Desktop cluster and report what
  breaks
- Add a `kind`-specific setup path (kind needs `kind load docker-image` and an
  ingress port mapping)
- Replace the CPU-based HPA with a custom-metric one via Prometheus Adapter or
  KEDA — the metrics are already exported (see ADR-024)
- Add graceful match draining on Pod shutdown (see the limitations in
  [docs/architecture.md](docs/architecture.md))

## Running it

```bash
./scripts/bootstrap.sh     # clone to running cluster, idempotent
./scripts/chaos.sh         # the failure tests
./scripts/teardown.sh      # remove it again
```

## Running the tests

CI runs exactly this, against **real** Redis and PostgreSQL service containers.
Nothing is mocked, on purpose: the properties under test are cross-process — two
server instances coordinating through one real Redis. A mock would assert that
the mock behaves as written, which is the one thing that cannot fail.

```bash
docker compose up -d                 # local Redis (6380) and PostgreSQL (5433)

cd services/game-server
npm ci && npm run build

REDIS_PORT=6380 POSTGRES_PORT=5433 POD_NAME=pod-A PORT=3101 node dist/index.js &
REDIS_PORT=6380 POSTGRES_PORT=5433 POD_NAME=pod-B PORT=3102 node dist/index.js &

node test/physics.test.mjs                                       # pure, no server
node test/auth.test.mjs     http://localhost:3101
node test/redis.test.mjs    http://localhost:3101 http://localhost:3102
node test/history.test.mjs  http://localhost:3101 http://localhost:3102
node test/abandon.test.mjs  http://localhost:3101 http://localhost:3102
node test/guest-invite.test.mjs   http://localhost:3101 http://localhost:3102
node test/heartbeat-race.test.mjs http://localhost:3101 http://localhost:3102
```

Two processes are not optional for `redis.test.mjs`, `history.test.mjs` or
`abandon.test.mjs` — they exist to prove that two *separate* instances
coordinate correctly.

## House rules for changes

**1. Measure, do not assert.** If a change fixes a failure, show the before and
after. Most of this repository's value is in its measurements, and
"it works now" is not one.

**2. A test that passes for the wrong reason is worse than no test.** This has
bitten the project three times, each written up in the learning log: a
port-forward that pinned both clients to one Pod, a `CrashLoopBackOff` caused by
a missing database rather than the probe under test, and an OOM test defeated by
page-deduplicated zero-filled buffers. Before trusting a green result, ask what
would make it red.

**3. Record non-obvious decisions** as a short ADR in
[docs/decisions.md](docs/decisions.md): the decision, why, the trade-off, and
what would make you revisit it. Include the ones that document mistakes — those
are the useful ones.

**4. Keep `k8s/` readable.** Those manifests are teaching material first and
deployment config second. The Helm chart in `charts/` is where clever belongs.

**5. Do not commit secrets.** `scripts/create-secrets.sh` generates them and
nothing is written to disk. If you ever do commit one, rotating it is the only
real fix — deleting it from HEAD does not remove it from history.

## Pull requests

- Branch from `main`, keep the change focused
- Make sure CI passes (it will run automatically)
- Update the relevant doc in the same PR — a behaviour change that leaves the
  tech guide stale is an incomplete change
- Explain *why* in the description, not just what

## Code of conduct

Be decent. Assume good faith, especially with people who are learning — that is
who this repository is for. Harassment or belittling of any kind is not welcome,
and maintainers will act on it.
