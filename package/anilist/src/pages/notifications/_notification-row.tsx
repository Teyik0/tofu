import type { LibraryTorrent, LiveState } from "@tofu/plugins/library-state";
import { BellIcon, CheckCheckIcon, DownloadIcon, ExternalLinkIcon, ZapIcon } from "lucide-react";
import { useRef } from "react";
import type { AutomationRule, AutomationState } from "../../../../plugins/src/automation-model";
import { ActionTooltip } from "../../../../ui/src/action-tooltip";
import { date, relative, statusLabels } from "../../../../ui/src/format";
import { Button } from "../../../../ui/src/ui/button";
import type { AniListNotification } from "../../server/notifications";
import type { AniListEntry, AniListMedia } from "../../server/types";
import { NotificationAutomation } from "./_notification-automation";

const automationLabels: Record<AutomationRule["status"], string> = {
  active: "Automated",
  error: "Automation error",
  paused: "Paused",
  running: "Automated",
  "source-disabled": "Source disabled",
};

export function NotificationRow({
  notification,
  now,
  openEpisode,
  torrents,
  entry,
  rule,
  automation,
  dashboard,
  expanded,
  toggleAutomation,
}: {
  notification: AniListNotification;
  now: number;
  openEpisode: (notification: AniListNotification) => void;
  torrents: LibraryTorrent[];
  entry: AniListMedia | AniListEntry | null;
  rule: AutomationRule | undefined;
  automation: AutomationState;
  dashboard: LiveState | null;
  expanded: boolean;
  toggleAutomation: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const active = rule?.enabled === true;
  const automationLabel = rule ? automationLabels[rule.status] : null;
  return (
    <article className="notification-card" data-automation-open={expanded}>
      <div className="notification-row">
        <div aria-hidden="true" className="notification-cover">
          {notification.image ? (
            <img alt="" height={76} loading="lazy" src={notification.image} width={55} />
          ) : (
            <BellIcon />
          )}
        </div>
        <NotificationCopy dashboard={dashboard} notification={notification} now={now} rule={rule} />
        <div className="notification-row-actions">
          {notification.anime && notification.episode !== null ? (
            <NotificationDownload
              notification={notification}
              openEpisode={openEpisode}
              torrents={torrents}
            />
          ) : (
            <Button
              aria-label={`View ${notification.title} on AniList`}
              render={<a href={notification.url} rel="noreferrer" target="_blank" />}
              size="icon"
              variant="ghost"
            >
              <ExternalLinkIcon />
            </Button>
          )}
          {entry && dashboard ? (
            <ActionTooltip>
              <Button
                aria-controls={`notification-automation-${notification.id}`}
                aria-expanded={expanded}
                aria-label={`${rule ? "Edit" : "Set up"} automation for ${entry.title}`}
                onClick={toggleAutomation}
                ref={trigger}
                size={automationLabel ? "sm" : "icon"}
                variant={active || expanded ? "secondary" : "outline"}
              >
                <ZapIcon data-icon={automationLabel ? "inline-start" : undefined} />
                {automationLabel}
              </Button>
            </ActionTooltip>
          ) : null}
        </div>
      </div>
      {expanded && entry && dashboard ? (
        <NotificationAutomation
          automation={automation}
          close={() => {
            toggleAutomation();
            trigger.current?.focus();
          }}
          dashboard={dashboard}
          entry={entry}
          id={`notification-automation-${notification.id}`}
          rule={rule}
        />
      ) : null}
    </article>
  );
}

function NotificationCopy({
  notification,
  now,
  rule,
  dashboard,
}: {
  notification: AniListNotification;
  now: number;
  rule: AutomationRule | undefined;
  dashboard: LiveState | null;
}) {
  const active = rule?.enabled === true;
  return (
    <div className="notification-copy">
      <div className="notification-meta">
        <span>
          {notification.episode === null
            ? notification.type?.replaceAll("_", " ")
            : `EPISODE ${String(notification.episode).padStart(2, "0")}`}
        </span>
        <time
          dateTime={
            notification.createdAt
              ? new Date(notification.createdAt * 1000).toISOString()
              : undefined
          }
          title={date(notification.createdAt === null ? null : notification.createdAt * 1000)}
        >
          {relative(notification.createdAt === null ? null : notification.createdAt * 1000, now)}
        </time>
      </div>
      <a className="notification-title" href={notification.url} rel="noreferrer" target="_blank">
        {notification.title}
      </a>
      <p>{notification.text}</p>
      {notification.reason ? <p>{notification.reason}</p> : null}
      {active && rule ? (
        <p className="notification-automation-summary">
          <ZapIcon aria-hidden="true" />
          {dashboard?.host?.destinations.find(
            (destination) => destination.id === rule.destinationId
          )?.name ?? "Downloads"}{" "}
          · {rule.resolutions.join(" → ") || "Any quality"} ·{" "}
          {rule.languages.join(" → ") || "Any language"}
        </p>
      ) : null}
    </div>
  );
}

function NotificationDownload({
  notification,
  torrents,
  openEpisode,
}: {
  notification: AniListNotification;
  torrents: LibraryTorrent[];
  openEpisode: (notification: AniListNotification) => void;
}) {
  const matches = notification.sources.flatMap((source) => {
    const torrent = torrents.find((item) => item.id === source.torrentId);
    return torrent ? [{ source, torrent }] : [];
  });
  const match =
    matches.find((item) => item.source.status === "playable" && !item.torrent.storageIssue) ??
    matches[0];
  const unavailable =
    match &&
    (match.source.status === "unavailable" ||
      match.torrent.storageIssue ||
      match.torrent.status === "error");
  const downloaded =
    match &&
    !unavailable &&
    match.torrent.status !== "checking" &&
    (match.source.progress === 1 || match.torrent.progress === 1);
  let label = "Download episode";
  if (match) {
    label = statusLabels[match.torrent.status];
    if (downloaded) {
      label = "Downloaded";
    }
    if (unavailable) {
      label = "Files unavailable";
    }
  }
  return (
    <Button
      aria-label={`${match ? "View" : "Download"} episode ${notification.episode} of ${notification.title}`}
      onClick={() => openEpisode(notification)}
      variant={match ? "outline" : "secondary"}
    >
      {downloaded ? (
        <CheckCheckIcon data-icon="inline-start" />
      ) : (
        <DownloadIcon data-icon="inline-start" />
      )}
      {label}
    </Button>
  );
}
