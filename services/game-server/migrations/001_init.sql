-- Users. The only thing we store about a person is a name and a password hash.
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usernames are case-insensitively unique: nobody should be able to register
-- "Alice" when "alice" exists. A unique index on lower(username) does this
-- without needing the citext extension.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

-- One row per completed match.
CREATE TABLE IF NOT EXISTS matches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        TEXT        NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ NOT NULL,
  winner_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  end_reason     TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS matches_ended_at_idx ON matches (ended_at DESC);

-- Two rows per match, one per participant. Kept separate from `matches` so a
-- query like "every match alice played" is a simple indexed lookup rather than
-- an OR across two columns.
CREATE TABLE IF NOT EXISTS match_players (
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  side     TEXT NOT NULL CHECK (side IN ('left', 'right')),
  score    INT  NOT NULL CHECK (score >= 0),
  won      BOOLEAN NOT NULL,
  PRIMARY KEY (match_id, user_id)
);

CREATE INDEX IF NOT EXISTS match_players_user_idx ON match_players (user_id);
