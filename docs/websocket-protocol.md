# WebSocket protocol

Endpoint: `GET /ws` (HTTP Upgrade). All frames are JSON text. Every message has
a `t` (type) field.

## Design rules

1. **The server is authoritative.** The client may influence exactly one thing:
   the direction of its own paddle. Ball position, collisions and score are
   computed only on the server. A modified client cannot cheat.
2. **Input is sent on change, not per frame.** Holding a key sends one message,
   not 60 per second. The server keeps applying the last direction.
3. **State is simulated at 60 Hz and broadcast at 30 Hz.** Halving the send rate
   halves bandwidth; the client interpolates between snapshots to stay smooth.
4. **Wire keys are short.** State messages go out 30x/second per player, so
   they use `b`/`p`/`s` rather than `ball`/`paddles`/`score`.

## Client → server

| Message | Meaning |
|---|---|
| `{"t":"join","name":"alice"}` | Enter matchmaking. Name is clamped to 20 chars server-side. |
| `{"t":"input","dir":-1\|0\|1}` | Paddle direction: -1 up, 0 stop, 1 down. Anything else is treated as 0. |
| `{"t":"ping","ts":123.4}` | Latency probe; `ts` is echoed back untouched. |
| `{"t":"host","token":"..."}` | Create a private match; replies with a shareable code. |
| `{"t":"join_code","token":"...","code":"9C3WSY"}` | Join a friend's private match. Case-insensitive. |

## Server → client

| Message | Meaning |
|---|---|
| `{"t":"hello","instance","playerId"}` | Sent on connect. `instance` is the hostname of the Pod that answered. |
| `{"t":"waiting","playerId"}` | You are queued; no opponent yet. |
| `{"t":"matched","roomId","side","playerId"}` | Paired. `side` is `left` or `right`. |
| `{"t":"start","players":{"left","right"}}` | Simulation has begun. |
| `{"t":"state","k","b":[x,y],"p":[leftY,rightY],"s":[l,r]}` | World snapshot, 30x/sec. `k` is the server tick. |
| `{"t":"score","score":{...},"scored":"left"}` | A point was scored. |
| `{"t":"end","winner","score","reason"}` | Match over. `reason` is `win` or `opponent_left`. |
| `{"t":"pong","ts"}` | Reply to `ping`. |
| `{"t":"invite","code":"9C3WSY"}` | Your private match code. Share it, or share `/?join=CODE`. |
| `{"t":"invite_error","code","reason"}` | The code was invalid, already used, or your own. |
| `{"t":"error","message"}` | Malformed or out-of-order request. |

## Sequence

```
client                                server
  |------------- WS upgrade ----------->|
  |<------------ hello -----------------|
  |------------- join ----------------->|
  |<------------ waiting ---------------|     (no opponent yet)
  |                                     |
  |            ... second player joins ...
  |                                     |
  |<------------ matched ---------------|
  |<------------ start -----------------|
  |------------- input (dir=-1) ------->|     only on key change
  |<------------ state -----------------|  \
  |<------------ state -----------------|   |  30 per second
  |<------------ state -----------------|  /
  |<------------ score -----------------|
  |<------------ end -------------------|
```

## Private matches

```
host                          redis                         friend
 |-- host ------------------->|                                |
 |<-- invite {code} ----------|  SET invite:<code> NX EX 900   |
 |                            |                                |
 |        ...the code is shared out of band (link or chat)...  |
 |                            |                                |
 |                            |<------------- join_code {code} |
 |                            |  GETDEL invite:<code>          |
 |<-- matched ----------------|--------------- matched ------->|
```

`GETDEL` reads and deletes atomically, so if two people paste the same code at
the same moment exactly one is let in. The invite is released if the host
disconnects, and expires on its own after 15 minutes.

The host always takes the left paddle.

## Guests

`POST /auth/guest` returns a normal signed token carrying `guest: true`, whose
subject is a random id that is **not** a row in `users`. The WebSocket handshake
needs no special case.

Guest matches are deliberately never persisted: `Room.finish()` only reports a
result when both players have a real `userId`, and `match_players` has a foreign
key to `users` that would reject them anyway.

## Known limitation (fixed in Phase 5)

Matchmaking and room state live in **one process's memory**. With more than one
replica, two players who connect to different Pods will each wait forever in
their own queue. This is demonstrated in
[docs/learning-log.md](learning-log.md#phase-4) before Redis fixes it.
