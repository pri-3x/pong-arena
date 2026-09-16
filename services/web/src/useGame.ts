import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerMsg, Side, Status } from "./protocol";

export interface Snapshot {
  ball: [number, number];
  paddles: [number, number];
  score: [number, number];
  at: number; // client clock time this snapshot arrived
}

export function useGame() {
  const ws = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [side, setSide] = useState<Side | null>(null);
  const [instance, setInstance] = useState<string>("");
  const [roomId, setRoomId] = useState<string>("");
  const [names, setNames] = useState<Record<Side, string> | null>(null);
  const [result, setResult] = useState<{ winner: Side | null; reason: string } | null>(null);
  const [ping, setPing] = useState<number | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Two most recent snapshots. We render BETWEEN them, which is what turns a
  // 30 Hz stream into smooth 60 fps motion. Kept in a ref, not state, because
  // updating React state 30x/second would re-render the whole tree.
  const snaps = useRef<{ prev: Snapshot | null; curr: Snapshot | null }>({ prev: null, curr: null });

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    ws.current = socket;

    socket.onopen = () => setStatus("idle");
    socket.onclose = () => setStatus("disconnected");
    socket.onmessage = (ev) => {
      const m: ServerMsg = JSON.parse(ev.data);
      switch (m.t) {
        case "hello": setInstance(m.instance); break;
        case "waiting": setStatus("waiting"); break;
        case "matched": setSide(m.side); setRoomId(m.roomId); setInviteCode(null); break;
        case "start": setNames(m.players); setStatus("playing"); setResult(null); break;
        case "state": {
          const s: Snapshot = { ball: m.b, paddles: m.p, score: m.s, at: performance.now() };
          snaps.current = { prev: snaps.current.curr, curr: s };
          break;
        }
        case "invite": setInviteCode(m.code); setInviteError(null); setStatus("hosting"); break;
        case "invite_error": setInviteError(m.reason); setStatus("idle"); break;
        // This server is shutting down. Reconnecting lands us on a healthy
        // pod, because the draining one has already left the Service.
        case "draining":
        case "requeue":
          setNotice(m.t === "draining" ? m.message : m.reason);
          setStatus("idle");
          break;
        case "unauthorized": setStatus("unauthorized"); break;
        case "end": {
          // The winning point ends the match instantly, so no further `state`
          // message ever carries it. Patch the last snapshot with the
          // authoritative final score or the board freezes one point short.
          const c = snaps.current.curr;
          if (c && m.score) {
            snaps.current = { prev: c, curr: { ...c, score: [m.score.left, m.score.right], at: performance.now() } };
          }
          setResult({ winner: m.winner, reason: m.reason });
          // A lost server leaves no valid room; clear side so "Play again" works.
          if (m.reason === "server_lost") setSide(null);
          setStatus("finished");
          break;
        }
        case "pong": setPing(Math.round(performance.now() - m.ts)); break;
      }
    };

    const heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: "ping", ts: performance.now() }));
      }
    }, 2000);

    return () => { clearInterval(heartbeat); socket.close(); };
  }, []);

  const send = useCallback((msg: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);

  // We send the signed token, never a username. The server derives identity
  // from the signature, so a client cannot claim to be someone else.
  const join = useCallback((token: string) => {
    setNotice(null);
    snaps.current = { prev: null, curr: null };
    setResult(null);
    send({ t: "join", token });
  }, [send]);

  // We send a direction only when it CHANGES, not every frame. The server
  // keeps applying the last direction until told otherwise, so a held key
  // costs one message, not sixty per second.
  const lastDir = useRef<-1 | 0 | 1>(0);
  /** Create a private match and get a code to share. */
  const host = useCallback((token: string) => {
    setInviteError(null);
    send({ t: "host", token });
  }, [send]);

  /** Join a friend's private match by code. */
  const joinCode = useCallback((token: string, code: string) => {
    setInviteError(null);
    snaps.current = { prev: null, curr: null };
    setResult(null);
    send({ t: "join_code", token, code });
  }, [send]);

  const setDir = useCallback((dir: -1 | 0 | 1) => {
    if (dir === lastDir.current) return;
    lastDir.current = dir;
    send({ t: "input", dir });
  }, [send]);

  // Dev-only debug handle so the game state can be inspected from the console
  // (and by automated checks) without wiring it through React state.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__pong = { status, side, roomId, result, snaps, inviteCode, inviteError };
  }

  return { status, side, instance, roomId, names, result, ping, snaps,
           inviteCode, inviteError, notice, join, host, joinCode, setDir };
}
