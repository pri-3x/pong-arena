import { randomUUID } from "node:crypto";
import { Room } from "./room.js";
import type { Side } from "./physics.js";
import { redis, type RedisWithMatch } from "../redis/client.js";
import { recordMatch } from "../db/matches.js";
import { matchesCompleted, matchDuration } from "../metrics.js";
import { startHeartbeat, clearBeat, beat } from "../redis/heartbeat.js";
import { createInvite, claimInvite, cancelInvite } from "../redis/invites.js";
import { POD_ID, sendToPlayer, sendInputToRoom, sendLeaveToRoom, type ToPlayer, type ToRoom } from "../redis/bus.js";

const QUEUE_KEY = "mm:queue";

/** A player waiting in the shared queue. Serialised into Redis as JSON. */
interface Ticket {
  playerId: string;
  /** Real database user id, or "" for a guest. Used only for persistence. */
  userId: string;
  /** Who this player IS, guest or not. Used to prevent self-matching. */
  identityId: string;
  name: string;
  pod: string;
}

/** Everything we track about one locally-connected client. */
export interface Conn {
  playerId: string;
  /** Real database user id, or null for a guest. Guest matches are not stored. */
  userId: string | null;
  /**
   * Stable identity for this socket, guest or not. A guest gets a random id
   * from their token, so two tabs of the SAME guest still cannot be paired -
   * while two DIFFERENT guests can.
   */
  identityId: string | null;
  isGuest: boolean;
  /** An invite code this connection created and is currently hosting. */
  inviteCode: string | null;
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
   * Match results still being written to PostgreSQL.
   *
   * recordMatch() is fire-and-forget during normal play, which is fine. During
   * SHUTDOWN it is not: the process would close the connection pool and exit
   * while the INSERT was still in flight, and a match that was genuinely played
   * would vanish. Found by the drain-deadline test, which saw the players
   * correctly told the match had ended and then found no row for it.
   */
  private pendingWrites = new Set<Promise<unknown>>();

  /** Wait for in-flight result writes before the pool is closed. */
  async flushPendingWrites(timeoutMs = 5000): Promise<number> {
    const n = this.pendingWrites.size;
    if (n === 0) return 0;
    await Promise.race([
      Promise.allSettled([...this.pendingWrites]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
    return n;
  }

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
      playerId: randomUUID(), userId: null, identityId: null, isGuest: false,
      inviteCode: null, name, send,
      room: null, remote: null, side: null, ticket: null,
    };
    this.local.set(conn.playerId, conn);
    return conn;
  }

  async queueLength() {
    return redis.llen(QUEUE_KEY);
  }

  /**
   * How many local players are currently mid-match - whether this Pod owns the
   * simulation or is only relaying for it. Both count: a relayed player whose
   * socket we close is just as disconnected as one of our own.
   */
  playersInMatches(): number {
    let n = 0;
    for (const c of this.local.values()) {
      if (c.room?.state.phase === "playing") n++;
      else if (c.remote) n++;
    }
    return n;
  }

  /** Matches this Pod is actually simulating. */
  matchesOwnedHere(): number {
    return [...this.rooms.values()].filter((r) => r.state.phase === "playing").length;
  }

  /**
   * Shutdown deadline reached with matches still running. End them honestly
   * rather than letting the sockets die silently: a player who is told can
   * requeue immediately, and the owner still writes the result.
   */
  endAllForShutdown(): number {
    let ended = 0;

    // Rooms we own: finish them properly so the result is still persisted.
    for (const room of this.rooms.values()) {
      if (room.state.phase !== "playing") continue;
      room.abandonForShutdown();
      ended++;
    }

    // Players we were only relaying for: their match lives on another Pod and
    // will carry on without them, so just tell them why they are leaving.
    for (const conn of this.local.values()) {
      if (!conn.remote) continue;
      conn.send({
        t: "end",
        winner: null,
        reason: "server_draining",
        message: "this server is shutting down - start a new match",
      });
    }

    return ended;
  }

  /** Remove every queued local player, so nobody is matched into a dying Pod. */
  async clearLocalQueueTickets(): Promise<void> {
    for (const conn of this.local.values()) {
      if (conn.ticket) {
        await redis.lrem(QUEUE_KEY, 1, conn.ticket).catch(() => {});
        conn.ticket = null;
        conn.send({ t: "requeue", reason: "this server is shutting down" });
      }
      if (conn.inviteCode) {
        await cancelInvite(conn.inviteCode).catch(() => {});
        conn.inviteCode = null;
      }
    }
  }

  async join(conn: Conn): Promise<void> {
    const ticket = this.ticketFor(conn);
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
    if (opponent.identityId && opponent.identityId === conn.identityId) {
      await redis.lpush(QUEUE_KEY, opponentRaw, raw);
      conn.ticket = raw;
      conn.send({ t: "waiting", playerId: conn.playerId, reason: "cannot play yourself" });
      return;
    }

    await this.startRoom(opponent, ticket);
  }

  /**
   * Create a room for two tickets and start the match. `host` takes the left
   * paddle. Whichever Pod runs this OWNS the room and runs the simulation; the
   * other becomes a relay.
   *
   * Shared by public matchmaking and by private invites, so both paths get the
   * heartbeat, the metrics and the persistence hook identically.
   */
  private async startRoom(host: Ticket, joiner: Ticket): Promise<void> {
    const room = new Room(
      randomUUID().slice(0, 8),
      (r) => this.rooms.delete(r.id),
      // Only the Pod that OWNS the room runs the loop, so only it fires this.
      // That is what keeps a match from being written twice.
      (result) => {
        void clearBeat(result.roomId);
        matchesCompleted.inc({ reason: result.endReason });
        matchDuration.observe((result.endedAt.getTime() - result.startedAt.getTime()) / 1000);
        const write = recordMatch(result).catch((e) => this.onPersistError(e, result.roomId));
        this.pendingWrites.add(write);
        void write.finally(() => this.pendingWrites.delete(write));
      }
    );
    this.rooms.set(room.id, room);

    // Write the first heartbeat BEFORE anyone is told this room exists.
    //
    // The heartbeat interval only fires every 2s, so a room created just after
    // a tick would have no `alive` key for up to two seconds - and another
    // Pod's orphan sweep, running on its own 2s timer, can look during that
    // window, find nothing, and end a brand new match with "server_lost".
    await beat(room.id, Date.now());

    // The player who waited (or who created the invite) gets the left paddle.
    const sides: Array<{ ticket: Ticket; side: Side }> = [
      { ticket: host, side: "left" },
      { ticket: joiner, side: "right" },
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

  private ticketFor(conn: Conn): Ticket {
    return {
      playerId: conn.playerId,
      userId: conn.userId ?? "",
      identityId: conn.identityId ?? conn.playerId,
      name: conn.name,
      pod: POD_ID,
    };
  }

  /**
   * Host a private match. Returns a short code to share; the friend who enters
   * it is paired directly with this player, skipping the public queue.
   */
  async host(conn: Conn): Promise<void> {
    if (conn.room || conn.remote) return conn.send({ t: "error", message: "already in a game" });
    if (conn.inviteCode) return conn.send({ t: "invite", code: conn.inviteCode });

    const code = await createInvite(this.ticketFor(conn));
    if (!code) return conn.send({ t: "error", message: "could not create an invite, try again" });

    conn.inviteCode = code;
    conn.send({ t: "invite", code });
  }

  /** Join a private match by code. */
  async joinByCode(conn: Conn, rawCode: unknown): Promise<void> {
    if (conn.room || conn.remote) return conn.send({ t: "error", message: "already in a game" });

    const code = String(rawCode ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) {
      return conn.send({ t: "invite_error", code, reason: "that does not look like a match code" });
    }

    // GETDEL: reading and deleting in one operation means two people pasting
    // the same code at the same moment cannot both be let in.
    const host = await claimInvite(code);
    if (!host) {
      return conn.send({ t: "invite_error", code, reason: "that match code is not valid any more" });
    }
    if (host.identityId && host.identityId === conn.identityId) {
      // Put it back - they pasted their own code.
      await createInvite(host).catch(() => {});
      return conn.send({ t: "invite_error", code, reason: "that is your own match code" });
    }

    // The host has been claimed out of Redis, so clear their local flag too if
    // they happen to be on this Pod.
    const hostConn = host.pod === POD_ID ? this.local.get(host.playerId) : undefined;
    if (hostConn) hostConn.inviteCode = null;

    await this.startRoom(host, this.ticketFor(conn));
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
    // Do not leave a dead invite code lying around for someone to join into.
    if (conn.inviteCode) { await cancelInvite(conn.inviteCode); conn.inviteCode = null; }
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
    } else if (p.t === "end") {
      // The match finished normally. Stop tracking it as a remote room.
      //
      // Without this the orphan sweep keeps watching a room whose owner has
      // (correctly) deleted its heartbeat key on finish, decides the owner
      // died, and delivers a SPURIOUS second `end` with reason "server_lost"
      // a couple of seconds after the real result. Found by the integration
      // tests: winners were being reported as null.
      conn.remote = null;
      conn.side = null;
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
