import { pool } from "./index.js";
import type { MatchResult } from "../game/room.js";

/**
 * Persist one finished match.
 *
 * Wrapped in a transaction because a `matches` row without its `match_players`
 * rows is worse than no row at all: it would show up in history as a match with
 * no participants. Either all three rows land, or none do.
 */
export async function recordMatch(result: MatchResult): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO matches (room_id, started_at, ended_at, winner_user_id, end_reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [result.roomId, result.startedAt, result.endedAt, result.winnerUserId, result.endReason]
    );
    const matchId = rows[0].id;
    for (const p of result.players) {
      await client.query(
        `INSERT INTO match_players (match_id, user_id, side, score, won)
         VALUES ($1, $2, $3, $4, $5)`,
        [matchId, p.userId, p.side, p.score, p.won]
      );
    }
    await client.query("COMMIT");
    return matchId;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface MatchRow {
  id: string;
  room_id: string;
  started_at: string;
  ended_at: string;
  end_reason: string;
  players: Array<{ username: string; side: string; score: number; won: boolean }>;
}

// One query, not N+1. Aggregating the participants into JSON inside Postgres
// avoids fetching matches and then querying players for each one.
const MATCH_SELECT = `
  SELECT m.id, m.room_id, m.started_at, m.ended_at, m.end_reason,
         json_agg(
           json_build_object('username', u.username, 'side', mp.side,
                             'score', mp.score, 'won', mp.won)
           ORDER BY mp.side
         ) AS players
  FROM matches m
  JOIN match_players mp ON mp.match_id = m.id
  JOIN users u          ON u.id = mp.user_id
`;

export async function recentMatches(limit: number): Promise<MatchRow[]> {
  const { rows } = await pool.query<MatchRow>(
    `${MATCH_SELECT} GROUP BY m.id ORDER BY m.ended_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function matchesForUser(username: string, limit: number): Promise<MatchRow[]> {
  const { rows } = await pool.query<MatchRow>(
    `${MATCH_SELECT}
     WHERE m.id IN (
       SELECT mp2.match_id FROM match_players mp2
       JOIN users u2 ON u2.id = mp2.user_id
       WHERE lower(u2.username) = lower($1)
     )
     GROUP BY m.id ORDER BY m.ended_at DESC LIMIT $2`,
    [username, limit]
  );
  return rows;
}

export interface LeaderboardRow {
  username: string; played: number; wins: number; losses: number;
  points_for: number; points_against: number; win_rate: number;
}

/**
 * Wins and losses per player.
 *
 * Only matches that ended with `end_reason = 'win'` count. Abandoned matches
 * are still stored and still appear in history, but awarding leaderboard wins
 * for an opponent rage-quitting would make the ranking farmable.
 */
export async function leaderboard(limit: number): Promise<LeaderboardRow[]> {
  const { rows } = await pool.query(
    `SELECT u.username,
            count(*)::int                             AS played,
            count(*) FILTER (WHERE mp.won)::int       AS wins,
            count(*) FILTER (WHERE NOT mp.won)::int   AS losses,
            sum(mp.score)::int                        AS points_for,
            (sum(total.points) - sum(mp.score))::int  AS points_against
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id AND m.end_reason = 'win'
     JOIN users   u ON u.id = mp.user_id
     JOIN LATERAL (
       SELECT sum(score) AS points FROM match_players WHERE match_id = m.id
     ) total ON true
     GROUP BY u.id, u.username
     ORDER BY wins DESC, losses ASC, u.username ASC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    ...r,
    win_rate: r.played ? Math.round((r.wins / r.played) * 100) : 0,
  })) as LeaderboardRow[];
}
