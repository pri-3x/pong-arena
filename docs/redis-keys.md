# Redis keys and channels

| Key / channel | Type | Purpose | Lifetime |
|---|---|---|---|
| `mm:queue` | list | Matchmaking queue. Each element is a JSON ticket `{playerId,name,pod}`. | until popped, or LREM on disconnect |
| `presence:<pod>` | hash | `{players, games}` for one Pod. | 10 s TTL, refreshed every 2 s |
| `pod:<pod>:msg` | pub/sub | Game messages destined for a player connected to that Pod. | transient |
| `pod:<pod>:input` | pub/sub | Paddle input and leave events destined for a room owned by that Pod. | transient |

## Why a Lua script for matchmaking

"Pop an opponent, or queue myself" must be one atomic step:

```lua
local opponent = redis.call('RPOP', KEYS[1])
if opponent then return opponent end
redis.call('LPUSH', KEYS[1], ARGV[1])
return false
```

As two commands there is a race where both players RPOP nothing, both LPUSH, and
neither is matched.

## Why three Redis connections

A connection that has issued `SUBSCRIBE` enters subscriber mode and may not run
ordinary commands. So the process keeps one connection for commands, one for
publishing, and one for subscribing.

## Inspecting it

```bash
kubectl exec -it deploy/redis -- redis-cli
> LLEN mm:queue
> KEYS presence:*          # fine interactively; the app uses SCAN
> HGETALL presence/<pod>
> SUBSCRIBE pod:<pod>:msg  # watch live game traffic
```
