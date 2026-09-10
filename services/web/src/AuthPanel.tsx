import { useState } from "react";
import type { useAuth } from "./useAuth";

export function AuthPanel({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <form
      className="auth"
      onSubmit={(e) => { e.preventDefault(); void auth.submit(mode, username.trim(), password); }}
    >
      <div className="tabs">
        <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>Sign in</button>
        <button type="button" className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>Create account</button>
      </div>
      <input
        value={username} onChange={(e) => setUsername(e.target.value)}
        placeholder="username" autoComplete="username" maxLength={20} required
      />
      <input
        type="password" value={password} onChange={(e) => setPassword(e.target.value)}
        placeholder="password" required
        autoComplete={mode === "login" ? "current-password" : "new-password"}
      />
      <button type="submit" disabled={auth.busy}>
        {auth.busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
      </button>
      {auth.error && <p className="bad">{auth.error}</p>}
      {mode === "register" && !auth.error && (
        <p className="hint">3-20 characters, letters/numbers/underscore. Password at least 8 characters.</p>
      )}
    </form>
  );
}
