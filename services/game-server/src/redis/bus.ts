import os from "node:os";
import { publisher, subscriber } from "./client.js";
import type { Side } from "../game/physics.js";

/**
 * This process's identity, used to address it over Redis pub/sub.
 * In Kubernetes we inject the real Pod name via the downward API; locally we
 * fall back to the hostname (or POD_NAME, to run two processes on one machine).
 */
export const POD_ID = process.env.POD_NAME ?? os.hostname();

const MSG_CH = (pod: string) => `pod:${pod}:msg`;
const INPUT_CH = (pod: string) => `pod:${pod}:input`;

export interface ToPlayer { playerId: string; payload: unknown }
export interface ToRoom { roomId: string; side: Side; dir?: -1 | 0 | 1; leave?: boolean }

type Handlers = {
  onPlayerMessage: (m: ToPlayer) => void;
  onRoomInput: (m: ToRoom) => void;
};

/**
 * Pod-to-pod messaging over Redis pub/sub.
 *
 * We subscribe to exactly TWO channels named after this Pod, rather than one
 * channel per game room. Rooms are created and destroyed constantly; churning
 * SUBSCRIBE/UNSUBSCRIBE on every match would be far more work than filtering a
 * couple of channels in application code.
 *
 * Note pub/sub is fire-and-forget: if nobody is subscribed when a message is
 * published, it is simply lost. That is acceptable for paddle input and state
 * snapshots (another one arrives in 33 ms) and would NOT be acceptable for
 * something like "save this match result".
 */
export async function startBus(h: Handlers) {
  await subscriber.subscribe(MSG_CH(POD_ID), INPUT_CH(POD_ID));

  subscriber.on("message", (channel, raw) => {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { return; }
    if (channel === MSG_CH(POD_ID)) h.onPlayerMessage(msg as ToPlayer);
    else if (channel === INPUT_CH(POD_ID)) h.onRoomInput(msg as ToRoom);
  });
}

/** Send a game message to a player who is connected to a different Pod. */
export function sendToPlayer(pod: string, playerId: string, payload: unknown) {
  publisher.publish(MSG_CH(pod), JSON.stringify({ playerId, payload } satisfies ToPlayer));
}

/** Forward a paddle input to the Pod that is actually running the simulation. */
export function sendInputToRoom(ownerPod: string, roomId: string, side: Side, dir: -1 | 0 | 1) {
  publisher.publish(INPUT_CH(ownerPod), JSON.stringify({ roomId, side, dir } satisfies ToRoom));
}

/** Tell the owning Pod that a remote player's socket closed. */
export function sendLeaveToRoom(ownerPod: string, roomId: string, side: Side) {
  publisher.publish(INPUT_CH(ownerPod), JSON.stringify({ roomId, side, leave: true } satisfies ToRoom));
}

export async function stopBus() {
  try { await subscriber.unsubscribe(MSG_CH(POD_ID), INPUT_CH(POD_ID)); } catch { /* shutting down */ }
}
