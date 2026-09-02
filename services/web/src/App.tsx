import { useEffect, useState } from "react";
import { useGame } from "./useGame";
import { Field } from "./Field";

export default function App() {
  const g = useGame();
  const [name, setName] = useState("player" + Math.floor(Math.random() * 900 + 100));

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
      if (["ArrowUp", "ArrowDown"].includes(e.key)) e.preventDefault();
      down.add(e.key); apply();
    };
    const onUp = (e: KeyboardEvent) => { down.delete(e.key); apply(); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); };
  }, [g]);

  const iWon = g.result?.winner && g.result.winner === g.side;

  return (
    <div className="wrap">
      <header>
        <h1>Pong Arena</h1>
        <div className="meta">
          <span>served by <code>{g.instance || "…"}</code></span>
          {g.roomId && <span>room <code>{g.roomId}</code></span>}
          {g.ping !== null && <span>{g.ping} ms</span>}
        </div>
      </header>

      <Field snaps={g.snaps} side={g.side} />

      <div className="panel">
        {g.status === "connecting" && <p>Connecting…</p>}
        {g.status === "disconnected" && <p className="bad">Disconnected. Reload to reconnect.</p>}

        {(g.status === "idle" || g.status === "finished") && (
          <form onSubmit={(e) => { e.preventDefault(); g.join(name); }}>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
            <button type="submit">{g.status === "finished" ? "Play again" : "Find a match"}</button>
          </form>
        )}

        {g.status === "waiting" && <p className="pulse">Waiting for an opponent… open a second browser tab.</p>}

        {g.status === "playing" && (
          <p>
            You are <strong className="you">{g.side}</strong>
            {g.names && <> — {g.names.left} vs {g.names.right}</>}. Use <kbd>↑</kbd>/<kbd>↓</kbd> or <kbd>W</kbd>/<kbd>S</kbd>.
          </p>
        )}

        {g.status === "finished" && g.result && (
          <p className={iWon ? "good" : "bad"}>
            {g.result.reason === "opponent_left" ? "Opponent left. " : ""}
            {g.result.winner ? `${g.result.winner} wins.` : "No winner."} {iWon ? "You won!" : ""}
          </p>
        )}
      </div>
    </div>
  );
}
