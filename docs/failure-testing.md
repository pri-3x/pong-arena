# Chaos / failure testing

Run with:

```bash
./scripts/chaos.sh
```

Each scenario states what *should* happen, breaks something, and reports what
*did*. Results below are from real runs, including the ones that failed.

## The gap this phase closed

Since Phase 5 the project carried a measured, documented defect: if the Pod
simulating a match died abruptly, the player connected to the *other* Pod was
never told. Their socket stayed open and state updates simply stopped. The match
result was never written either.

**Phase 7 measurement (broken):**

```
p1 (surviving pod): msgs=[waiting,matched,start]   closed=false  msSinceState=8432
```

**After the heartbeat fix:**

```
p1 (surviving pod): msgs=[waiting,matched,start,end,score]
                    endReason="server_lost"        closed=false
```

### How it works

Pub/sub is fire-and-forget, so no message can announce a crash. Instead:

- the Pod that **owns** a room writes `room:<id>:alive` with a 6 second TTL and
  refreshes it every 2 seconds
- every Pod sweeps the rooms it is only *relaying* for; if the key has expired,
  the owner is gone
- the relaying Pod ends the match locally, sends `end` with
  `reason: "server_lost"`, and releases the player to queue again

If Redis itself is unreachable the sweep assumes rooms are **alive**. Declaring
every match dead because the coordination layer blinked would be far worse than
a few seconds of delay.

## Scenario results

### 1. Delete a game-server Pod

Expected: the ReplicaSet notices and recreates it.

```
PASS  replica count recovered (2 -> 2)
PASS  the deleted pod is gone and was replaced
```

### 2. Kill a Pod under live traffic

Expected: other Pods absorb the traffic with no failed requests.

```
requests: 60, 200s: 59
FAIL  1 request failed
```

**This failure is real and worth understanding.** When a Pod is deleted, two
things happen concurrently: the kubelet starts terminating the container, and
the endpoint controller removes it from the Service. Those are *not* ordered.
For a short window the Pod is still a Service endpoint but is already refusing
connections, and any request routed there fails.

The fix is a `preStop` hook that sleeps: the Pod stops being routed to *before*
it stops accepting connections.

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sleep", "8"]
```

**After the preStop fix**, same test with 80 requests:

```
requests: 80, 200s: 80
non-200: 0
```

### 3. Make PostgreSQL unreachable

Expected: readiness fails so Pods leave the load balancer; liveness stays green
so they are **not** restart-looped; recovery is automatic.

```
/ready -> 503   /health (in-pod) -> 200   total restarts: 0
PASS  readiness reports the dependency failure
PASS  liveness stays green, so pods are NOT restart-looped
PASS  recovered automatically once the database returned
```

**`total restarts: 0` is the whole point.** A complete database outage caused
zero container restarts. Had liveness checked PostgreSQL, every game-server Pod
would have been killed simultaneously, every in-progress match dropped, and the
Pods would have restart-looped until the database came back - turning a
dependency outage into a total outage. This is Phase 11's rule paying off.

### 4. Restart Redis

Expected: matchmaking state is lost, presence rebuilds itself from TTL
refreshes, and match history is untouched because it lives in PostgreSQL.

```
keys before: 2
keys after:  2
PASS  presence records rebuilt themselves (2 pods reporting)
PASS  match history is unaffected (it lives in PostgreSQL)
```

Nothing had to be repaired. Presence keys are rewritten every 2 seconds with a
TTL, so the state reconstructed itself. This is the Phase 9 rule in action:
Redis holds only data that can be rebuilt.

### 5. Deploy a broken version

Expected: `maxUnavailable: 0` means the broken Pods never become Ready, the old
Pods keep serving, and the rollout **stalls** rather than taking the site down.

An image whose process exits immediately on startup was deployed under live
traffic:

```
game-server-58bd956666-ltlvq  READY=0/1  CrashLoopBackOff  restarts=4
game-server-64c6458ff5-cb946  READY=1/1  Running           restarts=0
game-server-64c6458ff5-kvcxl  READY=1/1  Running           restarts=0

deployment:  READY=2/2   UP-TO-DATE=1   AVAILABLE=2
logs:        FATAL: simulated bad release

traffic during the broken deploy:  100 requests, 100 x 200
```

`UP-TO-DATE=1, AVAILABLE=2` is the signature of a stalled rollout: Kubernetes
created one new Pod, it never became Ready, so it refused to remove either old
Pod. **A completely broken release caused zero user-visible impact.**

Rollback:

```
kubectl rollout undo deployment/game-server
deployment "game-server" successfully rolled out
image now: pong-game-server:v16
/ready -> {"ok":true,"postgres":true,"redis":true}
```

The safety net is `maxUnavailable: 0` plus a readiness probe. Either alone is
not enough: without a readiness probe Kubernetes would consider a crashed
container "available" as soon as it started, and would happily remove the
healthy Pods.
