import Fastify from "fastify";
import os from "node:os";

// Config comes from the environment, never hardcoded.
// In Phase 8 these same variables will come from a Kubernetes ConfigMap.
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({ logger: true });

/**
 * Liveness/readiness endpoint.
 * Kubernetes will call this on a schedule starting in Phase 11.
 * It must be cheap and must not depend on other services.
 */
app.get("/health", async () => {
  return { status: "ok" };
});

/**
 * Identity endpoint. Reports which instance answered.
 * This is what lets us SEE load balancing across replicas in Phase 3.
 */
app.get("/whoami", async () => {
  return {
    instance: os.hostname(),
    uptimeSeconds: Math.round(process.uptime()),
    version: process.env.APP_VERSION ?? "v1",
  };
});

/**
 * Added in v2 - used to demonstrate a rolling update.
 */
app.get("/version", async () => {
  return { version: process.env.APP_VERSION ?? "v1", service: "game-server" };
});

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Containers are stopped with SIGTERM. If we ignore it, Docker/Kubernetes
// waits 10-30s and then kills us hard, dropping in-flight requests.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  });
}
