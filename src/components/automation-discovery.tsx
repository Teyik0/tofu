import { Form, getDeepError, useField, useForm } from "@formisch/react";
import { useMutation } from "@teyik0/furin/client";
import { LoaderCircleIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import { pick } from "valibot";
import type { DiscoveryResult } from "../api/modules/discovery/model";
import { discoverySchema } from "../api/modules/discovery/model";
import type { PluginState, SourcePluginId } from "../api/modules/plugins/model";
import type { AsyncAction } from "../hooks/use-async-action";
import { useAsyncAction } from "../hooks/use-async-action";
import { api } from "../lib/client";
import { useRefresh } from "../lib/navigation";
import { playSoundCue } from "../lib/sound-cues";
import { request } from "./api";
import { sourceNames } from "./automation-fields";
import { ReleaseLine } from "./automation-inbox";
import {
  type AutomationPanelProps,
  AutomationSectionPanel,
  AutomationThread,
  QuietEmpty,
  SectionHeading,
} from "./automation-section";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
export function AutomationDiscovery({ state, dashboard, target, onTarget }: AutomationPanelProps) {
  const refresh = useRefresh();
  const addRelease = useMutation(api.discover.add.post);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const searchForm = useForm({
    initialInput: { query: "" },
    schema: pick(discoverySchema, ["query"]),
  });
  const searchField = useField(searchForm, { path: ["query"] });
  const search = searchField.input ?? "";
  const setSearch = searchField.onChange;
  const [excludedSources, setExcludedSources] = useState<SourcePluginId[]>([]);
  const excludedSourceIds = new Set(excludedSources);

  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error: serverError, action: run } = useAsyncAction("An error occurred");
  const error = serverError ?? getDeepError(searchForm);
  const action: AsyncAction = (task) => {
    setNotice(null);
    run(task);
  };
  const destination = dashboard.destinations.find((item) => item.id === target);
  const activeSources = state.plugins.filter(
    (plugin): plugin is PluginState & { id: SourcePluginId } =>
      plugin.enabled && (plugin.id === "nyaa" || plugin.id === "tsundere" || plugin.id === "c411")
  );
  const selectedSources = activeSources.filter((plugin) => !excludedSourceIds.has(plugin.id));
  return (
    <AutomationSectionPanel
      error={error}
      notice={notice}
      thread={
        <AutomationThread
          dashboard={dashboard}
          disabled={busy}
          onChange={(value) => {
            setDiscovery(null);
            onTarget(value);
          }}
          target={target}
        />
      }
      value="discover"
    >
      <div className="automation-section">
        <SectionHeading
          description={`Search once across your sources and add a release to ${destination?.name ?? "this thread"}.`}
          title="Discover"
        />
        <Form
          className="discover-form"
          of={searchForm}
          onSubmit={() => {
            action(async () =>
              setDiscovery(
                await request<DiscoveryResult>("/discover", "POST", {
                  query: search,
                  sources: selectedSources.map((plugin) => plugin.id),
                })
              )
            );
          }}
        >
          <Field>
            <FieldLabel className="sr-only" htmlFor="feed-search">
              Keyword search across sources
            </FieldLabel>
            <div className="discover-search">
              <InputGroup>
                <InputGroupInput
                  disabled={busy || !activeSources.length}
                  {...searchField.props}
                  aria-invalid={Boolean(searchField.errors)}
                  id="feed-search"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="A title, keywords…"
                  required
                  value={search}
                />
                <InputGroupAddon align="inline-start">
                  <SearchIcon />
                </InputGroupAddon>
              </InputGroup>
              <Button disabled={busy || !selectedSources.length || !search.trim()} type="submit">
                {busy ? (
                  <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
                ) : null}
                {busy ? "Searching…" : "Search"}
              </Button>
            </div>
          </Field>
          <fieldset className="discover-sources" disabled={busy}>
            <legend>Sources</legend>
            {activeSources.length ? (
              <>
                <Field orientation="horizontal">
                  <Checkbox
                    checked={selectedSources.length === activeSources.length}
                    disabled={busy}
                    id="discovery-all-sources"
                    indeterminate={
                      selectedSources.length > 0 && selectedSources.length < activeSources.length
                    }
                    onCheckedChange={(checked) => {
                      setExcludedSources(
                        checked === true ? [] : activeSources.map((plugin) => plugin.id)
                      );
                      setDiscovery(null);
                    }}
                  />
                  <FieldLabel htmlFor="discovery-all-sources">All</FieldLabel>
                </Field>
                {activeSources.map((plugin) => (
                  <Field key={plugin.id} orientation="horizontal">
                    <Checkbox
                      checked={!excludedSourceIds.has(plugin.id)}
                      disabled={busy}
                      id={`discovery-source-${plugin.id}`}
                      onCheckedChange={(checked) => {
                        setExcludedSources((previous) =>
                          checked === true
                            ? previous.filter((id) => id !== plugin.id)
                            : [...previous, plugin.id]
                        );
                        setDiscovery(null);
                      }}
                    />
                    <FieldLabel htmlFor={`discovery-source-${plugin.id}`}>{plugin.name}</FieldLabel>
                  </Field>
                ))}
              </>
            ) : (
              <span className="automation-muted">Enable a source in Plugins to search.</span>
            )}
          </fieldset>
          <p className="automation-muted">Keywords are searched as typed.</p>
        </Form>
        {discovery?.search?.warning ? (
          <Alert>
            <AlertDescription>{discovery.search.warning}</AlertDescription>
          </Alert>
        ) : null}
        {discovery?.search?.title ? (
          <div aria-live="polite" className="discovery-summary">
            <strong>{discovery.search.title}</strong>
            {discovery.search.season === null ? null : (
              <Badge variant="secondary">Season {discovery.search.season}</Badge>
            )}
            {discovery.search.episode === null ? null : (
              <Badge variant="secondary">Episode {discovery.search.episode}</Badge>
            )}
            <span>
              {discovery.releases.length} result
              {discovery.releases.length === 1 ? "" : "s"}
            </span>
          </div>
        ) : null}
        {discovery?.errors.map((item) => (
          <Alert key={item.sourceId}>
            <AlertDescription>
              {sourceNames[item.sourceId]}: {item.message}
            </AlertDescription>
          </Alert>
        ))}
        {discovery?.releases.length ? (
          <div className="release-list">
            {discovery.releases.map((release) => (
              <div className="preview-row" key={`${release.sourceId}:${release.id}`}>
                <ReleaseLine release={release} />
                <Button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await addRelease.mutateAsync({
                        destinationId: target,
                        id: release.id,
                        paused: false,
                        sourceId: release.sourceId,
                      });
                      playSoundCue("added");
                      await refresh();
                      setNotice(`Added to ${destination?.name ?? "the thread"}.`);
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  <PlusIcon data-icon="inline-start" />
                  Add
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <QuietEmpty
            description={
              discovery
                ? "Try another title or season, or select more sources."
                : "Search for a series, a season, or a single episode."
            }
            icon={SearchIcon}
            title={discovery ? "No releases found" : "One search, every source"}
          />
        )}
      </div>
    </AutomationSectionPanel>
  );
}
