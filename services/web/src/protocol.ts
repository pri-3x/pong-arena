/** Server -> client messages. Kept in sync with docs/websocket-protocol.md */
export type Side = "left" | "right";

export type ServerMsg =
  | { t: "hello"; instance: string; playerId: string }
  | { t: "waiting"; playerId: string }
  | { t: "matched"; roomId: string; side: Side; playerId: string }
  | { t: "start"; players: Record<Side, string> }
  | { t: "state"; k: number; b: [number, number]; p: [number, number]; s: [number, number] }
  | { t: "score"; score: Record<Side, number>; scored: Side }
  | { t: "end"; winner: Side | null; score?: Record<Side, number>; reason: string; message?: string }
  | { t: "pong"; ts: number }
  | { t: "unauthorized"; message: string }
  | { t: "error"; message: string };

export type Status = "connecting" | "idle" | "waiting" | "playing" | "finished" | "disconnected" | "unauthorized";
