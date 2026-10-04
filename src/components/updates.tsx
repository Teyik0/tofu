import { useMutation, useQuery } from "@teyik0/furin/client";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { api } from "../client";
import type { UpdateState } from "../types";
import { request } from "./api";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

function DownloadUpdate() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ opened: boolean }>("/updates/open-download", "POST", {});
      if (!result.opened) {
        window.location.assign("/api/updates/download");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to download");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Button disabled={busy} onClick={() => void download()} size="sm" type="button">
        <DownloadIcon data-icon="inline-start" />
        Download
      </Button>
      {error !== null && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function UpdateNotice() {
  const { data: live } = useQuery(api.api.updates.get);
  const data = live && "status" in live ? live : undefined;
  if (data?.status !== "available") {
    return null;
  }
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-3 border-b bg-accent/40 px-5 py-3"
      role="status"
    >
      <p className="text-sm">
        <strong>Tofu {data.latestVersion}</strong> is available.
      </p>
      <DownloadUpdate />
    </div>
  );
}

function statusText(state: UpdateState) {
  if (state.status === "available") {
    return `Version ${state.latestVersion} is available.`;
  }
  if (state.status === "current") {
    return "You are using the latest version.";
  }
  if (state.status === "no-release") {
    return "No release has been published yet.";
  }
  if (state.status === "checking") {
    return "Checking releases…";
  }
  if (state.status === "auth-required") {
    return "Connect GitHub to receive updates from the private repository.";
  }
  return "Updates are checked at startup and every six hours.";
}

export function UpdatesPanel({ disabled }: { disabled: boolean }) {
  const { data: live, error: loadingError } = useQuery(api.api.updates.get);
  const data = live && "status" in live ? live : undefined;
  const check = useMutation(api.api.updates.check.post);
  const access = useMutation(api.api.updates.access.post);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to verify");
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    await access.mutateAsync({ token: token.trim() });
    setToken("");
    await check.mutateAsync();
  };
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-sm">
          Updates{" "}
          <span className="font-normal text-muted-foreground">
            {data ? `· v${data.currentVersion}` : ""}
          </span>
        </p>
        <Button
          disabled={disabled || busy || !data?.hasToken}
          onClick={() => void action(() => check.mutateAsync())}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCwIcon className={busy ? "animate-spin" : undefined} data-icon="inline-start" />
          Check
        </Button>
      </div>
      {data !== undefined && <FieldDescription role="status">{statusText(data)}</FieldDescription>}
      {data?.status === "available" && <DownloadUpdate />}
      <details>
        <summary className="cursor-pointer text-sm">
          {data?.hasToken ? "Manage GitHub access" : "Connect GitHub"}
        </summary>
        <Field className="mt-3">
          <FieldLabel htmlFor="release-token">Personal GitHub token</FieldLabel>
          <Input
            autoComplete="off"
            disabled={disabled || busy}
            id="release-token"
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (token.trim()) {
                  void action(save);
                }
              }
            }}
            placeholder={data?.hasToken ? "Replace the saved token" : "github_pat_…"}
            spellCheck={false}
            type="password"
            value={token}
          />
          <FieldDescription>
            Your account must have access to Teyik0/Tofu. Use a token limited to this repository
            with Contents read permission. It stays on this machine.
          </FieldDescription>
          <div className="flex gap-2">
            <Button
              disabled={disabled || busy || !token.trim()}
              onClick={() => void action(save)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Connecter
            </Button>
            {data?.hasToken === true && (
              <Button
                disabled={disabled || busy}
                onClick={() => void action(() => access.mutateAsync({ clearToken: true }))}
                size="sm"
                type="button"
                variant="ghost"
              >
                Disconnect
              </Button>
            )}
          </div>
        </Field>
      </details>
      {Boolean(error || data?.error || loadingError) && (
        <Alert variant="destructive">
          <AlertDescription>{error ?? data?.error ?? "Unable to load updates"}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
