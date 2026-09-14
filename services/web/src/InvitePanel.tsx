import { useEffect, useState } from "react";

/**
 * Private matches. The host gets a code; the friend can either paste the code
 * or just click a link - the link is the same page with ?join=CODE, which is
 * far easier to send someone than a six-character string.
 */
export function InvitePanel({
  code, error, onHost, onJoin, busy,
}: {
  code: string | null;
  error: string | null;
  onHost: () => void;
  onJoin: (code: string) => void;
  busy: boolean;
}) {
  const [entered, setEntered] = useState("");
  const [copied, setCopied] = useState<"link" | "code" | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const link = code ? `${location.origin}/?join=${code}` : "";

  const copy = async (text: string, what: "link" | "code") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      // Clipboard access can be denied; the value is on screen to select.
      setCopied(null);
    }
  };

  if (code) {
    return (
      <div className="invite stack">
        <p className="hint">Send this to a friend. It works until someone joins.</p>
        <div className="codebox">
          <code className="code">{code}</code>
          <button type="button" onClick={() => copy(code, "code")}>
            {copied === "code" ? "Copied" : "Copy code"}
          </button>
          <button type="button" onClick={() => copy(link, "link")}>
            {copied === "link" ? "Copied" : "Copy link"}
          </button>
        </div>
        <p className="pulse hint">Waiting for them to join…</p>
      </div>
    );
  }

  return (
    <div className="invite stack">
      <button type="button" onClick={onHost} disabled={busy}>Create a private match</button>
      <form
        className="joinrow"
        onSubmit={(e) => { e.preventDefault(); if (entered.trim()) onJoin(entered.trim()); }}
      >
        <input
          value={entered}
          onChange={(e) => setEntered(e.target.value.toUpperCase())}
          placeholder="match code"
          aria-label="match code"
          maxLength={12}
          autoCapitalize="characters"
          spellCheck={false}
        />
        <button type="submit" disabled={!entered.trim() || busy}>Join</button>
      </form>
      {error && <p className="bad">{error}</p>}
    </div>
  );
}
