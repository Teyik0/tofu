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
      setError(cause instanceof Error ? cause.message : "Téléchargement impossible");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Button disabled={busy} onClick={() => void download()} size="sm" type="button">
        <DownloadIcon data-icon="inline-start" />
        Télécharger
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
        <strong>Tofu {data.latestVersion}</strong> est disponible.
      </p>
      <DownloadUpdate />
    </div>
  );
}

function statusText(state: UpdateState) {
  if (state.status === "available") {
    return `La version ${state.latestVersion} est disponible.`;
  }
  if (state.status === "current") {
    return "Vous utilisez la dernière version.";
  }
  if (state.status === "no-release") {
    return "Aucune release n’a encore été publiée.";
  }
  if (state.status === "checking") {
    return "Vérification des releases…";
  }
  if (state.status === "auth-required") {
    return "Connectez votre accès GitHub pour recevoir les mises à jour du dépôt privé.";
  }
  return "Les mises à jour sont vérifiées au démarrage, puis toutes les six heures.";
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
      setError(cause instanceof Error ? cause.message : "Vérification impossible");
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
          Mises à jour{" "}
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
          Vérifier
        </Button>
      </div>
      {data !== undefined && <FieldDescription role="status">{statusText(data)}</FieldDescription>}
      {data?.status === "available" && <DownloadUpdate />}
      <details>
        <summary className="cursor-pointer text-sm">
          {data?.hasToken ? "Gérer l’accès GitHub" : "Connecter GitHub"}
        </summary>
        <Field className="mt-3">
          <FieldLabel htmlFor="release-token">Jeton GitHub personnel</FieldLabel>
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
            placeholder={data?.hasToken ? "Remplacer le jeton enregistré" : "github_pat_…"}
            spellCheck={false}
            type="password"
            value={token}
          />
          <FieldDescription>
            Votre compte doit avoir accès à Teyik0/Tofu. Utilisez un jeton limité à ce dépôt avec la
            permission Contents en lecture. Il reste sur cette machine.
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
                Déconnecter
              </Button>
            )}
          </div>
        </Field>
      </details>
      {Boolean(error || data?.error || loadingError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {error ?? data?.error ?? "Impossible de charger les mises à jour"}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
