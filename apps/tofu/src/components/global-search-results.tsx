import { Autocomplete } from "@base-ui/react/autocomplete";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import { sourceNames } from "@tofu/ui/automation-fields";
import { Badge } from "@tofu/ui/badge";
import { Button } from "@tofu/ui/button";
import { Field, FieldLabel } from "@tofu/ui/field";
import { bytes, percent, torrentStatusLabel } from "@tofu/ui/format";
import { OptionSelect } from "@tofu/ui/option-select";
import { ArrowUpRightIcon, DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { StatusGlyph } from "./status-glyph";
import type { GlobalSearchProps, useGlobalSearch } from "./use-global-search";

export function GlobalSearchResults({ model }: { model: ReturnType<typeof useGlobalSearch> }) {
  const { query, busy, data, localItems, releaseItems, currentReview, choose } = model;
  return (
    <Autocomplete.List aria-label="Search results" className="global-search-results">
      {localItems.length > 0 && (
        <Autocomplete.Group items={localItems}>
          <Autocomplete.GroupLabel className="global-search-group-heading">
            {query ? "My torrents" : "Active torrents"}
            <span>All threads · {localItems.length}</span>
          </Autocomplete.GroupLabel>
          {localItems.map(
            (item) =>
              item.kind === "torrent" && (
                <Autocomplete.Item
                  className="global-search-result"
                  disabled={busy}
                  key={item.torrent.id}
                  onClick={() => choose(item)}
                  value={item}
                >
                  <StatusGlyph
                    progress={item.torrent.progress}
                    size={32}
                    status={item.torrent.status}
                  />
                  <div className="global-search-result-copy">
                    <strong>{item.torrent.name}</strong>
                    <span>
                      {data.destinations.find((thread) => thread.id === item.torrent.destinationId)
                        ?.name ?? "Unknown thread"}{" "}
                      · {torrentStatusLabel(item.torrent)} · {percent(item.torrent.progress)}
                    </span>
                  </div>
                  <span className="global-search-result-action">
                    Open <ArrowUpRightIcon />
                  </span>
                </Autocomplete.Item>
              )
          )}
        </Autocomplete.Group>
      )}
      {releaseItems.length > 0 && (
        <Autocomplete.Group items={releaseItems}>
          <Autocomplete.GroupLabel className="global-search-group-heading">
            Sources<span>{releaseItems.length} releases</span>
          </Autocomplete.GroupLabel>
          {releaseItems.map((item) => {
            if (item.kind !== "release") {
              return null;
            }
            const [first] = item.group.releases;
            if (!first) {
              return null;
            }
            const duplicate = data.torrents.find(
              (torrent) => torrent.id.toLowerCase() === item.group.key
            );
            return (
              <Autocomplete.Item
                className="global-search-result"
                data-reviewed={currentReview?.key === item.group.key || undefined}
                disabled={busy}
                key={item.group.key}
                onClick={() => choose(item)}
                value={item}
              >
                <span className="global-search-release-icon">
                  <DownloadIcon />
                </span>
                <div className="global-search-result-copy">
                  <strong>{first.title}</strong>
                  <span>
                    {[
                      ...new Set(item.group.releases.map((entry) => sourceNames[entry.sourceId])),
                    ].join(" / ")}{" "}
                    · {first.language ?? "—"} · {bytes(first.size)} · {first.seeders ?? "—"} seeds
                  </span>
                </div>
                <span className="global-search-result-action">
                  {duplicate
                    ? `Already in ${data.destinations.find((thread) => thread.id === duplicate.destinationId)?.name ?? "a thread"}`
                    : "Review"}
                </span>
              </Autocomplete.Item>
            );
          })}
        </Autocomplete.Group>
      )}
    </Autocomplete.List>
  );
}

export function GlobalSearchSourceStatus({
  model,
  close,
}: Pick<GlobalSearchProps, "close"> & { model: ReturnType<typeof useGlobalSearch> }) {
  const { router, query, busy, automation, pluginError, sourceIds, sources, retry, loading } =
    model;
  return (
    <div aria-live="polite" className="global-search-source-status">
      {automation || pluginError ? (
        pluginError ? (
          <Alert>
            <AlertDescription>Unable to load sources. Reopen search to retry.</AlertDescription>
          </Alert>
        ) : sourceIds.length ? null : (
          <span>
            Enable a source in{" "}
            <Button
              onClick={() => {
                close();
                void router.navigate({ to: "/plugins/sources" });
              }}
              size="sm"
              variant="link"
            >
              Plugins
            </Button>{" "}
            to search for releases.
          </span>
        )
      ) : (
        <span>Loading sources…</span>
      )}
      {sourceIds.length > 0 && query.trim().length < 2 && (
        <span>
          Type at least two characters to search{" "}
          {sourceIds.map((id) => sourceNames[id]).join(" and ")}.
        </span>
      )}
      {sources.map((source) => (
        <div key={source.sourceId}>
          <Badge variant="outline">
            {!!source.loading && <LoaderCircleIcon className="animate-spin" />}
            {sourceNames[source.sourceId]}
            {source.sourceId === "tsundere" ? " · Recent releases" : ""} ·{" "}
            {source.loading
              ? "Searching…"
              : source.error
                ? "Unavailable"
                : `${source.releases.length} results`}
          </Badge>
          {!!source.error && (
            <Alert>
              <AlertDescription>
                {source.error}{" "}
                <Button disabled={loading || busy} onClick={retry} size="sm" variant="link">
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!!source.warning && <p>{source.warning}</p>}
        </div>
      ))}
    </div>
  );
}

export function GlobalSearchReview({ model }: { model: ReturnType<typeof useGlobalSearch> }) {
  const { setDestinationId, busy, data, destination, release, existing, openTorrent, download } =
    model;
  if (!release) {
    return null;
  }
  return (
    <div className="global-search-review">
      <div className="global-search-review-title">
        <strong>{release.title}</strong>
        <span>
          {release.resolution ?? "—"} · {release.language ?? "—"} · {bytes(release.size)} ·{" "}
          {release.seeders ?? "—"} seeds
        </span>
      </div>
      {existing ? (
        <Button disabled={busy} onClick={() => void openTorrent(existing)}>
          <ArrowUpRightIcon data-icon="inline-start" />
          Open existing torrent
        </Button>
      ) : (
        <div className="global-search-download">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="global-search-destination">Download to</FieldLabel>
            <OptionSelect
              disabled={busy}
              id="global-search-destination"
              onValueChange={setDestinationId}
              options={data.destinations.map((thread) => ({
                label: thread.name,
                value: thread.id,
              }))}
              value={destination?.id ?? ""}
            />
          </Field>
          <Button disabled={busy || !destination} onClick={() => void download()}>
            {busy ? (
              <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
            ) : (
              <DownloadIcon data-icon="inline-start" />
            )}
            {busy ? "Adding…" : "Download"}
          </Button>
        </div>
      )}
      {destination && !existing && (
        <span className="global-search-destination-path">{destination.downloadPath}</span>
      )}
    </div>
  );
}
