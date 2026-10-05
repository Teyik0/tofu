import { useQuery } from "@teyik0/furin/client";
import {
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { api } from "../client";
import type { AniListEntry, AniListState, AutomationState } from "../types";
import { ActionTooltip } from "./action-tooltip";
import { AniListCover } from "./anilist-cover";
import { AniListEpisodeModal } from "./anilist-episode-modal";
import { AniListIcon } from "./anilist-icon";
import { AniListPanel } from "./anilist-panel";
import { aniListStatusLabel, aniListStatusLabels } from "./anilist-status";
import { request } from "./api";
import { useDashboard } from "./app-shell";
import { RuleFields } from "./automation-center";
import { OptionSelect } from "./option-select";
import { SidebarToggle } from "./sidebar-toggle";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Field, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Skeleton } from "./ui/skeleton";

const sortOptions = [
  { label: "Title", value: "title" },
  { label: "Episode progress", value: "progress" },
] satisfies { label: string; value: "title" | "progress" }[];

function AnimeCard({ entry, onOpen }: { entry: AniListEntry; onOpen: () => void }) {
  return (
    <button
      aria-label={`View episodes for ${entry.title}`}
      className="anime-card"
      onClick={onOpen}
      type="button"
    >
      <div className="anime-card-cover">
        <AniListCover src={entry.coverImage} />
        <div className="anime-card-overlay">
          <Badge variant="secondary">{aniListStatusLabel(entry.status)}</Badge>
          {entry.automationId ? <ZapIcon aria-label="Custom automation" /> : null}
        </div>
        <span className="anime-card-progress">
          {entry.progress} / {entry.episodes ?? "—"} watched
        </span>
      </div>
      <strong>{entry.title}</strong>
      <span className="anime-card-meta">
        {entry.format?.replaceAll("_", " ") ?? "—"} · {entry.seasonYear ?? "—"}
      </span>
    </button>
  );
}

export function AniListLibrary() {
  const { data: dashboard } = useDashboard();
  const { data: live, error: loadingError } = useQuery(api.api.anilist.get);
  const { data: liveAutomation } = useQuery(api.api.automation.get);
  const [saved, setSaved] = useState<AniListState | null>(null);
  const [automation, setAutomation] = useState<AutomationState | null>(null);
  const state = saved ?? (live && "entries" in live ? live : null);
  const automationState =
    automation ?? (liveAutomation && "plugins" in liveAutomation ? liveAutomation : null);
  const plugin = automationState?.plugins.find((item) => item.id === "anilist");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"title" | "progress">("title");
  const [selected, setSelected] = useState<number | null>(null);
  const [settings, setSettings] = useState(false);
  const [target, setTarget] = useState("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadAutomation = async () => {
    setAutomation(await request<AutomationState>("/automation", "GET", undefined));
  };
  const action = (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void task()
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Unable to update AniList")
      )
      .finally(() => setBusy(false));
  };
  const canLoad = Boolean(plugin?.enabled && (plugin.hasApiKey || state?.userName));
  const refreshConnection = useEffectEvent(async () => {
    try {
      setSaved(await request<AniListState>("/anilist", "GET", undefined));
      await reloadAutomation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to check AniList connection");
    }
  });
  useEffect(() => {
    if (!state?.authorizationPending || settings) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      await refreshConnection();
      if (active) {
        timer = setTimeout(check, 1000);
      }
    };
    timer = setTimeout(check, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [state?.authorizationPending, settings]);
  useEffect(() => {
    if (!canLoad) {
      return;
    }
    let active = true;
    setBusy(true);
    void request<AniListState>("/anilist/list", "POST", {})
      .then((value) => {
        if (active) {
          setSaved(value);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to load AniList");
        }
      })
      .finally(() => {
        if (active) {
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [canLoad]);
  const entries =
    state?.entries
      .filter(
        (entry) =>
          state.visibleStatuses.includes(entry.status) &&
          entry.aliases.some((title) =>
            title.toLocaleLowerCase("en-US").includes(search.toLocaleLowerCase("en-US"))
          )
      )
      .toSorted((a, b) =>
        sort === "progress"
          ? b.progress - a.progress || a.title.localeCompare(b.title, "en-US")
          : a.title.localeCompare(b.title, "en-US")
      ) ?? [];
  const selectedEntry = state?.entries.find((entry) => entry.mediaId === selected);
  return (
    <main className="anilist-library">
      <header className="library-topbar anilist-page-header">
        <div className="library-title anilist-page-heading">
          <SidebarToggle className="mobile-sidebar-toggle" />
          <AniListIcon />
          <h1>AniList</h1>
        </div>
        <div className="anilist-header-actions">
          <span className="anilist-account">{state?.connectedUser ?? state?.userName ?? ""}</span>
          <ActionTooltip>
            <Button
              aria-label="Sync list"
              disabled={busy || !canLoad}
              onClick={() =>
                action(async () => {
                  setSaved(await request<AniListState>("/anilist/list", "POST", {}));
                  await reloadAutomation();
                })
              }
              size="icon"
              variant="outline"
            >
              <RefreshCwIcon className={busy ? "motion-safe:animate-spin" : undefined} />
            </Button>
          </ActionTooltip>
          <ActionTooltip>
            <Button
              aria-label="AniList settings"
              onClick={() => setSettings(true)}
              size="icon"
              variant="outline"
            >
              <SettingsIcon />
            </Button>
          </ActionTooltip>
        </div>
      </header>
      <div className="anilist-page-body">
        <div className="anilist-toolbar">
          <InputGroup className="anilist-search">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search your anime"
              id="anime-search"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by title or alias"
              value={search}
            />
          </InputGroup>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button className="anilist-status-filter" variant="outline">
                  <SlidersHorizontalIcon data-icon="inline-start" />
                  Statuses
                  <span className="anilist-status-count">{state?.visibleStatuses.length ?? 2}</span>
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Show anime from these lists</DropdownMenuLabel>
                {aniListStatusLabels.map(({ value, label }) => (
                  <DropdownMenuCheckboxItem
                    checked={
                      state?.visibleStatuses.includes(value) ??
                      (value === "CURRENT" || value === "PLANNING")
                    }
                    disabled={busy || !state}
                    key={value}
                    onCheckedChange={(checked) => {
                      if (state) {
                        action(async () => {
                          setSaved(
                            await request<AniListState>("/anilist/preferences", "PUT", {
                              visibleStatuses: checked
                                ? [...state.visibleStatuses, value]
                                : state.visibleStatuses.filter((item) => item !== value),
                            })
                          );
                        });
                      }
                    }}
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Select
            items={sortOptions}
            onValueChange={(value) => {
              if (value !== null) {
                setSort(value);
              }
            }}
            value={sort}
          >
            <SelectTrigger aria-label="Sort anime" className="anilist-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false}>
              <SelectGroup>
                {sortOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="anilist-active-filters">
          {state?.visibleStatuses.map((status) => (
            <Badge key={status} variant="secondary">
              {aniListStatusLabel(status)}
            </Badge>
          ))}
          <span className="anilist-title-count">
            {state ? entries.length : "—"} title{entries.length === 1 ? "" : "s"}
          </span>
        </div>
        {error || loadingError ? (
          <Alert>
            <AlertDescription>{error ?? "Unable to load AniList"}</AlertDescription>
          </Alert>
        ) : null}
        {!state || (busy && !state.entries.length) ? (
          <div aria-label="Loading anime" className="anime-grid" role="status">
            {["first", "second", "third", "fourth", "fifth"].map((placeholder) => (
              <Skeleton className="anime-cover-skeleton" key={placeholder} />
            ))}
          </div>
        ) : entries.length ? (
          <div className="anime-grid">
            {entries.map((entry) => (
              <AnimeCard
                entry={entry}
                key={entry.mediaId}
                onOpen={() => setSelected(entry.mediaId)}
              />
            ))}
          </div>
        ) : (
          <Empty className="anilist-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AniListIcon />
              </EmptyMedia>
              <EmptyTitle>
                {state.entries.length
                  ? "No anime match your filters"
                  : "Bring your AniList into Tofu"}
              </EmptyTitle>
              <EmptyDescription>
                {state.entries.length
                  ? "Try another title or choose more visible statuses."
                  : "Connect your account or enter a public username in Settings. Watching and Plan to Watch appear by default."}
              </EmptyDescription>
            </EmptyHeader>
            {state.entries.length ? null : (
              <Button onClick={() => setSettings(true)}>Connect AniList</Button>
            )}
          </Empty>
        )}
      </div>
      {selectedEntry && automationState ? (
        <AniListEpisodeModal
          automation={automationState}
          close={() => setSelected(null)}
          entry={selectedEntry}
          key={selectedEntry.mediaId}
          onState={setSaved}
          reloadAutomation={reloadAutomation}
        />
      ) : null}
      {settings && automationState ? (
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setSettings(false);
              action(async () => {
                setSaved(await request<AniListState>("/anilist", "GET", undefined));
                await reloadAutomation();
              });
            }
          }}
          open
        >
          <DialogContent className="automation-dialog">
            <DialogHeader>
              <DialogTitle>AniList settings</DialogTitle>
              <DialogDescription>
                Connect your account and set default tracking preferences. Each anime can override
                them.
              </DialogDescription>
            </DialogHeader>
            {error ? (
              <Alert>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <AniListPanel
              action={action}
              automations={automationState.automations}
              busy={busy}
              destinationField={
                <Field>
                  <FieldLabel htmlFor="anime-default-destination">Default destination</FieldLabel>
                  <OptionSelect
                    disabled={busy}
                    id="anime-default-destination"
                    onValueChange={setTarget}
                    options={dashboard.destinations.map((destination) => ({
                      label: destination.name,
                      value: destination.id,
                    }))}
                    value={target}
                  />
                </Field>
              }
              destinations={dashboard.destinations}
              key={target}
              onRefresh={setSaved}
              plugin={plugin}
              reloadPlugins={reloadAutomation}
              renderTemplate={(draft, onChange) => <RuleFields draft={draft} onChange={onChange} />}
              target={target}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  );
}
