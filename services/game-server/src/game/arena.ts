import { randomUUID } from "node:crypto";
import { Room } from "./room.js";
import type { Side } from "./physics.js";
import { redis, type RedisWithMatch } from "../redis/client.js";
import { recordMatch } from "../db/matches.js";
import { matchesCompleted, matchDuration } from "../metrics.js";
import { startHeartbeat, clearBeat } from "../redis/heartbeat.js";
import { POD_ID, sendToPlayer, sendInputToRoom, sendLeaveToRoom, type ToPlayer, type ToRoom } from "../redis/bus.js";

const QUEUE_KEY = "mm:queue";

/** A player waiting in the shared queue. Serialised into Redis as JSON. */
interface Ticket { playerId: string; userId: string; name: string; pod: string }

/** Everything we track about one locally-connected client. */
export interface Conn {
  playerId: string;
  /** The authenticated user this socket belongs to. Set on `join`. */
  userId: string | null;
  name: string;
  send: (m: unknown) => void;
  /** Set when the simulation for this player's match runs on THIS pod. */
  room: Room | null;
  /** Set when it runs on a DIFFERENT pod. */
  remote: { roomId: string; ownerPod: string } | null;
  side: Side | null;
  /** The exact JSON we pushed onto the queue, needed to remove it on disconnect. */
  ticket: string | null;
}

export class Arena {
  private rooms = new Map<string, Room>();
  /** Set by index.ts so failures to persist a result are logged, not swallowed. */
  onPersistError: (err: unknown, roomId: string) => void = () => {};
  /** Set by index.ts to log orphaned-match recoveries. */
  onOrphanRecovered: (roomId: string) => void = () => {};

  private stopHeartbeat: (() => void) | null = null;

  /**
   * Start the room heartbeat. Rooms we own get a refreshed TTL key; rooms we
   * merely relay for are checked, and if the owner has gone silent we end the
   * match locally rather than leaving our player staring at a frozen board.
   */
  startWatchdog() {
    this.stopHeartbeat = startHeartbeat({
      ownedRooms: () =>
        [...this.rooms.values()]
          .filter((r) => r.state.phase === "playing" && r.startedAt)
          .map((r) => ({ id: r.id, startedAt: r.startedAt! })),
      remoteRooms: () =>
        [...this.local.values()]
          .filter((c) => c.remote)
          .map((c) => ({ roomId: c.remote!.roomId })),
      onOrphaned: (roomId) => this.finaliseOrphan(roomId),
    });
  }

  stopWatchdog() { this.stopHeartbeat?.(); }

  /**
   * The Pod running this match has gone away. Tell our player, and release
   * them so they can queue again.
   */
  private finaliseOrphan(roomId: string) {
    for (const conn of this.local.values()) {
      if (conn.remote?.roomId !== roomId) continue;
      conn.send({
        t: "end",
        winner: null,
        reason: "server_lost",
        message: "the server running this match became unavailable",
      });
      conn.remote = null;
      conn.side = null;
      this.onOrphanRecovered(roomId);
    }
  }
  /** Locally connected players, so we can route messages arriving over Redis. */
  private local = new Map<string, Conn>();

  get stats() {
    const rooms = [...this.rooms.values()];
    return {
      pod: POD_ID,
      activeGames: rooms.filter((r) => r.state.phase === "playing").length,
      roomsOwnedHere: rooms.length,
      localConnections: this.local.size,
    };
  }

  newConn(name: string, send: (m: unknown) => void): Conn {
    const conn: Conn = {
      playerId: randomUUID(), userId: null, name, send,
      room: null, remote: null, side: null, ticket: null,
    };
    this.local.set(conn.playerId, conn);
    return conn;
  }

  async queueLength() {
    return redis.llen(QUEUE_KEY);
  }

  async join(conn: Conn): Promise<void> {
    const ticket: Ticket = {
      playerId: conn.playerId, userId: conn.userId ?? "", name: conn.name, pod: POD_ID,
    };
    const raw = JSON.stringify(ticket);

    // One atomic Redis call: either we get an opponent, or we are queued.
    const opponentRaw = await (redis as RedisWithMatch).matchOrQueue(QUEUE_KEY, raw);

    if (!opponentRaw) {
      conn.ticket = raw;
      conn.send({ t: "waiting", playerId: conn.playerId });
      return;
    }

    const opponent: Ticket = JSON.parse(opponentRaw);

    // Two tabs signed into the SAME account must not be matched together:
    // match_players is keyed on (match_id, user_id), so recording that match
    // in Phase 7 would violate the primary key. Put them both back and wait.
    if (opponent.userId && opponent.userId === conn.userId) {
      await redis.lpush(QUEUE_KEY, opponentRaw, raw);
      conn.ticket = raw;
      conn.send({ t: "waiting", playerId: conn.playerId, reason: "cannot play yourself" });
      return;
    }

    // Whoever completes the match OWNS the room and runs the simulation.
    const room = new Room(
      randomUUID().slice(0, 8),
      (r) => this.rooms.delete(r.id),
      // Only the Pod that OWNS the room runs the loop, so only it fires this.
      // That is what keeps a match from being written twice.
      (result) => {
        void clearBeat(result.roomId);
        matchesCompleted.inc({ reason: result.endReason });
        matchDuration.observe((result.endedAt.getTime() - result.startedAt.getTime()) / 1000);
        recordMatch(result).catch((e) => this.onPersistError(e, result.roomId));
      }
    );
    this.rooms.set(room.id, room);

    // The player who waited gets the left paddle.
    const sides: Array<{ ticket: Ticket; side: Side }> = [
      { ticket: opponent, side: "left" },
      { ticket, side: "right" },
    ];

    for (const { ticket: t, side } of sides) {
      const payload = { t: "matched", roomId: room.id, side, playerId: t.playerId, ownerPod: POD_ID };
      // `send` is the ONLY thing that differs between a local and a remote
      // player. Room itself never learns the difference.
      const send = t.pod === POD_ID
        ? (m: unknown) => this.local.get(t.playerId)?.send(m)
        : (m: unknown) => sendToPlayer(t.pod, t.playerId, m);

      send(payload);

      const localConn = t.pod === POD_ID ? this.local.get(t.playerId) : undefined;
      if (localConn) { localConn.room = room; localConn.side = side; localConn.ticket = null; }

      room.add({ id: t.playerId, userId: t.userId, name: t.name, side, send });
    }
  }

  /** A paddle input arrived from a local socket. */
  input(conn: Conn, dir: -1 | 0 | 1) {
    if (conn.room && conn.side) {
      conn.room.input(conn.side, dir);
      return;
    }
    // The simulation runs on another Pod. Forward the input to whoever owns
    // the room; they will apply it on the next tick.
    if (conn.remote && conn.side) {
      sendInputToRoom(conn.remote.ownerPod, conn.remote.roomId, conn.side, dir);
    }
  }

  async leave(conn: Conn) {
    this.local.delete(conn.playerId);
    if (conn.ticket) await redis.lrem(QUEUE_KEY, 1, conn.ticket);
    if (conn.room && conn.side) conn.room.remove(conn.side);
    else if (conn.remote && conn.side) sendLeaveToRoom(conn.remote.ownerPod, conn.remote.roomId, conn.side);
    conn.room = null;
    conn.remote = null;
  }

  /** A message for one of our local players arrived over Redis. */
  onPlayerMessage({ playerId, payload }: ToPlayer) {
    const conn = this.local.get(playerId);
    if (!conn) return;
    const p = payload as { t?: string; roomId?: string; side?: Side; ownerPod?: string };
    if (p.t === "matched" && p.roomId && p.side && p.ownerPod) {
      conn.remote = { roomId: p.roomId, ownerPod: p.ownerPod };
      conn.side = p.side;
      conn.ticket = null;
    }
    conn.send(payload);
  }

  /** An input for a room WE own arrived over Redis. */
  onRoomInput({ roomId, side, dir, leave }: ToRoom) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (leave) room.remove(side);
    else if (dir !== undefined) room.input(side, dir);
  }
}
