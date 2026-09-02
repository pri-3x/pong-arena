import { randomUUID } from "node:crypto";
import { Room } from "./room.js";
import type { Side } from "./physics.js";

/** Everything we track about one connected client. */
export interface Conn {
  playerId: string;
  name: string;
  send: (m: unknown) => void;
  room: Room | null;
  side: Side | null;
}

/**
 * Matchmaking + room registry, held in this process's memory.
 *
 * DELIBERATELY LOCAL. When we run 2 replicas, two players who land on
 * different Pods each sit in their own queue and never meet. We observe that
 * failure before fixing it with Redis in Phase 5.
 */
export class Arena {
  private rooms = new Map<string, Room>();
  private waiting: Conn | null = null;

  get stats() {
    const rooms = [...this.rooms.values()];
    return {
      activeGames: rooms.filter((r) => r.state.phase === "playing").length,
      rooms: rooms.length,
      waitingPlayers: this.waiting ? 1 : 0,
    };
  }

  newConn(name: string, send: (m: unknown) => void): Conn {
    return { playerId: randomUUID(), name, send, room: null, side: null };
  }

  join(conn: Conn): void {
    const opponent = this.waiting;

    if (!opponent) {
      this.waiting = conn;
      conn.send({ t: "waiting", playerId: conn.playerId });
      return;
    }
    this.waiting = null;

    const room = new Room(randomUUID().slice(0, 8), (r) => this.rooms.delete(r.id));
    this.rooms.set(room.id, room);

    // The player who waited gets the left paddle.
    opponent.room = room; opponent.side = "left";
    conn.room = room;     conn.side = "right";

    for (const c of [opponent, conn]) {
      c.send({ t: "matched", roomId: room.id, side: c.side, playerId: c.playerId });
    }

    room.add({ id: opponent.playerId, name: opponent.name, side: "left", send: opponent.send });
    room.add({ id: conn.playerId, name: conn.name, side: "right", send: conn.send }); // triggers start()
  }

  leave(conn: Conn): void {
    if (this.waiting?.playerId === conn.playerId) this.waiting = null;
    if (conn.room && conn.side) conn.room.remove(conn.side);
    conn.room = null;
  }
}
