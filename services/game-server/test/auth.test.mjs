const BASE = process.argv[2] ?? "http://localhost:3101";
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; };
const post = (p, body, headers = {}) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (p, headers = {}) => fetch(BASE + p, { headers });

const u = "alice" + Math.floor(Math.random() * 1e6);
const PW = "correct horse battery";

// --- registration ---------------------------------------------------------
const r1 = await post("/auth/register", { username: u, password: PW });
const b1 = await r1.json();
check(r1.status === 201, `register returns 201 (got ${r1.status})`);
check(typeof b1.token === "string" && b1.token.split(".").length === 3, "register returns a JWT");
check(b1.user?.username === u, "register returns the user");
check(!("password_hash" in (b1.user ?? {})), "the password hash is never sent to the client");

const dup = await post("/auth/register", { username: u, password: PW });
check(dup.status === 409, `duplicate username returns 409 (got ${dup.status})`);

const dupCase = await post("/auth/register", { username: u.toUpperCase(), password: PW });
check(dupCase.status === 409, `duplicate is case-INSENSITIVE (got ${dupCase.status})`);

check((await post("/auth/register", { username: "ab", password: PW })).status === 400, "rejects a 2-char username");
check((await post("/auth/register", { username: "bad name!", password: PW })).status === 400, "rejects punctuation in username");
check((await post("/auth/register", { username: u + "x", password: "short" })).status === 400, "rejects a short password");

// --- login ----------------------------------------------------------------
const ok = await post("/auth/login", { username: u, password: PW });
const okBody = await ok.json();
check(ok.status === 200 && typeof okBody.token === "string", "login with the right password returns a token");

const upper = await post("/auth/login", { username: u.toUpperCase(), password: PW });
check(upper.status === 200, "login is case-insensitive on username");

const wrong = await post("/auth/login", { username: u, password: PW + "!" });
const noUser = await post("/auth/login", { username: "nobody" + Date.now(), password: PW });
check(wrong.status === 401, "wrong password returns 401");
check(noUser.status === 401, "unknown user returns 401");
check((await wrong.json()).error === (await noUser.json()).error,
  "wrong password and unknown user are INDISTINGUISHABLE (no username enumeration)");

// --- token verification ---------------------------------------------------
const me = await get("/auth/me", { authorization: `Bearer ${okBody.token}` });
check(me.status === 200 && (await me.json()).user.username === u, "/auth/me returns the caller");
check((await get("/auth/me")).status === 401, "/auth/me without a token is 401");
check((await get("/auth/me", { authorization: "Bearer not.a.token" })).status === 401, "garbage token is 401");

// flip one character of the signature
const parts = okBody.token.split(".");
const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${parts[2].slice(-1) === "A" ? "B" : "A"}`;
check((await get("/auth/me", { authorization: `Bearer ${tampered}` })).status === 401,
  "a tampered signature is rejected");

// a token whose PAYLOAD was edited to impersonate someone else
const evil = Buffer.from(JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", username: "admin", iss: "pong-arena" })).toString("base64url");
check((await get("/auth/me", { authorization: `Bearer ${parts[0]}.${evil}.${parts[2]}` })).status === 401,
  "an edited payload is rejected (signature no longer matches)");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
