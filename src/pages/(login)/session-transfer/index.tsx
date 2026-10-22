import { defineRoute } from "@teyik0/furin";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";

type Redemption = ReturnType<(typeof api.auth)["session-transfers"]["redeem"]["post"]>;

export const route = defineRoute("/(login)/session-transfer")
  .config({ mode: "ssr" })
  .head(() => ({
    meta: [
      { title: "Continue in your browser — Tofu" },
      { content: "noindex", name: "robots" },
      { content: "no-referrer", name: "referrer" },
    ],
  }))
  .page(() => {
    const [checking, setChecking] = useState(true);
    const [connected, setConnected] = useState(false);
    const [busy, setBusy] = useState(false);
    const [handoff, setHandoff] = useState<{ url: string; expiresAt: number } | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const incoming = useRef<{ secret: string | null } | null>(null);
    const redemption = useRef<Redemption | null>(null);

    useEffect(() => {
      let active = true;
      if (!incoming.current) {
        incoming.current = {
          secret: new URLSearchParams(window.location.hash.slice(1)).get("transfer"),
        };
        if (window.location.hash) {
          window.history.replaceState(null, "", window.location.pathname);
        }
      }
      const { secret } = incoming.current;
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Receiving a one-time handoff and preparing one from an existing session have distinct failure paths.
      const load = async () => {
        try {
          if (secret) {
            // Reserve once before awaiting: React effect replay must not redeem a one-time link twice.
            redemption.current ??= api.auth["session-transfers"].redeem.post(
              { secret },
              { fetch: { signal: AbortSignal.timeout(10_000) } }
            );
            const { error: failure } = await redemption.current;
            if (!active) {
              return;
            }
            if (failure) {
              setError(errorMessage(failure, "This transfer could not be completed."));
              return;
            }
            window.location.replace("/");
          } else {
            const { data, error: failure } = await api.session.get({
              fetch: { signal: AbortSignal.timeout(10_000) },
            });
            if (active) {
              setConnected(
                !failure && data.caller.kind === "device" && data.caller.deviceKind === "browser"
              );
            }
          }
        } catch {
          if (active) {
            setError(
              "The server could not be reached. Prepare a new link in the connected browser if this transfer cannot be completed."
            );
          }
        } finally {
          if (active) {
            setChecking(false);
          }
        }
      };
      void load();
      return () => {
        active = false;
      };
    }, []);

    useEffect(() => {
      if (!handoff) {
        return;
      }
      const timer = setTimeout(
        () => {
          setHandoff(null);
          setNotice("The transfer link expired. Prepare a new one when you are ready.");
          window.history.replaceState(null, "", window.location.pathname);
        },
        Math.max(0, handoff.expiresAt - Date.now())
      );
      return () => clearTimeout(timer);
    }, [handoff]);

    return (
      <div className="flex flex-col gap-5">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">Keep your connection in Safari</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            The QR scanner's browser may forget your connection when it closes. Move this connection
            to Safari, or another browser you use regularly, without another invitation code.
          </p>
        </div>
        {checking ? <p role="status">Checking your connection…</p> : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {connected ? (
          <>
            {handoff ? (
              <Alert>
                <AlertDescription className="flex flex-col gap-3">
                  <p>
                    The transfer link is ready in the address bar. Use this window's menu to open it
                    in Safari.
                  </p>
                  <p>
                    If that option is unavailable, copy the link and paste it into Safari. You will
                    be connected automatically.
                  </p>
                  <p>
                    Expires at {new Date(handoff.expiresAt).toLocaleTimeString()}. Anyone with this
                    link can use your access once before it expires.
                  </p>
                </AlertDescription>
              </Alert>
            ) : null}
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                setNotice(null);
                try {
                  const { data, error: failure } = await api.auth["session-transfers"].post(
                    undefined,
                    {
                      fetch: { signal: AbortSignal.timeout(10_000) },
                    }
                  );
                  if (failure) {
                    setError(errorMessage(failure, "Unable to prepare the transfer."));
                    return;
                  }
                  const target = new URL("/session-transfer", window.location.origin);
                  target.hash = new URLSearchParams({ transfer: data.secret }).toString();
                  setHandoff({ expiresAt: data.expiresAt, url: target.href });
                  window.history.replaceState(null, "", target.href);
                } catch {
                  setError(
                    "The server could not be reached. Your current connection is still available."
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Preparing…" : "Prepare Safari transfer"}
            </Button>
            {handoff ? (
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(handoff.url);
                    setNotice("Transfer link copied. Paste it into Safari within one minute.");
                  } catch {
                    setError(
                      "Clipboard unavailable. Copy the link from the address bar, or use Open in Safari from this window's menu."
                    );
                  }
                }}
                variant="outline"
              >
                Copy transfer link
              </Button>
            ) : null}
            <Button nativeButton={false} render={<a href="/" />} variant="ghost">
              Stay in this browser
            </Button>
          </>
        ) : null}
        {connected || checking ? null : (
          <>
            <p className="text-muted-foreground text-sm">
              Prepare a fresh transfer link in the browser that is already connected to Tofu.
            </p>
            <Button nativeButton={false} render={<a href="/pair" />} variant="outline">
              Use a new invitation
            </Button>
          </>
        )}
        {notice ? (
          <p className="text-muted-foreground text-sm" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    );
  });
