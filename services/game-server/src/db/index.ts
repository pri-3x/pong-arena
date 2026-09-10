import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 5433),
  user: process.env.POSTGRES_USER ?? "pong",
  password: process.env.POSTGRES_PASSWORD ?? "pong_dev_password",
  database: process.env.POSTGRES_DB ?? "pong",
  // A pool, not a single connection: opening a TCP connection + authenticating
  // costs milliseconds, which is far too slow to do per request.
  max: Number(process.env.POSTGRES_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (e) => console.error(JSON.stringify({ postgres: "pool", error: e.message })));

/** Migration files live next to the compiled output, not inside src/. */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/**
 * Apply any migrations that have not run yet.
 *
 * Every replica runs this on startup, so they would all try to migrate at the
 * same time. `pg_advisory_lock` is a cluster-wide mutex held on a connection:
 * the first Pod to grab it migrates, the others block until it finishes and
 * then find there is nothing left to do. Without it, concurrent CREATE TABLE
 * statements race and one Pod crashes on startup.
 */
export async function migrate(log: (m: string) => void = console.log) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [727_001]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name)
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, "utf8");
      // Each migration runs in its own transaction: if it fails halfway,
      // nothing from it is left behind and it will be retried next boot.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`migration applied: ${file}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    return files.length - applied.size;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [727_001]).catch(() => {});
    client.release();
  }
}

export async function dbHealthy() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
