import { useCallback, useEffect, useState } from "react";

interface LeaderRow {
  username: string; played: number; wins: number; losses: number;
  points_for: number; points_against: number; win_rate: number;
}
interface MatchRow {
  id: string; ended_at: string; end_reason: string;
  players: Array<{ username: string; side: string; score: number; won: boolean }>;
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/**
 * `refreshKey` changes when a match ends, which re-runs the fetch. This is a
 * deliberately dumb refresh: history changes rarely, so polling or a live
 * subscription would be more machinery than the problem deserves.
 */
export function Stats({ me, refreshKey }: { me: string | null; refreshKey: number }) {
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [tab, setTab] = useState<"board" | "history">("board");

  const load = useCallback(async () => {
    try {
      const [b, m] = await Promise.all([
        fetch("/leaderboard?limit=10").then((r) => r.json()),
        fetch(me ? `/matches?username=${encodeURIComponent(me)}&limit=10` : "/matches?limit=10").then((r) => r.json()),
      ]);
      setBoard(b.leaderboard ?? []);
      setMatches(m.matches ?? []);
    } catch { /* the panel is not worth an error state */ }
  }, [me]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <section className="stats">
      <div className="tabs">
        <button type="button" className={tab === "board" ? "on" : ""} onClick={() => setTab("board")}>Leaderboard</button>
        <button type="button" className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
          {me ? "Your matches" : "Recent matches"}
        </button>
      </div>

      {tab === "board" && (
        board.length === 0 ? <p className="hint">No completed matches yet.</p> : (
          <table>
            <thead>
              <tr><th>#</th><th>Player</th><th>W</th><th>L</th><th>Win&nbsp;%</th><th>Pts</th></tr>
            </thead>
            <tbody>
              {board.map((r, i) => (
                <tr key={r.username} className={r.username === me ? "me" : ""}>
                  <td className="dim">{i + 1}</td>
                  <td>{r.username}</td>
                  <td>{r.wins}</td>
                  <td>{r.losses}</td>
                  <td>{r.win_rate}%</td>
                  <td className="dim">{r.points_for}–{r.points_against}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === "history" && (
        matches.length === 0 ? <p className="hint">No matches played yet.</p> : (
          <table>
            <tbody>
              {matches.map((m) => {
                const left = m.players.find((p) => p.side === "left");
                const right = m.players.find((p) => p.side === "right");
                const iWon = me ? m.players.find((p) => p.username === me)?.won : undefined;
                return (
                  <tr key={m.id}>
                    <td className={iWon === true ? "good" : iWon === false ? "bad" : "dim"}>
                      {iWon === undefined ? "—" : iWon ? "WIN" : "LOSS"}
                    </td>
                    <td>{left?.username} <span className="dim">vs</span> {right?.username}</td>
                    <td>{left?.score}–{right?.score}</td>
                    <td className="dim">{m.end_reason === "opponent_left" ? "abandoned" : ""}</td>
                    <td className="dim">{ago(m.ended_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}
