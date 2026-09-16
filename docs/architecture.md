# Architecture

```
                              Internet / localhost:80
                                        |
                                        v
                          +---------------------------+
                          |  NGINX Ingress Controller |
                          |  host + path routing      |
                          |  WebSocket upgrade, 3600s |
                          +------------+--------------+
                                       |
                 +---------------------+---------------------+
                 | /                                          | /ws /auth
                 |                                            | /matches
                 v                                            v /leaderboard
        +------------------+                    +-------------------------+
        |  web (nginx)     |                    |  game-server            |
        |  React SPA       |                    |  HPA 1..8 replicas      |
        |  1 replica       |                    |  Deployment, Burstable  |
        +------------------+                    +-----------+-------------+
                                                            |
                                    +-----------------------+------------------+
                                    |                                          |
                                    v                                          v
                        +-----------------------+                 +------------------------+
                        |  redis                |                 |  postgres              |
                        |  Deployment, emptyDir |                 |  StatefulSet + 2Gi PVC |
                        |  ephemeral by design  |                 |  QoS: Guaranteed       |
                        +-----------------------+                 +------------------------+
                        matchmaking queue (Lua)                   users
                        presence (TTL leases)                     matches
                        room heartbeats                           match_players
                        pod-to-pod pub/sub

        +---------------------------------------------------------------+
        |  monitoring namespace                                         |
        |  Prometheus  <-- scrapes annotated pods + cAdvisor            |
        |      |                                                        |
        |      v                                                        |
        |  Grafana  --> /grafana, 14-panel dashboard provisioned as code|
        +---------------------------------------------------------------+
```

## How a match works across replicas

```
 player A                                                   player B
    |  WebSocket                                     WebSocket  |
    v                                                           v
 game-server pod 1                                    game-server pod 2
    |                                                           |
    |  1. join -> Lua: RPOP an opponent, or LPUSH myself        |
    +-------------------> redis: mm:queue <---------------------+
                              |
    2. whichever pod completes the match OWNS the room and runs
       the 60Hz simulation. The other pod becomes a relay.
                              |
    pod 2 (owner)  <-- input  --  pod 1     via redis pub/sub: pod:<owner>:input
    pod 2 (owner)  --  state -->  pod 1     via redis pub/sub: pod:<pod1>:msg
                              |
    3. owner refreshes room:<id>:alive every 2s (TTL 6s).
       If it dies, pod 1's sweep sees the expired key and ends
       the match locally with reason="server_lost".
                              |
    4. on finish, the owner writes the result to PostgreSQL in a
       single transaction.
```

The key design property: **`Room` has no idea any of this exists.** A player is
`{ id, userId, name, side, send }`. For a local player `send` writes to a
socket; for a remote player `send` publishes to Redis. One function pointer is
the entire local/remote distinction.

## Component responsibilities

| Component | Stateless? | Scaling | Storage |
|---|---|---|---|
| `web` | yes | fixed 1 | none - static files |
| `game-server` | yes *(rooms are in memory but recoverable)* | HPA 1-8 on CPU | none |
| `redis` | no, but **recreatable** | exactly 1 | emptyDir, on purpose |
| `postgres` | no, **not** recreatable | exactly 1 | 2Gi PVC, Guaranteed QoS |

## Why this shape

**One Pod owns a match, rather than sticky sessions.** Sticky routing would
avoid relaying state through Redis, but needs individually addressable Pods and
a client reconnect. Ownership works with an ordinary ClusterIP Service. See
ADR-005.

**Rooms multiplex inside a Pod, not one Pod per game.** Pod startup is seconds;
a match is tens of seconds. One Pod runs many rooms.

**Redis and PostgreSQL are not interchangeable.** The rule used throughout is
*can this data be rebuilt?* The matchmaking queue can - losing it costs a
requeue. A user account cannot.

## Known limitations

- Single Redis replica: a single point of failure with no failover. Production
  would use Sentinel or a managed service.
- PostgreSQL StatefulSet has no backups, no replication, no point-in-time
  recovery. Production would use a managed database or an operator.
- `local-path` storage pins the volume to one node; it survives the Pod, not the
  node.
- Matches are **drained**, not migrated: a terminating Pod finishes its
  in-flight matches (measured: 25.6 s for three matches) and ends anything left
  at the deadline with `server_draining`. Moving live simulation state to
  another Pod is a much larger problem and is not attempted.
- A Pod that is SIGKILLed or whose node vanishes cannot drain. That case is
  covered by the room heartbeat, which tells the surviving player `server_lost`.
- CPU is a proxy metric for autoscaling. `active_games` would be the honest
  signal; see ADR-024.
