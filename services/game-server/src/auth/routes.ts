import type { FastifyInstance } from "fastify";
import { hashPassword, verifyPassword } from "./password.js";
import { issueToken, verifyToken } from "./token.js";
import { createUser, findByUsername, findById, USERNAME_RE } from "../db/users.js";

interface Credentials { username?: unknown; password?: unknown }

function validate(body: Credentials): { username: string; password: string } | string {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!USERNAME_RE.test(username)) return "username must be 3-20 characters, letters/numbers/underscore";
  if (password.length < 8) return "password must be at least 8 characters";
  if (password.length > 200) return "password is too long";
  return { username, password };
}

/** Pull a bearer token out of the Authorization header. */
export function bearer(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (req, reply) => {
    const v = validate(req.body as Credentials);
    if (typeof v === "string") return reply.code(400).send({ error: v });

    try {
      const user = await createUser(v.username, await hashPassword(v.password));
      const token = await issueToken({ sub: user.id, username: user.username });
      return reply.code(201).send({ token, user });
    } catch (e) {
      // 23505 = unique_violation. Let the DATABASE decide uniqueness rather
      // than checking first and inserting - a check-then-insert has a race
      // where two simultaneous registrations both pass the check.
      if ((e as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "username already taken" });
      }
      throw e;
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const v = validate(req.body as Credentials);
    if (typeof v === "string") return reply.code(401).send({ error: "invalid credentials" });

    const row = await findByUsername(v.username);
    // Deliberately identical response whether the user does not exist or the
    // password is wrong. Distinguishing them tells an attacker which usernames
    // are real.
    if (!row || !(await verifyPassword(v.password, row.password_hash))) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    const token = await issueToken({ sub: row.id, username: row.username });
    return reply.send({
      token,
      user: { id: row.id, username: row.username, created_at: row.created_at },
    });
  });

  app.get("/auth/me", async (req, reply) => {
    const claims = await verifyToken(bearer(req.headers.authorization));
    if (!claims) return reply.code(401).send({ error: "unauthorized" });
    const user = await findById(claims.sub);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return reply.send({ user });
  });
}
