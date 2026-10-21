import { useQuery } from "@teyik0/furin/client";
import { useAtomValue } from "jotai";
import { AlertCircleIcon, LayersIcon, PlusIcon, ZapIcon } from "lucide-react";
import { version } from "../../package.json";
import { api } from "../lib/client";
import { dashboardAtom, sessionAtom } from "../state/workspace";
import type { LibraryState, LibraryTorrentDetail } from "../types";
import { ActionTooltip } from "./action-tooltip";
import type { AutomationSection } from "./automation-center";
import { DestinationIcon } from "./destination-icon";
import { Detail } from "./detail";
import { speed } from "./format";
import { Icon } from "./icon";
import { SidebarToggle } from "./sidebar-toggle";
import { TorrentLibraryList, TorrentLibraryToolbar } from "./torrent-library-views";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import { useTorrentLibrary } from "./use-torrent-library";

export function App({
  dashboard,
  activeDestination,
  detail,
  requested,
}: {
  dashboard: LibraryState;
  activeDestination: string | null;
  /** Detail read by the page loader for its selection. */
  detail: LibraryTorrentDetail | null;
  /** Torrent requested by the `torrent` search param. */
  requested: string | undefined;
}) {
  const data = useAtomValue(dashboardAtom) ?? { ...dashboard, detailHost: null, host: null };
  const capabilities = useAtomValue(sessionAtom)?.capabilities;
  const model = useTorrentLibrary({ activeDestination, dashboard: data, requested });
  const { setModal, pending, error, setError, selectedId, destination, add, act } = model;
  const folder = data.host?.destinations.find((item) => item.id === destination?.id)?.downloadPath;
  // The live stream follows the same selection; the loader detail covers the time until it does.
  const selectedDetail = [data.detail, detail].find((item) => item && item.id === selectedId);
  const summary = data.torrents.find((torrent) => torrent.id === selectedId);
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
            <span className="topbar-path" title={folder ?? data.server.name}>
              {folder ?? (destination ? `On ${data.server.name}` : "Every destination")}
            </span>
          </div>
        </div>
        <div className="library-actions">
          {capabilities?.administer ? (
            <AutomationsButton
              open={(section) =>
                setModal({
                  destinationId: activeDestination ?? "default",
                  section,
                  type: "automation",
                })
              }
            />
          ) : null}
          {capabilities?.manage ? (
            <Button className="add-button" onClick={add}>
              <PlusIcon data-icon="inline-start" />
              Add a torrent
            </Button>
          ) : null}
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
      <div className="library-workspace">
        <section aria-label="Torrent list" className="library">
          <TorrentLibraryToolbar model={model} />
          <TorrentLibraryList model={model} />
        </section>
        {selectedId === null ? (
          <section aria-label="Torrent details" className="detail-pane">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No torrent selected</EmptyTitle>
                <EmptyDescription>
                  Select a torrent to inspect its files and transfer activity.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </section>
        ) : selectedDetail && summary ? (
          <Detail
            act={act}
            busy={pending.has(selectedId)}
            data={data}
            open={setModal}
            torrent={{ ...selectedDetail, ...summary }}
          />
        ) : (
          <DetailLoading />
        )}
      </div>
      <footer className="status-bar">
        {data.host ? (
          <span className="status-port">
            Port <b>{data.host.session.port}</b>
          </span>
        ) : (
          <span className="status-port">{data.server.name}</span>
        )}
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
          Tofu {version} <span>·</span> {capabilities?.hostNative ? "Native app" : "Web workspace"}
        </span>
      </footer>
    </div>
  );
}

/** Opens the automation Inbox directly when releases are waiting for a decision. */
function AutomationsButton({ open }: { open: (section: AutomationSection) => void }) {
  const { data } = useQuery(api.automation.get.live());
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
