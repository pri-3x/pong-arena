import { useEffect, useState } from "react";
import { useGame } from "./useGame";
import { useAuth } from "./useAuth";
import { AuthPanel } from "./AuthPanel";
import { Field } from "./Field";
import { Stats } from "./Stats";
import { InvitePanel } from "./InvitePanel";

export default function App() {
  const auth = useAuth();
  const g = useGame();

  // Bumped whenever a match finishes, so the leaderboard and history reload
  // exactly when there is something new to show.
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (g.status === "finished") setRefreshKey((n) => n + 1);
  }, [g.status]);

  // A shared link looks like http://host/?join=ABC123. Read it once, then strip
  // it from the URL so a refresh does not try to re-join a consumed code.
  const [pendingCode, setPendingCode] = useState<string | null>(
    () => new URLSearchParams(location.search).get("join")
  );
  useEffect(() => {
    if (pendingCode) history.replaceState({}, "", location.pathname);
  }, [pendingCode]);

  // Once we are signed in (or a guest) and the socket is ready, use it.
  useEffect(() => {
    if (!pendingCode || !auth.token || g.status !== "idle") return;
    g.joinCode(auth.token, pendingCode);
    setPendingCode(null);
  }, [pendingCode, auth.token, g]);

  // Keyboard -> paddle direction. We track which keys are physically down so
  // that releasing one key while holding the other keeps you moving.
  useEffect(() => {
    const down = new Set<string>();
    const apply = () => {
      const up = down.has("ArrowUp") || down.has("w") || down.has("W");
      const dn = down.has("ArrowDown") || down.has("s") || down.has("S");
      g.setDir(up && !dn ? -1 : dn && !up ? 1 : 0);
    };
    const onDown = (e: KeyboardEvent) => {
      // Don't hijack the arrow keys while someone is typing in the login form.
      if (e.target instanceof HTMLInputElement) return;
      if (["ArrowUp", "ArrowDown"].includes(e.key)) e.preventDefault();
      down.add(e.key); apply();
    };
    const onUp = (e: KeyboardEvent) => { down.delete(e.key); apply(); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); };
  }, [g]);

  const iWon = g.result?.winner && g.result.winner === g.side;
  const canPlay = g.status === "idle" || g.status === "finished" || g.status === "unauthorized";
  const isGuest = auth.user?.guest === true;

  return (
    <div className="wrap">
      <header>
        <h1>Pong Arena</h1>
        <div className="meta">
          <span>served by <code>{g.instance || "…"}</code></span>
          {g.roomId && <span>room <code>{g.roomId}</code></span>}
          {g.ping !== null && <span>{g.ping} ms</span>}
          {auth.user && (
            <span>
              <strong className="you">{auth.user.username}</strong>
              {auth.user.guest && <span className="tag">guest</span>}{" "}
              <button className="link" onClick={auth.logout}>
                {auth.user.guest ? "exit" : "sign out"}
              </button>
            </span>
          )}
        </div>
      </header>

      <Field snaps={g.snaps} side={g.side} />

      <div className="panel">
        {!auth.ready && <p>…</p>}

        {auth.ready && !auth.user && <AuthPanel auth={auth} />}

        {auth.ready && auth.user && (
          <>
            {g.status === "connecting" && <p>Connecting…</p>}
            {g.status === "disconnected" && <p className="bad">Disconnected. Reload to reconnect.</p>}

            {canPlay && (
              <div className="actions">
                <button onClick={() => auth.token && g.join(auth.token)}>
                  {g.status === "finished" ? "Play again" : "Find a match"}
                </button>
                <InvitePanel
                  code={null}
                  error={g.inviteError}
                  busy={false}
                  onHost={() => auth.token && g.host(auth.token)}
                  onJoin={(c) => auth.token && g.joinCode(auth.token, c)}
                />
              </div>
            )}

            {g.status === "hosting" && (
              <InvitePanel
                code={g.inviteCode}
                error={g.inviteError}
                busy={false}
                onHost={() => {}}
                onJoin={() => {}}
              />
            )}

            {g.status === "waiting" && <p className="pulse">Waiting for an opponent… open a second browser tab.</p>}

            {isGuest && canPlay && (
              <p className="hint">Playing as a guest — this match will not be saved.</p>
            )}

            {g.status === "playing" && (
              <p>
                You are <strong className="you">{g.side}</strong>
                {g.names && <> — {g.names.left} vs {g.names.right}</>}. Use <kbd>↑</kbd>/<kbd>↓</kbd> or <kbd>W</kbd>/<kbd>S</kbd>.
              </p>
            )}

            {g.notice && <p className="hint">{g.notice}</p>}

            {g.status === "finished" && g.result && (
              <p className={iWon ? "good" : "bad"}>
                {g.result.reason === "server_draining"
                  ? "That server was shut down mid-match. The result was still recorded."
                  : g.result.reason === "server_lost"
                  ? "The server running this match became unavailable. No result was recorded."
                  : <>
                      {g.result.reason === "opponent_left" ? "Opponent left. " : ""}
                      {g.result.winner ? `${g.result.winner} wins.` : "No winner."} {iWon ? "You won!" : ""}
                    </>}
              </p>
            )}
          </>
        )}
      </div>

      <Stats me={auth.user?.username ?? null} refreshKey={refreshKey} />
    </div>
  );
}
