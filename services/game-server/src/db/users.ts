import { pool } from "./index.js";

export interface User { id: string; username: string; created_at: string }
interface UserRow extends User { password_hash: string }

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

/** Throws a pg error with code 23505 if the username is taken. */
export async function createUser(username: string, passwordHash: string): Promise<User> {
  const { rows } = await pool.query<User>(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2)
     RETURNING id, username, created_at`,
    [username, passwordHash]
  );
  return rows[0];
}

export async function findByUsername(username: string): Promise<UserRow | null> {
  // Compare on lower(username) so login is case-insensitive, matching the
  // unique index that prevents "Alice" and "alice" both existing.
  const { rows } = await pool.query<UserRow>(
    `SELECT id, username, password_hash, created_at FROM users WHERE lower(username) = lower($1)`,
    [username]
  );
  return rows[0] ?? null;
}

export async function findById(id: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    `SELECT id, username, created_at FROM users WHERE id = $1`, [id]
  );
  return rows[0] ?? null;
}
