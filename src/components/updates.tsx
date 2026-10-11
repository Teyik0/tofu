import { useMutation, useQuery } from "@teyik0/furin/client";
import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useAsyncAction } from "../hooks/use-async-action";
import { api } from "../lib/client";
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
        } finally {
          await feedback;
        }
      }),
    error,
  };
}

export function SidebarUpdateAction() {
  const controls = useUpdateControls();
  const { data, loadingError, check, download, checking, available, ready, updating, activate } =
    controls;
  const label = sidebarLabel(controls);
  const error = download.error ?? check.error ?? data?.error;
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
  return { activate, available, check, checking, data, download, loadingError, ready, updating };
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
  const { download, updating, available, checking } = controls;
  return download.busy || updating ? (
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
  const { download, updating, available, checking } = controls;
  return updating || download.busy ? (
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
