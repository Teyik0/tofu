import { defineRoute } from "@teyik0/furin";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";

type Claim = ReturnType<typeof api.auth.reconnections.claim.post>;

function restoreReconnection() {
  let restored: { browserSecret: string; expiresAt: number; secret: string } | null = null;
  const secret = new URLSearchParams(window.location.hash.slice(1)).get("reconnect");
  window.history.replaceState(null, "", window.location.pathname);
  if (secret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const browserSecret = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    restored = { browserSecret, expiresAt: Date.now() + 60_000, secret };
    try {
      sessionStorage.setItem("tofu-reconnection", JSON.stringify(restored));
    } catch {
      /* This connection can still complete without browser storage. */
    }
  } else {
    try {
      const stored = JSON.parse(sessionStorage.getItem("tofu-reconnection") ?? "null");
      if (
        typeof stored?.browserSecret === "string" &&
        typeof stored.secret === "string" &&
        typeof stored.expiresAt === "number" &&
        stored.expiresAt > Date.now()
      ) {
        restored = stored;
      }
    } catch {
      /* A fresh QR code works even when browser storage is unavailable. */
    }
  }
  return restored;
}

export const route = defineRoute("/(login)/reconnect")
  .config({ mode: "ssr" })
  .head(() => ({
    meta: [
      { title: "Approve your browser — Tofu" },
      { content: "noindex", name: "robots" },
      { content: "no-referrer", name: "referrer" },
    ],
  }))
  .page(() => {
    const [pending, setPending] = useState<{ browserSecret: string; id: string } | null>(null);
    const [code, setCode] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const claim = useRef<Claim | null>(null);
    const input = useRef<{ browserSecret: string; secret: string; expiresAt: number } | null>(null);
    useEffect(() => {
      let active = true;
      const connect = async () => {
        try {
          input.current ??= restoreReconnection();
          if (!input.current) {
            setError(
              "Generate a reconnection QR code in Edit access on the Mac, then scan it here."
            );
            return;
          }
          const { browserSecret, secret } = input.current;
          const agent = navigator.userAgent;
          const label = agent.includes("iPhone") ? "Browser on iPhone" : "New browser";
          claim.current ??= api.auth.reconnections.claim.post(
            { browserSecret, label, secret },
            { fetch: { signal: AbortSignal.timeout(10_000) } }
          );
          const { data, error: failure } = await claim.current;
          if (!active) {
            return;
          }
          if (failure) {
            setError(errorMessage(failure, "Unable to request browser access."));
            return;
          }
          setCode(data.code);
          setPending({ browserSecret, id: data.id });
        } catch {
          if (active) {
            setError(
              "The server could not be reached. Generate a new QR code if this request cannot be restored."
            );
          }
        }
      };
      void connect();
      return () => {
        active = false;
      };
    }, []);
    useEffect(() => {
      if (!pending) {
        return;
      }
      let active = true;
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const { data: result, error: rejected } = await api.auth.reconnections.complete.post(
            { browserSecret: pending.browserSecret, id: pending.id },
            { fetch: { signal: AbortSignal.timeout(10_000) } }
          );
          if (!active) {
            return;
          }
          if (rejected) {
            setError(errorMessage(rejected, "This request can no longer connect."));
            return;
          }
          if ("connected" in result) {
            try {
              sessionStorage.removeItem("tofu-reconnection");
            } catch {
              /* An unavailable storage area does not prevent sign-in. */
            }
            window.location.replace("/");
            return;
          }
          timer = setTimeout(poll, 1500);
        } catch {
          if (active) {
            setError(
              "The server could not be reached. Reload to retry before the QR code expires."
            );
          }
        }
      };
      void poll();
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [pending]);
    return (
      <div className="flex flex-col gap-5">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">
            Approve this browser on your Mac
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            Compare the code below with Edit access on the Mac. Approve there only when both codes
            match.
          </p>
        </div>
        {code && !error ? (
          <strong className="text-center font-mono text-3xl tracking-widest">{code}</strong>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <p role="status">Waiting for approval on the Mac…</p>
        )}
        <p className="text-muted-foreground text-sm">
          Scanning does not grant access. After approval, this browser gets its own connection with
          the same profile and permissions. Safari keeps its existing connection.
        </p>
        <Button nativeButton={false} render={<a href="/" />} variant="outline">
          Cancel and return
        </Button>
      </div>
    );
  });
