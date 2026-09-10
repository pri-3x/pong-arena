import { useCallback, useEffect, useState } from "react";

export interface User { id: string; username: string; created_at: string }

const KEY = "pong.token";

/**
 * sessionStorage, not localStorage.
 *
 * localStorage is shared by every tab on the origin, so signing in as a second
 * player in a second tab would silently replace the first tab's identity.
 * sessionStorage is per-tab, which lets one browser hold two players - exactly
 * what you need to demo or test a two-player game locally.
 *
 * Trade-off: closing the tab signs you out. For a game session that is fine.
 */
const store = sessionStorage;

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => store.getItem(KEY));
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  // On load, ask the server who this stored token belongs to. A token can be
  // expired or revoked, so we never trust it without checking.
  useEffect(() => {
    if (!token) { setReady(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/auth/me", { headers: { authorization: `Bearer ${token}` } });
        if (cancelled) return;
        if (r.ok) setUser((await r.json()).user);
        else { store.removeItem(KEY); setToken(null); }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const submit = useCallback(async (kind: "login" | "register", username: string, password: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/auth/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await r.json();
      if (!r.ok) { setError(body.error ?? "something went wrong"); return false; }
      store.setItem(KEY, body.token);
      setToken(body.token);
      setUser(body.user);
      return true;
    } catch {
      setError("cannot reach the server");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const logout = useCallback(() => {
    store.removeItem(KEY);
    setToken(null); setUser(null);
  }, []);

  return { token, user, error, busy, ready, submit, logout };
}
