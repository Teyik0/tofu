import { defineRoute } from "@teyik0/furin";
import { useEffect, useRef, useState } from "react";
import type { DeviceRole } from "../../../api/modules/access/model";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../../components/ui/field";
import { Input } from "../../../components/ui/input";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";

type Preview = Extract<
  NonNullable<Awaited<ReturnType<typeof api.auth.pair.post>>["data"]>,
  { role: DeviceRole }
>;

const browsers: [string, string][] = [
  ["Edg/", "Edge"],
  ["Firefox/", "Firefox"],
  ["Chrome/", "Chrome"],
  ["Safari/", "Safari"],
];
const systems: [string, string][] = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
  ["Mac OS X", "Mac"],
  ["Windows", "Windows"],
  ["Linux", "Linux"],
];

const roles = {
  administration: {
    allowed: ["Browse the library and play videos", "Manage downloads, settings and devices"],
    denied: "No host folders or apps on the server computer",
    label: "Administration access",
  },
  management: {
    allowed: ["Browse the library and play videos", "Add, pause and resume downloads"],
    denied: "No server settings or device management",
    label: "Management access",
  },
  playback: {
    allowed: ["Browse the library and play videos", "Save progress in your own profile"],
    denied: "No downloads, deletion or server settings",
    label: "Playback access",
  },
};

async function sendPair(payload: Parameters<typeof api.auth.pair.post>[0]) {
  // Keep the nonce across transport retries so a lost response cannot pair another device.
  for (let attempt = 0; ; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: A retry waits for the previous transport attempt to fail.
      return await api.auth.pair.post(payload);
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
}

export const route = defineRoute("/(login)/pair")
  .config({ mode: "ssr" })
  .loader(async () => {
    const { instance } = await import("../../../api/lib/instance");
    return { scheme: instance.profile === "release" ? "tofu" : "tofu-dev" };
  })
  .head(() => ({
    meta: [
      { title: "Connect to a Tofu server" },
      { content: "noindex", name: "robots" },
      { content: "no-referrer", name: "referrer" },
    ],
  }))
  .page(({ scheme }) => {
    const [label, setLabel] = useState("");
    const [code, setCode] = useState("");
    const [preview, setPreview] = useState<Preview | null>(null);
    const [ready, setReady] = useState(false);
    const [secret, setSecret] = useState<string | undefined>();
    const [desktop, setDesktop] = useState(false);
    const [busy, setBusy] = useState(false);
    const [invalid, setInvalid] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const errorRef = useRef<HTMLDivElement>(null);
    const invitation = useRef<{ nonce: string; secret?: string; until: number } | null>(null);

    useEffect(() => {
      let active = true;
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Bootstrap preserves the one-time invitation through reloads, optional storage and preview failures.
      const load = async () => {
        if (!invitation.current) {
          const fragment = new URLSearchParams(window.location.hash.slice(1));
          if (window.location.hash) {
            window.history.replaceState(null, "", window.location.pathname);
          }
          let stored: { secret?: unknown; until?: unknown } | null = null;
          try {
            stored = JSON.parse(sessionStorage.getItem("tofu-invitation") ?? "null");
          } catch {
            // An invitation can still be used from memory when storage is unavailable.
          }
          const navigation = performance.getEntriesByType("navigation")[0] as
            | PerformanceNavigationTiming
            | undefined;
          const restored =
            ["reload", "back_forward"].includes(navigation?.type ?? "") &&
            typeof stored?.secret === "string" &&
            typeof stored.until === "number" &&
            stored.until > Date.now();
          const value = fragment.get("i") || (restored ? String(stored?.secret) : undefined);
          invitation.current = {
            nonce: crypto.randomUUID().replaceAll("-", ""),
            secret: value,
            until:
              restored && stored?.secret === value
                ? Number(stored?.until)
                : Date.now() + 15 * 60_000,
          };
          try {
            if (value) {
              sessionStorage.setItem("tofu-invitation", JSON.stringify(invitation.current));
            } else {
              sessionStorage.removeItem("tofu-invitation");
            }
          } catch {
            // Storage is optional; the current page retains the invitation.
          }
        }
        const pending = invitation.current;
        setSecret(pending.secret);
        const agent = navigator.userAgent;
        const browser = browsers.find(([name]) => agent.includes(name))?.[1] ?? "Browser";
        const system = systems.find(([name]) => agent.includes(name))?.[1] ?? "this device";
        setLabel(`${browser} on ${system}`);
        setDesktop(!["iPhone", "iPad", "Android"].some((name) => agent.includes(name)));
        if (!pending.secret) {
          setReady(true);
          return;
        }
        try {
          const { data, error: failure } = await sendPair({
            kind: "browser",
            label: "preview",
            nonce: pending.nonce,
            preview: true,
            secret: pending.secret,
          });
          if (!active) {
            return;
          }
          if (failure) {
            if (failure.status === 401 || failure.status === 410) {
              setInvalid(true);
              try {
                sessionStorage.removeItem("tofu-invitation");
              } catch {
                // Storage is optional.
              }
            }
            setError(errorMessage(failure, "This invitation cannot be used."));
            return;
          }
          if ("role" in data) {
            setPreview(data);
            pending.until = Math.min(pending.until, data.expiresAt);
            try {
              sessionStorage.setItem("tofu-invitation", JSON.stringify(pending));
            } catch {
              // Storage is optional.
            }
          }
        } catch {
          if (active) {
            setError(
              "Tofu could not reach this server. Check your connection and reload this page."
            );
          }
        } finally {
          if (active) {
            setReady(true);
          }
        }
      };
      void load();
      return () => {
        active = false;
      };
    }, []);

    useEffect(() => {
      if (error) {
        errorRef.current?.focus();
      }
    }, [error]);

    let validationError: string | null = null;
    if (!label.trim()) {
      validationError = "Enter a name for this device.";
    } else if (!(secret || code.trim())) {
      validationError = "Enter the invitation code.";
    }
    let intro = "Checking your invitation…";
    if (preview) {
      intro = `You've been invited to connect to ${preview.server.name}.`;
    } else if (ready && !secret) {
      intro = "Enter the invitation code you received.";
    }
    return (
      <div className="flex flex-col gap-6">
        <div>
          <p className="text-muted-foreground text-xs">1. Invitation · 2. Open your library</p>
          <h1 className="mt-4 font-semibold text-2xl tracking-tight">A library, within reach.</h1>
          <p className="mt-2 text-muted-foreground text-sm">{intro}</p>
        </div>
        {preview ? (
          <Alert>
            <div className="flex flex-col gap-2">
              <AlertTitle>{preview.server.name}</AlertTitle>
              <p>{roles[preview.role].label}</p>
            </div>
            <AlertDescription className="flex flex-col gap-3">
              <Badge variant="outline">
                Expires at {new Date(preview.expiresAt).toLocaleTimeString()}
              </Badge>
              <ul className="flex list-disc flex-col gap-2 pl-4 text-sm">
                {roles[preview.role].allowed.map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {preview.canDeleteFiles ? <li>Delete downloaded files</li> : null}
              </ul>
              <p className="text-muted-foreground text-xs">{roles[preview.role].denied}</p>
            </AlertDescription>
          </Alert>
        ) : null}
        <form
          aria-busy={busy || !ready}
          onSubmit={async (event) => {
            event.preventDefault();
            if (!invitation.current || busy || invalid || !ready) {
              return;
            }
            setError(null);
            if (validationError) {
              setError(validationError);
              return;
            }
            setBusy(true);
            try {
              const { error: failure } = await sendPair({
                code: secret ? undefined : code.trim(),
                kind: "browser",
                label: label.trim(),
                nonce: invitation.current.nonce,
                secret,
              });
              if (!failure || [401, 410].includes(failure.status)) {
                try {
                  sessionStorage.removeItem("tofu-invitation");
                } catch {
                  // Storage is optional.
                }
              }
              if (failure) {
                setError(errorMessage(failure, "This invitation cannot be used."));
                return;
              }
              window.location.replace(desktop ? "/" : "/session-transfer");
            } catch {
              setError(
                "The connection was interrupted. Try again; this invitation is not used twice."
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <FieldGroup>
            {ready && !secret ? (
              <Field>
                <FieldLabel htmlFor="pair-code">Invitation code</FieldLabel>
                <Input
                  autoCapitalize="characters"
                  autoComplete="one-time-code"
                  id="pair-code"
                  maxLength={32}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="ABCDE-FGHJK"
                  spellCheck={false}
                  value={code}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="pair-label">Name this device</FieldLabel>
              <Input
                aria-describedby="pair-label-note"
                autoComplete="off"
                id="pair-label"
                maxLength={64}
                onChange={(event) => setLabel(event.target.value)}
                value={label}
              />
              <FieldDescription id="pair-label-note">
                Shown to the server owner in Authorized devices.
              </FieldDescription>
            </Field>
            {error ? (
              <Alert ref={errorRef} tabIndex={-1} variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button disabled={!ready || busy || invalid} type="submit">
              {busy ? "Connecting…" : "Continue in this browser"}
            </Button>
            {desktop && secret ? (
              <Button
                disabled={busy || invalid || !ready}
                onClick={() => {
                  const target = new URL(`${scheme}://pair`);
                  target.searchParams.set("server", window.location.origin);
                  window.location.href = `${target.href}#i=${encodeURIComponent(secret)}`;
                  setNotice(
                    "If Tofu did not open, install the Tofu app or continue in this browser."
                  );
                }}
                variant="outline"
              >
                Open in Tofu
              </Button>
            ) : null}
            {notice ? (
              <p className="text-muted-foreground text-xs" role="status">
                {notice}
              </p>
            ) : null}
          </FieldGroup>
        </form>
        <p className="text-muted-foreground text-xs">
          This invitation works once. Choose where you want to use it. Your playback does not update
          the owner's AniList account.
        </p>
      </div>
    );
  });
