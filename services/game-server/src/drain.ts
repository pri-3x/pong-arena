/**
 * Graceful shutdown.
 *
 * The problem: a Pod holds long-lived WebSocket connections and is simulating
 * matches. When Kubernetes terminates it - a scale-down, a rolling update, a
 * node drain - killing the process drops those matches. The `preStop` hook
 * already stops NEW requests being routed here, but it does nothing for work
 * already in flight.
 *
 * The drain sequence:
 *
 *   SIGTERM
 *     1. mark draining  -> /ready returns 503 -> removed from Service endpoints
 *                       -> new join/host/join_code are refused
 *     2. pull our queued players out of the shared matchmaking queue, so nobody
 *        is matched INTO a Pod that is going away
 *     3. wait for in-flight matches to finish on their own (a match is ~20s)
 *     4. anything still running at the deadline: end it properly, so players
 *        are told and the result is still written
 *     5. close everything and exit
 *
 * The whole sequence must fit inside terminationGracePeriodSeconds, which also
 * covers the preStop hook. Kubernetes SIGKILLs at the deadline regardless.
 */
export interface DrainOptions {
  /** How long to wait for matches to finish before ending them. */
  timeoutMs: number;
  /** How often to re-check. */
  pollMs: number;
  playersInMatches: () => number;
  matchesOwnedHere: () => number;
  clearQueue: () => Promise<void>;
  endAll: () => number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

let draining = false;

/** True once SIGTERM has been received. Readiness and joins check this. */
export function isDraining(): boolean {
  return draining;
}

/** Exported for tests. */
export function resetDrainState(): void {
  draining = false;
}

export async function drain(opts: DrainOptions): Promise<void> {
  if (draining) return;
  draining = true;

  const started = Date.now();
  opts.log("draining: no longer accepting new matches", {
    playersInMatches: opts.playersInMatches(),
    matchesOwnedHere: opts.matchesOwnedHere(),
  });

  // Anyone of ours sitting in the shared queue must come out of it now.
  await opts.clearQueue().catch(() => {});

  // Wait for matches to end naturally.
  while (Date.now() - started < opts.timeoutMs) {
    const players = opts.playersInMatches();
    if (players === 0) {
      opts.log("draining: all matches finished", { waitedMs: Date.now() - started });
      return;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }

  // Deadline. End what is left rather than dropping sockets silently.
  const ended = opts.endAll();
  opts.log("draining: deadline reached, ended remaining matches", {
    endedMatches: ended,
    waitedMs: Date.now() - started,
  });
}
