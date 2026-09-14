# Contributing

This is a learning project, so the most valuable contributions are probably not
new features.

## Especially welcome

- **Corrections.** If something in [docs/learning-log.md](docs/learning-log.md)
  or [docs/decisions.md](docs/decisions.md) is wrong, misleading, or unclear,
  that is a bug worth filing.
- **"This didn't work on my machine."** The project was developed against Docker
  Desktop Kubernetes on macOS. Reports from minikube, kind, k3s, Linux or Windows
  are useful, and so are the fixes.
- **Better explanations.** If a phase took you a long time to follow, say where
  you got stuck.

## Running the tests

```bash
docker compose up -d                 # local Redis and PostgreSQL

cd services/game-server && npm ci && npm run build
REDIS_PORT=6380 POSTGRES_PORT=5433 POD_NAME=pod-A PORT=3101 node dist/index.js &
REDIS_PORT=6380 POSTGRES_PORT=5433 POD_NAME=pod-B PORT=3102 node dist/index.js &

node test/physics.test.mjs
node test/auth.test.mjs     http://localhost:3101
node test/redis.test.mjs    http://localhost:3101 http://localhost:3102
node test/history.test.mjs  http://localhost:3101 http://localhost:3102
node test/abandon.test.mjs  http://localhost:3101 http://localhost:3102
```

CI runs exactly this against real Redis and PostgreSQL service containers. It is
not mocked, on purpose: the properties under test are cross-process.

## House rules for changes

1. **Measure, don't assert.** If a change fixes a failure, show the before and
   after. Most of this repository's value is in its measurements.
2. **A test that passes for the wrong reason is worse than no test.** This has
   bitten the project three times; each is documented in the learning log.
3. **Record non-obvious decisions** as a short ADR in `docs/decisions.md`,
   including the trade-off and what would make you revisit it.
4. Keep the raw manifests in `k8s/` readable. They are teaching material first.
