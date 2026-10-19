import { useMutation, useQuery } from "@teyik0/furin/client";
import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useAsyncAction } from "../hooks/use-async-action";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import type { UpdateState } from "../types";
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

function useUpdateAction(state: UpdateState | undefined) {
  const prepare = useMutation(api.updates.prepare.post);
  const install = useMutation(api.updates.install.post);
  const openDownload = useMutation(api.updates["open-download"].post);
  const { busy, error, run } = useAsyncAction("Unable to download");
  const download = () =>
    run(async () => {
      if (state?.automatic) {
        await (state.status === "ready" ? install.mutateAsync() : prepare.mutateAsync());
        const { error: refreshError } = await api.updates.get();
        if (refreshError) {
          throw refreshError;
        }
        return;
      }
      const result = await openDownload.mutateAsync();
      if (result && "opened" in result && !result.opened) {
        window.location.assign("/api/updates/download");
      }
    });
  return { busy, download, error };
}

function statusText(state: UpdateState) {
  if (state.status === "downloading") {
    return state.progress === null
      ? "Preparing update…"
      : `Downloading update… ${Math.round(state.progress)}%`;
  }
  if (state.status === "ready") {
    return `Version ${state.latestVersion} is ready. Restart to install; your downloads and settings are preserved.`;
  }
  if (state.status === "restarting") {
    return "Saving downloads and restarting to install the update…";
  }
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

function useUpdateCheck() {
  const mutation = useMutation(api.updates.check.post);
  const { busy, error, action } = useAsyncAction("Unable to verify");
  return {
    busy,
    check: () =>
      action(async () => {
        // Visible feedback must finish even when reduced motion disables animation events.
        const feedback = new Promise<void>((resolve) => setTimeout(resolve, 500));
        try {
          await mutation.mutateAsync();
          const { error: refreshError } = await api.updates.get();
          if (refreshError) {
            throw refreshError;
          }
        } finally {
          await feedback;
        }
      }),
    error,
  };
}

export function SidebarUpdateAction() {
  const controls = useUpdateControls();
  const [progressError, setProgressError] = useState<string | null>(null);
  const { data, loadingError, check, download, checking, available, ready, updating, activate } =
    controls;
  useEffect(() => {
    if (!updating) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { error: refreshError } = await api.updates.get();
        if (refreshError) {
          throw refreshError;
        }
        if (active) {
          setProgressError(null);
        }
      } catch (cause) {
        if (active) {
          setProgressError(errorMessage(cause, "Unable to load update progress"));
        }
      } finally {
        if (active) {
          timer = setTimeout(poll, 500);
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [updating]);
  const label = sidebarLabel(controls);
  const error = download.error ?? check.error ?? data?.error ?? (updating ? progressError : null);
  return (
    <div className="sidebar-update">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-busy={checking || download.busy || updating}
              aria-label={label}
              className="rounded-full"
              disabled={!data || checking || download.busy || updating}
              onClick={activate}
              size="icon"
              type="button"
              variant={available || ready ? "secondary" : "ghost"}
            >
              <SidebarUpdateIcon controls={controls} />
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
  const controls = useUpdateControls();
  const { data, loadingError, check, download, checking, available, ready, updating } = controls;
  const checkLabel = panelLabel(controls);
  const failure =
    check.error ??
    download.error ??
    data?.error ??
    (loadingError ? "Unable to load updates" : null);
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
            aria-busy={download.busy || checking || updating}
            disabled={disabled || download.busy || checking || updating}
            onClick={() => (available || ready ? void download.download() : check.check())}
            size="sm"
            type="button"
            variant={available || ready ? "default" : "outline"}
          >
            <PanelUpdateIcon controls={controls} />
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

function useUpdateControls() {
  const { data: live, error: loadingError } = useQuery(api.updates.get);
  const data = live && "status" in live ? live : undefined;
  const check = useUpdateCheck();
  const download = useUpdateAction(data);
  const checking = check.busy || data?.status === "checking";
  const available = data?.status === "available";
  const ready = data?.status === "ready";
  const updating = data?.status === "downloading" || data?.status === "restarting";
  const downloading = data?.status === "downloading" || (download.busy && !ready && !updating);
  const activate = () => {
    if (!data || checking || download.busy || updating) {
      return;
    }
    if (available || ready) {
      void download.download();
    } else {
      check.check();
    }
  };
  return {
    activate,
    available,
    check,
    checking,
    data,
    download,
    downloading,
    loadingError,
    ready,
    updating,
  };
}

type UpdateControls = ReturnType<typeof useUpdateControls>;
function sidebarLabel({ data, checking, available, ready, updating, download }: UpdateControls) {
  let label = "Check for updates";
  if (updating && data) {
    label = statusText(data);
  } else if (download.busy) {
    label = "Starting download…";
  } else if (ready) {
    label = "Restart to Update";
  } else if (checking) {
    label = "Checking for updates…";
  } else if (available && data) {
    label = `Update ${data.latestVersion} ready to download`;
  }
  return label;
}
function panelLabel({ data, checking, available, ready, download }: UpdateControls) {
  let checkLabel = "Check for Updates";
  if (data?.status === "restarting") {
    checkLabel = "Restarting…";
  } else if (download.busy || data?.status === "downloading") {
    checkLabel = "Downloading…";
  } else if (ready) {
    checkLabel = "Restart to Update";
  } else if (available && data) {
    checkLabel = data.automatic ? "Download Update" : "Download";
  } else if (checking) {
    checkLabel = "Checking…";
  } else if (data?.status === "current") {
    checkLabel = "Up to Date";
  }
  return checkLabel;
}

function SidebarUpdateIcon({ controls }: { controls: UpdateControls }) {
  const { data, download, downloading, updating, available, checking } = controls;
  return downloading ? (
    <UpdateDownloadIcon progress={data?.status === "downloading" ? data.progress : null} sidebar />
  ) : updating || download.busy ? (
    <LoaderCircleIcon className="motion-safe:animate-spin" />
  ) : available && !checking ? (
    <span className="relative flex">
      <DownloadIcon aria-hidden="true" />
      <span
        aria-hidden="true"
        className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-secondary"
      />
    </span>
  ) : (
    <RefreshCwIcon className={checking ? "motion-safe:animate-spin" : undefined} />
  );
}
function PanelUpdateIcon({ controls }: { controls: UpdateControls }) {
  const { data, download, downloading, updating, available, checking } = controls;
  return downloading ? (
    <UpdateDownloadIcon progress={data?.status === "downloading" ? data.progress : null} />
  ) : updating || download.busy ? (
    <LoaderCircleIcon className="motion-safe:animate-spin" data-icon="inline-start" />
  ) : available ? (
    <DownloadIcon data-icon="inline-start" />
  ) : (
    <RefreshCwIcon
      className={checking ? "motion-safe:animate-spin" : undefined}
      data-icon="inline-start"
    />
  );
}

function UpdateDownloadIcon({
  progress,
  sidebar = false,
}: {
  progress: number | null;
  sidebar?: boolean;
}) {
  const value = progress === null ? null : Math.min(100, Math.max(0, progress));
  return (
    <span
      aria-hidden="true"
      className="update-download-icon"
      data-icon="inline-start"
      data-indeterminate={value === null}
      data-sidebar={sidebar}
    >
      <span className="update-download-ring">
        <svg aria-hidden="true" className="size-full" viewBox="0 0 32 32">
          <circle className="update-download-track" cx="16" cy="16" r="14" />
          <circle
            className="update-download-value"
            cx="16"
            cy="16"
            pathLength="100"
            r="14"
            strokeDasharray="100"
            strokeDashoffset={100 - (value ?? 25)}
            transform="rotate(-90 16 16)"
          />
        </svg>
      </span>
      <DownloadIcon />
    </span>
  );
}
