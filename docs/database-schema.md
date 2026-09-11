# Database schema

PostgreSQL. Migrations live in `services/game-server/migrations/` and are applied
on startup.

```
users                          matches                       match_players
-----                          -------                       -------------
id             UUID PK  <--+   id             UUID PK  <--+   match_id  UUID FK
username       TEXT        |   room_id        TEXT        +-- user_id   UUID FK
password_hash  TEXT        |   started_at     TIMESTAMPTZ     side      TEXT
created_at     TIMESTAMPTZ |   ended_at       TIMESTAMPTZ     score     INT
                           +-- winner_user_id UUID FK         won       BOOLEAN
                               end_reason     TEXT            PK (match_id, user_id)
```

## Design notes

**`users_username_lower_idx` is a unique index on `lower(username)`.** Nobody can
register "Alice" when "alice" exists, and login is case-insensitive, without
needing the `citext` extension.

**`match_players` is a separate table rather than `player1_id`/`player2_id`
columns on `matches`.** With two columns, "every match alice played" becomes
`WHERE player1_id = $1 OR player2_id = $1`, which cannot use a plain index well
and gets worse if a game mode ever has more than two players. One row per
participant keeps it a simple indexed lookup.

**`PRIMARY KEY (match_id, user_id)`** means the same user cannot appear twice in
one match. This is enforced in the application too: the matchmaker refuses to
pair a user with themselves, because two browser tabs signed into one account
would otherwise produce a match that cannot be recorded.

**Passwords** are stored as
`scrypt$N$r$p$<base64 salt>$<base64 hash>`. The parameters are stored alongside
the hash so they can be raised later without invalidating existing passwords.

## Migrations

`migrate()` runs on every replica at startup, guarded by
`pg_advisory_lock(727001)` - a cluster-wide mutex. The first Pod to acquire it
applies pending migrations; the others block, then find nothing to do:

```
game-server-546dd7ff7-ctw6j: 1 migration(s) applied
game-server-546dd7ff7-m5sfs: 0 migration(s) applied
```

Without the lock, concurrent `CREATE TABLE` statements race and a Pod crashes on
boot. Each migration runs in its own transaction, so a failure leaves nothing
half-applied.

## Inspecting it

```bash
kubectl exec -it deploy/postgres -- psql -U pong -d pong
\dt
SELECT username, created_at FROM users;
SELECT name FROM schema_migrations;
```

## Queries

**History** (`GET /matches`, optionally `?username=`) aggregates participants
with `json_agg` so one query returns matches *and* their players. Fetching
matches and then querying participants per match would be an N+1.

**Leaderboard** (`GET /leaderboard`) counts wins and losses per user with
`count(*) FILTER (WHERE mp.won)`, joined only to matches where
`end_reason = 'win'`. Abandoned matches are stored and shown in history but
excluded from ranking, so quitting cannot be farmed for wins.

Both endpoints clamp `limit` server-side (max 100) - a client must never be able
to ask for the whole table.
