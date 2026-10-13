import { Await, useQuery } from "@teyik0/furin/client";
import { useSetAtom } from "jotai";
import { AlertCircleIcon, LayersIcon, PlusIcon, ZapIcon } from "lucide-react";
import { Suspense, useMemo } from "react";
import { version } from "../../package.json";
import { api } from "../lib/client";
import { modalAtom } from "../state/workspace";
import type { DashboardState, TorrentDetail } from "../types";
import { ActionTooltip } from "./action-tooltip";
import type { AutomationSection } from "./automation-center";
import { DestinationIcon } from "./destination-icon";
import { Detail } from "./detail";
import { speed } from "./format";
import { Icon } from "./icon";
import { SidebarToggle } from "./sidebar-toggle";
import { TorrentLibraryTable, TorrentLibraryToolbar } from "./torrent-library-views";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { useTorrentLibrary } from "./use-torrent-library";

export function App({
  dashboard: data,
  activeDestination,
  initialDetail,
  initialTorrentId,
}: {
  dashboard: DashboardState;
  activeDestination: string | null;
  initialDetail: Promise<TorrentDetail | null>;
  initialTorrentId: string | null;
}) {
  const model = useTorrentLibrary({ activeDestination, dashboard: data, initialDetail });
  const { setModal, pending, error, setError, torrents, selectedId, destination, add, act } = model;
  return (
    <div className="main">
      <header className="library-topbar">
        <div className="library-title">
          <SidebarToggle className="mobile-sidebar-toggle" />
          <span aria-hidden="true" className="library-glyph">
            {destination ? <DestinationIcon name={destination.icon} /> : <LayersIcon />}
          </span>
          <div className="library-heading">
            <h1>{destination?.name ?? "All torrents"}</h1>
            <span className="topbar-path" title={destination?.downloadPath ?? "Every destination"}>
              {destination?.downloadPath ?? "Every destination"}
            </span>
          </div>
        </div>
        <div className="library-actions">
          <AutomationsButton
            open={(section) =>
              setModal({
                destinationId: activeDestination ?? "default",
                section,
                type: "automation",
              })
            }
          />
          <Button className="add-button" onClick={add}>
            <PlusIcon data-icon="inline-start" />
            Add a torrent
          </Button>
        </div>
      </header>
      {error !== null && (
        <Alert className="connection-banner">
          <AlertCircleIcon />
          <AlertDescription>
            {error}
            <ActionTooltip>
              <Button
                aria-label="Dismiss error"
                onClick={() => setError(null)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Icon name="x" />
              </Button>
            </ActionTooltip>
          </AlertDescription>
        </Alert>
      )}
      <section aria-label="Torrent list" className="library">
        <TorrentLibraryToolbar model={model} />
        <TorrentLibraryTable model={model} />
      </section>
      {selectedId && torrents.some((torrent) => torrent.id === selectedId) && (
        <Suspense fallback={<DetailLoading />}>
          <SelectedDetail
            act={act}
            busy={pending.has(selectedId)}
            data={data}
            id={selectedId}
            initial={selectedId === initialTorrentId ? initialDetail : null}
          />
        </Suspense>
      )}
      <footer className="status-bar">
        <span className="status-port">
          Port <b>{data.session.port}</b>
        </span>
        <span className="status-throughput">
          <span data-direction="down">
            <Icon name="download" size={12} />
            {speed(data.session.downloadSpeed)}
          </span>
          <span data-direction="up">
            <Icon name="upload" size={12} />
            {speed(data.session.uploadSpeed)}
          </span>
        </span>
        <span className="status-version">
          Tofu {version} <span>·</span>{" "}
          {data.session.mode === "desktop" ? "Native app" : "Web workspace"}
        </span>
      </footer>
    </div>
  );
}

/** Opens the automation Inbox directly when releases are waiting for a decision. */
function AutomationsButton({ open }: { open: (section: AutomationSection) => void }) {
  const { data } = useQuery(api.automation.get);
  const waiting =
    data && "decisions" in data
      ? data.decisions.filter(
          (decision) => decision.status === "review" || decision.status === "error"
        ).length
      : 0;
  return (
    <ActionTooltip>
      <Button
        aria-describedby={waiting ? "automation-attention" : undefined}
        aria-label="Automations"
        className="automations-button"
        onClick={() => open(waiting ? "inbox" : "rules")}
        size="icon"
        variant="outline"
      >
        <ZapIcon />
        {waiting ? (
          <span aria-hidden="true" className="automations-count">
            {waiting}
          </span>
        ) : null}
        {waiting ? (
          <span className="sr-only" id="automation-attention">
            {waiting} release{waiting === 1 ? "" : "s"} need your decision
          </span>
        ) : null}
      </Button>
    </ActionTooltip>
  );
}

function DetailLoading() {
  return (
    <section aria-busy="true" aria-label="Loading details" className="detail-pane detail-loading">
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-32 w-full" />
    </section>
  );
}

function SelectedDetail({
  data,
  id,
  initial,
  act,
  busy,
}: {
  data: DashboardState;
  id: string;
  initial: Promise<TorrentDetail | null> | null;
  act: (id: string, task: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const open = useSetAtom(modalAtom);
  const { data: live, error } = useQuery(api.torrents({ id }).get);
  const summary = data.torrents.find((item) => item.id === id);
  const cached = live && "id" in live ? live : null;
  const torrent = useMemo(
    () => (cached && summary ? { ...cached, ...summary } : null),
    [cached, summary]
  );
  if (error || (live && !("id" in live))) {
    return (
      <Alert className="connection-banner">
        <AlertCircleIcon />
        <AlertDescription>Unable to load details. Retrying on the next update.</AlertDescription>
      </Alert>
    );
  }
  if (torrent) {
    return <Detail act={act} busy={busy} data={data} open={open} torrent={torrent} />;
  }
  return initial ? (
    <Await resolve={initial}>
      {(snapshot) =>
        snapshot && summary ? (
          <Detail
            act={act}
            busy={busy}
            data={data}
            open={open}
            torrent={{ ...snapshot, ...summary }}
          />
        ) : (
          <DetailLoading />
        )
      }
    </Await>
  ) : (
    <DetailLoading />
  );
}
