import { useMutation, useQuery } from "@teyik0/furin/client";
import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { api } from "../client";
import type { UpdateState } from "../types";
import { request } from "./api";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./ui/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

function useUpdateDownload() {
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
  return { busy, download, error };
}

function statusText(state: UpdateState) {
  if (state.status === "available") {
    return `Version ${state.latestVersion} is available.`;
  }
  if (state.status === "current") {
    return "Current version of the application.";
  }
  if (state.status === "no-release") {
    return "No release has been published yet.";
  }
  if (state.status === "checking") {
    return "Checking releases…";
  }
  if (state.status === "error") {
    return state.error ?? "Unable to check for updates.";
  }
  return "Updates are checked at startup and every six hours.";
}

/** Keeps the refresh icon turning for at least one full rotation, even when a check returns
 *  instantly, so a manual click always gets visible feedback. */
function useSpinLatch(checking: boolean) {
  const [latched, setLatched] = useState(false);
  return {
    latch: () => setLatched(true),
    onAnimationIteration: () => {
      if (!checking) {
        setLatched(false);
      }
    },
    spinning: checking || latched,
  };
}

export function SidebarUpdateAction() {
  const { data: live, error: loadingError } = useQuery(api.api.updates.get);
  const data = live && "status" in live ? live : undefined;
  const check = useMutation(api.api.updates.check.post);
  const download = useUpdateDownload();
  const checking = check.isPending || data?.status === "checking";
  const spin = useSpinLatch(checking);
  const available = data?.status === "available";
  let label = "Check for updates";
  if (download.busy) {
    label = "Starting download…";
  } else if (spin.spinning) {
    label = "Checking for updates…";
  } else if (available) {
    label = `Update ${data.latestVersion} ready to download`;
  }
  const error = download.error ?? check.error?.value.detail ?? data?.error;
  const activate = () => {
    if (!data || spin.spinning || download.busy) {
      return;
    }
    if (available) {
      void download.download();
    } else {
      spin.latch();
      check.mutate();
    }
  };
  return (
    <div className="sidebar-update">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-busy={spin.spinning || download.busy}
              aria-label={label}
              className="rounded-full"
              disabled={!data || spin.spinning || download.busy}
              onClick={activate}
              size="icon"
              type="button"
              variant={available ? "secondary" : "ghost"}
            >
              {download.busy ? (
                <LoaderCircleIcon className="motion-safe:animate-spin" />
              ) : available && !spin.spinning ? (
                <span className="relative flex">
                  <DownloadIcon aria-hidden="true" />
                  <span
                    aria-hidden="true"
                    className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-secondary"
                  />
                </span>
              ) : (
                <RefreshCwIcon
                  className={spin.spinning ? "motion-safe:animate-spin" : undefined}
                  onAnimationIteration={spin.onAnimationIteration}
                />
              )}
            </Button>
          }
        />
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status">
        {label}
      </span>
      {Boolean(error || loadingError) && (
        <p className="sr-only" role="alert">
          {error ?? "Unable to load updates"}
        </p>
      )}
    </div>
  );
}

export function UpdatesPanel({ disabled }: { disabled: boolean }) {
  const { data: live, error: loadingError } = useQuery(api.api.updates.get);
  const data = live && "status" in live ? live : undefined;
  const check = useMutation(api.api.updates.check.post);
  const download = useUpdateDownload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checking = check.isPending || data?.status === "checking";
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
  const available = data?.status === "available";
  let checkLabel = "Check for Updates";
  if (download.busy) {
    checkLabel = "Downloading…";
  } else if (available) {
    checkLabel = "Download";
  } else if (checking) {
    checkLabel = "Checking…";
  } else if (data?.status === "current") {
    checkLabel = "Up to Date";
  }
  const failure =
    error ?? download.error ?? data?.error ?? (loadingError ? "Unable to load updates" : null);
  return (
    <FieldSet>
      <FieldLegend>About</FieldLegend>
      <FieldGroup className="settings-group">
        <Field className="settings-row" orientation="horizontal">
          <FieldContent>
            <FieldLabel>
              Version
              <span className="font-normal text-muted-foreground">
                {data ? `v${data.currentVersion}` : "—"}
              </span>
            </FieldLabel>
            <FieldDescription role="status">
              {data ? statusText(data) : "Loading update status…"}
            </FieldDescription>
          </FieldContent>
          <Button
            disabled={disabled || busy || download.busy || checking}
            onClick={() =>
              available ? void download.download() : void action(() => check.mutateAsync())
            }
            size="sm"
            type="button"
            variant={available ? "default" : "outline"}
          >
            {available ? (
              <DownloadIcon data-icon="inline-start" />
            ) : (
              <RefreshCwIcon
                className={checking ? "motion-safe:animate-spin" : undefined}
                data-icon="inline-start"
              />
            )}
            {checkLabel}
          </Button>
        </Field>
      </FieldGroup>
      {failure !== null && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
    </FieldSet>
  );
}
