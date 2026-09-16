# Graceful shutdown

**The problem:** a Pod holds long-lived WebSocket connections and is simulating
matches. Kubernetes terminates it - a scale-down, a rolling update, a node drain
- and killing the process drops every match it was running.

The `preStop` hook added in Phase 16 fixed *HTTP request* loss during
termination. It did nothing for work already in flight.

## The sequence

```
SIGTERM
  │
  1. mark draining
  │    /ready -> 503  -> the Service removes this Pod from its endpoints
  │    new join / host / join_code are refused with {"t":"draining"}
  │
  2. pull our queued players out of the shared matchmaking queue,
  │    so nobody is matched INTO a Pod that is going away
  │
  3. wait for in-flight matches to finish on their own (DRAIN_TIMEOUT_MS)
  │
  4. deadline? end them properly: players are told, the result is still written
  │
  5. flush pending result writes, close everything, exit
```

## The time budget

Every step must fit inside `terminationGracePeriodSeconds`, because Kubernetes
SIGKILLs at that deadline regardless of what is happening:

```
preStop sleep          8s    endpoint removal propagates
drain timeout         60s    wait for matches to finish
flush result writes    5s
margin                27s
                     ----
                     100s    terminationGracePeriodSeconds
```

Getting this wrong is silent: too small a grace period and the Pod is killed
mid-drain, which is exactly the behaviour draining was meant to prevent.

## Measured, in the cluster

A Pod running three matches, deleted while people were playing:

```
before SIGTERM:  {"games":3,"playersInMatches":4,"draining":false}

draining: no longer accepting new matches  {playersInMatches: 3, matchesOwnedHere: 3}
draining: all matches finished             {waitedMs: 25574}
```

It stayed alive 25.6 seconds to finish its matches, then exited. Nothing was
dropped.

And a full rolling restart during live load:

```
  t+10s   running=2  terminating=3  games=14
  t+30s   running=2  terminating=1  games=17
  t+50s   running=2  terminating=1  games=19
  t+60s   running=2  terminating=0  games=21
```

The terminating Pods stayed up for ~50 seconds and the active-game count kept
*rising* throughout. Old Pods finished their matches while new ones took the new
traffic.

## When the deadline is reached

Matches still running are ended through the normal `finish()` path, so:

- both players get `end` with `reason: "server_draining"`
- whoever is ahead wins; a draw awards nobody
- **the result is still written to PostgreSQL**

That last point needed a fix. `recordMatch()` is fire-and-forget during normal
play, which is fine. During shutdown it is not: the process closed the
connection pool and exited while the INSERT was still in flight, and the match
vanished. The Arena now tracks pending writes and the drain awaits them.

Found by a test that saw the players correctly told the match had ended, then
found no row for it.

## Testing notes

Two suites, and one wrong turn worth recording.

`test/drain.test.mjs` - a match in flight, SIGTERM to its owner, assert the
match *finishes normally*:

```
PASS  the draining pod reports /ready 503
PASS  new joins are refused while draining
PASS  the match kept being simulated after SIGTERM (74 -> 200 states)
PASS  the match ENDED properly rather than being dropped (win)
```

`test/drain-timeout.test.mjs` - two perfect bots that rally forever, so the
match *cannot* finish inside a deliberately short 5 s drain window:

```
PASS  reason is server_draining
PASS  the interrupted match was still RECORDED
PASS  stored with end_reason=server_draining
```

**The wrong turn:** that second test originally used guests, and the
"still recorded" assertion failed. Guest matches are *deliberately* never
persisted, so a guest match could never have tested persistence at all. The
system was right and the test was wrong - rewritten to use real accounts.

## What this still does not solve

- **Match migration.** A match is not moved to another Pod; it is finished where
  it is, or ended honestly. Migrating live simulation state is a much larger
  problem.
- **Very long matches.** A match that outlives the grace period is still ended
  at the deadline. `DRAIN_TIMEOUT_MS` and `terminationGracePeriodSeconds` are
  both configurable, but a hard ceiling always exists.
- **Node loss.** A `SIGKILL`ed or vanished Pod cannot drain. That case is
  covered by the Phase 16 heartbeat instead, which tells the surviving player
  `server_lost`.
