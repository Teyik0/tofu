import { useQuery } from "@teyik0/furin/client";
import { useRouter } from "@teyik0/furin/link";
import {
  ArrowLeftIcon,
  BrainCircuitIcon,
  CableIcon,
  GlobeIcon,
  PlugIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";
import { api } from "../client";
import type { AutomationState, PluginId, PluginState } from "../types";
import { request } from "./api";
import { useDashboard } from "./app-shell";
import { Logo } from "./icon";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
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
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";
import { SidebarUpdateAction } from "./updates";

type Section = "installed" | "sources" | "intelligence" | "integrations";
type Action = (task: () => Promise<void>) => void;
const sections = [
  { icon: PlugIcon, id: "installed", label: "Installed" },
  { icon: GlobeIcon, id: "sources", label: "Sources" },
  { icon: BrainCircuitIcon, id: "intelligence", label: "Intelligence" },
  { icon: CableIcon, id: "integrations", label: "Integrations" },
] satisfies { id: Section; label: string; icon: typeof PlugIcon }[];
const groups = [
  { id: "sources", label: "Torrent sources", plugins: ["nyaa", "tsundere", "c411"] },
  { id: "intelligence", label: "Release intelligence", plugins: ["jev"] },
  { id: "integrations", label: "Account integrations", plugins: ["anilist"] },
] satisfies { id: Section; label: string; plugins: PluginId[] }[];

function PluginCard({
  plugin,
  busy,
  action,
  reload,
}: {
  plugin: PluginState;
  busy: boolean;
  action: Action;
  reload: () => Promise<void>;
}) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState(String(plugin.dailyLimit));
  const save = (enabled: boolean) =>
    action(async () => {
      await request(`/plugins/${plugin.id}`, "PUT", {
        enabled,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        dailyLimit: Number(limit),
      });
      setKey("");
      await reload();
    });
  const keyed = plugin.id === "jev" || plugin.id === "c411";
  const dirty = key.trim() !== "" || limit !== String(plugin.dailyLimit);
  const formId = `plugin-form-${plugin.id}`;
  return (
    <article aria-label={plugin.name} className="plugin-card plugins-plugin">
      <Field orientation="horizontal">
        <FieldContent>
          <div className="plugins-plugin-title">
            <FieldLabel htmlFor={`plugin-${plugin.id}`}>{plugin.name}</FieldLabel>
            <Badge variant={plugin.enabled ? "secondary" : "outline"}>
              {plugin.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <FieldDescription>{plugin.description}</FieldDescription>
        </FieldContent>
        <Switch
          aria-label={`Enable ${plugin.name}`}
          checked={plugin.enabled}
          disabled={busy}
          id={`plugin-${plugin.id}`}
          onCheckedChange={save}
        />
      </Field>
      {keyed === true && (
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            save(plugin.enabled);
          }}
        >
          <FieldGroup className="plugins-configuration">
            <Field className="plugins-credential" orientation="responsive">
              <FieldContent>
                <FieldLabel htmlFor={`key-${plugin.id}`}>
                  {`${plugin.id === "jev" ? "TypeSafe" : "C411"} API key`}
                </FieldLabel>
                <FieldDescription>
                  {plugin.id === "jev"
                    ? "Without a key: exact name or pattern. Evaluated titles and metadata are sent to TypeSafe."
                    : "Available in C411 → API integrations. The key stays on the server."}
                </FieldDescription>
              </FieldContent>
              <Input
                autoComplete="off"
                disabled={busy}
                id={`key-${plugin.id}`}
                onChange={(event) => setKey(event.target.value)}
                placeholder={plugin.hasApiKey ? "Saved · type to replace" : "Your personal key"}
                type="password"
                value={key}
              />
            </Field>
            {plugin.id === "jev" && (
              <Field className="plugins-limit" orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="jev-daily-limit">Daily call limit</FieldLabel>
                  <FieldDescription>
                    {plugin.callsToday} call{plugin.callsToday === 1 ? "" : "s"} today · cached
                    evaluations are not billed again.
                  </FieldDescription>
                </FieldContent>
                <Input
                  disabled={busy}
                  id="jev-daily-limit"
                  max="100000"
                  min="1"
                  onChange={(event) => setLimit(event.target.value)}
                  required
                  type="number"
                  value={limit}
                />
              </Field>
            )}
          </FieldGroup>
        </form>
      )}
      {plugin.id === "anilist" && (
        <FieldDescription>
          Connect your account from the AniList page. No API key is required.
        </FieldDescription>
      )}
      {plugin.error !== null && (
        <Alert>
          <AlertDescription>{plugin.error}</AlertDescription>
        </Alert>
      )}
      {(plugin.enabled || keyed || plugin.id === "anilist") && (
        <div className="plugins-plugin-actions">
          {plugin.enabled === true && (
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await request(`/plugins/${plugin.id}/test`, "POST", {});
                  await reload();
                })
              }
              size="sm"
              variant="outline"
            >
              Test connection
            </Button>
          )}
          {plugin.id === "anilist" && (
            <Button
              onClick={() => void router.navigate({ to: "/anilist" })}
              size="sm"
              variant="outline"
            >
              Open AniList
            </Button>
          )}
          {plugin.checkedAt !== null && (
            <span className="automation-caption">
              Checked at {new Date(plugin.checkedAt).toLocaleTimeString("en-US")}
            </span>
          )}
          {keyed === true && (
            <Button
              className="plugins-save"
              disabled={busy || !dirty}
              form={formId}
              size="sm"
              type="submit"
            >
              Save
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

export function PluginsPage() {
  const router = useRouter();
  const { settingsBackPath } = useDashboard();
  const { data: live, error: loadingError } = useQuery(api.api.automation.get);
  const [saved, setSaved] = useState<AutomationState | null>(null);
  const state =
    live && "plugins" in live && (!saved || live.updatedAt > saved.updatedAt) ? live : saved;
  const [section, setSection] = useState<Section>("installed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    setSaved(await request<AutomationState>("/automation", "GET", undefined));
  };
  const action: Action = (task) => {
    setBusy(true);
    setError(null);
    void task()
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Unable to update plugins")
      )
      .finally(() => setBusy(false));
  };
  const back = () => {
    if (settingsBackPath.startsWith("/library/destinations/")) {
      void router.navigate({
        params: { id: decodeURIComponent(settingsBackPath.slice("/library/destinations/".length)) },
        resetScroll: false,
        to: "/library/destinations/:id",
      });
    } else {
      void router.navigate({
        resetScroll: false,
        to: settingsBackPath === "/anilist" ? "/anilist" : "/library/all",
      });
    }
  };
  return (
    <div className="settings-page plugins-page">
      <aside className="settings-navigation">
        <div className="settings-brand">
          <Logo />
          <strong>Tofu</strong>
        </div>
        <nav aria-label="Plugin sections">
          {sections.map(({ id, label, icon: Icon }) => (
            <Button
              aria-current={section === id ? "page" : undefined}
              className="settings-nav-item"
              key={id}
              onClick={() => setSection(id)}
              variant={section === id ? "secondary" : "ghost"}
            >
              <Icon data-icon="inline-start" />
              {label}
            </Button>
          ))}
        </nav>
        <div className="settings-footer">
          <Button className="settings-back plugins-back" onClick={back} variant="ghost">
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
          <SidebarUpdateAction />
        </div>
      </aside>
      <main className="settings-main">
        <header className="settings-topbar">
          <h1>
            <span>Plugins</span>
            <span aria-hidden="true">/</span>
            {sections.find((item) => item.id === section)?.label}
          </h1>
          <Button disabled={busy} onClick={() => action(reload)} variant="ghost">
            <RefreshCwIcon className={busy ? "animate-spin" : undefined} data-icon="inline-start" />
            Refresh
          </Button>
        </header>
        <div aria-busy={busy} className="settings-content plugins-content">
          <p className="settings-intro">
            Built-in plugins for this device. Enable the sources and integrations you want to use.
          </p>
          {error || loadingError ? (
            <Alert>
              <AlertDescription>{error ?? "Unable to load plugins"}</AlertDescription>
            </Alert>
          ) : null}
          {state ? (
            groups.map((group) => (
              <FieldSet hidden={section !== "installed" && section !== group.id} key={group.id}>
                <FieldLegend>{group.label}</FieldLegend>
                <FieldGroup className="settings-group plugins-group">
                  {state.plugins
                    .filter((plugin) => group.plugins.some((id) => id === plugin.id))
                    .map((plugin) => (
                      <PluginCard
                        action={action}
                        busy={busy}
                        key={plugin.id}
                        plugin={plugin}
                        reload={reload}
                      />
                    ))}
                </FieldGroup>
              </FieldSet>
            ))
          ) : loadingError || error ? null : (
            <Skeleton aria-label="Loading plugins" className="h-64 w-full" />
          )}
        </div>
      </main>
    </div>
  );
}
