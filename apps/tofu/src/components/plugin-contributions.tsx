import type { PluginUI, ThreadAction, ThreadActionContext } from "@tofu/plugins/client";
import { useMutation, useQuery } from "@tofu/plugins/client";
import { ActionTooltip } from "@tofu/ui/action-tooltip";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import { Badge } from "@tofu/ui/badge";
import { Button, buttonVariants } from "@tofu/ui/button";
import { Checkbox } from "@tofu/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@tofu/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@tofu/ui/field";
import { Input } from "@tofu/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tofu/ui/select";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@tofu/ui/sidebar";
import { Switch } from "@tofu/ui/switch";
import { Textarea } from "@tofu/ui/textarea";
import { PlugIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { TObject } from "typebox";
import { type ExtensionState, extensionClient, registeredPluginUIs } from "../plugin-client";

type ExtensionPlugin = NonNullable<ExtensionState>["plugins"][number];
type Registry = readonly { id: string; ui: PluginUI }[];
interface Contributions {
  error: string | null;
  path: string;
  plugins: readonly ExtensionPlugin[];
  registry: Registry;
  reload: () => Promise<void>;
}
const ContributionContext = createContext<Contributions | null>(null);
export function usePluginContributions() {
  const value = useContext(ContributionContext);
  if (!value) {
    throw new Error("Plugin contributions require the Tofu host");
  }
  return value;
}
function failureMessage(cause: unknown) {
  if (cause && typeof cause === "object" && "value" in cause) {
    const { value } = cause;
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object" && "error" in value && typeof value.error === "string") {
      return value.error;
    }
    if (
      value &&
      typeof value === "object" &&
      "detail" in value &&
      typeof value.detail === "string"
    ) {
      return value.detail;
    }
  }
  return cause instanceof Error ? cause.message : "Unable to update the plugin";
}
export function PluginContributionsProvider({
  children,
  path,
  initialState,
  registry,
}: {
  children: ReactNode;
  path: string;
  initialState?: NonNullable<ExtensionState>;
  registry?: Registry;
}) {
  const { data: live, error: queryError } = useQuery(extensionClient.api.extensions.get);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [saved, setSaved] = useState<{
    data: NonNullable<ExtensionState>;
    baseline: ExtensionState | undefined;
  } | null>(null);
  const reload = useCallback(async () => {
    const result = await extensionClient.api.extensions.get();
    if (result.error) {
      throw result.error;
    }
    if (result.data) {
      setSaved({ baseline: liveRef.current, data: result.data });
    }
  }, []);
  return (
    <ContributionContext.Provider
      value={{
        error: queryError ? failureMessage(queryError) : null,
        path,
        plugins:
          (saved !== null && (live === undefined || live === saved.baseline)
            ? saved.data
            : (live ?? initialState)
          )?.plugins ?? [],
        registry: registry ?? registeredPluginUIs,
        reload,
      }}
    >
      {children}
    </ContributionContext.Provider>
  );
}

export function PluginSidebarPages({ pinned }: { pinned: boolean }) {
  const { plugins, registry, path } = usePluginContributions();
  const pages = plugins.flatMap((plugin) =>
    plugin.pages
      .filter((page) => page.available && page.created && page.pinned === pinned)
      .map((page) => ({ ...page, pluginId: plugin.id }))
  );
  const links = pages.map((page) => {
    const Icon =
      registry
        .find((entry) => entry.id === page.pluginId)
        ?.ui.pages?.find((entry) => entry.id === page.id)?.icon ?? PlugIcon;
    return (
      <SidebarMenuItem key={`${page.pluginId}/${page.id}`}>
        {pinned ? (
          <ActionTooltip>
            <a
              aria-current={path === page.path ? "page" : undefined}
              aria-label={page.title}
              className="sidebar-shortcut sidebar-app-shortcut"
              data-sidebar="menu-button"
              href={page.path}
            >
              <Icon />
            </a>
          </ActionTooltip>
        ) : (
          <SidebarMenuButton
            aria-label={page.title}
            className="sidebar-thread-link"
            isActive={path === page.path}
            render={<a aria-current={path === page.path ? "page" : undefined} href={page.path} />}
            tooltip={page.title}
          >
            <Icon />
            <span>{page.title}</span>
          </SidebarMenuButton>
        )}
      </SidebarMenuItem>
    );
  });
  if (pinned) {
    return links;
  }
  return pages.length ? (
    <SidebarGroup>
      <SidebarGroupLabel>PLUGIN PAGES</SidebarGroupLabel>
      <SidebarMenu aria-label="Plugin pages">{links}</SidebarMenu>
    </SidebarGroup>
  ) : null;
}

export function PluginThreadActions({ context }: { context: ThreadActionContext }) {
  const { plugins, registry } = usePluginContributions();
  return registry
    .filter((entry) => plugins.some((plugin) => plugin.id === entry.id && plugin.enabled))
    .flatMap((entry) =>
      (entry.ui.threadActions ?? []).map((action) => (
        <PluginThreadAction
          action={action}
          context={context}
          key={`${entry.id}/${action.id}/${context.thread.id}`}
        />
      ))
    );
}
function PluginThreadAction({
  action,
  context,
}: {
  action: ThreadAction;
  context: ThreadActionContext;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (action.dialog) {
      setOpened(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await action.run(context);
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const Icon = action.icon;
  const Content = action.dialog;
  return (
    <>
      <Button
        aria-label={action.label}
        disabled={busy}
        onClick={() => void run()}
        variant="outline"
      >
        {Icon !== undefined && <Icon data-icon="inline-start" />}
        {action.label}
      </Button>
      {error !== null && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      {Content !== undefined && (
        <Dialog onOpenChange={setOpened} open={opened}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{action.label}</DialogTitle>
            </DialogHeader>
            <Content {...context} close={() => setOpened(false)} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export function RegisteredPluginSettings({
  threads,
}: {
  threads: readonly { id: string; name: string }[];
}) {
  const { plugins, registry, error, reload } = usePluginContributions();
  const [threadId, setThreadId] = useState("");
  const [scoped, setScoped] = useState<NonNullable<ExtensionState> | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadScope = useCallback(async () => {
    if (!threadId) {
      setScoped(null);
      return;
    }
    const result = await extensionClient.api.extensions.get({ query: { threadId } });
    if (result.error) {
      throw result.error;
    }
    setScoped(result.data);
  }, [threadId]);
  useEffect(() => {
    let active = true;
    setScoped(null);
    setScopeError(null);
    if (!threadId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void extensionClient.api.extensions
      .get({ query: { threadId } })
      .then((result) => {
        if (!active) {
          return;
        }
        if (result.error) {
          setScopeError(failureMessage(result.error));
        } else {
          setScoped(result.data);
        }
      })
      .catch((cause) => {
        if (active) {
          setScopeError(failureMessage(cause));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [threadId]);
  const refresh = async () => {
    await reload();
    await loadScope();
  };
  return (
    <FieldSet>
      <FieldLegend>Plugin pages and settings</FieldLegend>
      <FieldDescription>
        Create pages, pin shortcuts, and configure installed plugins.
      </FieldDescription>
      <Field>
        <FieldLabel htmlFor="extension-settings-scope">Settings scope</FieldLabel>
        <Select
          items={[
            { label: "Global settings", value: "" },
            ...threads.map((thread) => ({ label: thread.name, value: thread.id })),
          ]}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setThreadId(value);
            }
          }}
          value={threadId}
        >
          <SelectTrigger id="extension-settings-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="">Global settings</SelectItem>
              {threads.map((thread) => (
                <SelectItem key={thread.id} value={thread.id}>
                  {thread.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          {threadId
            ? "Saved values override global settings for this tab."
            : "Global values apply to tabs without overrides."}
        </FieldDescription>
      </Field>
      {(error !== null || scopeError !== null) && (
        <Alert>
          <AlertDescription>{scopeError ?? error}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <p className="text-muted-foreground text-sm" role="status">
          Loading tab settings…
        </p>
      ) : scopeError ? null : (
        <FieldGroup className="settings-group plugins-group">
          {plugins.map((plugin) => (
            <RegisteredPluginCard
              key={`${plugin.id}/${threadId}`}
              plugin={{
                ...plugin,
                settings: threadId
                  ? (scoped?.plugins.find((entry) => entry.id === plugin.id)?.settings ?? null)
                  : plugin.settings,
              }}
              refresh={refresh}
              threadId={threadId || undefined}
              ui={registry.find((entry) => entry.id === plugin.id)?.ui}
            />
          ))}
          {!(plugins.length || error) && (
            <p className="text-muted-foreground text-sm">
              No installed plugin pages are available.
            </p>
          )}
        </FieldGroup>
      )}
    </FieldSet>
  );
}
function RegisteredPluginCard({
  plugin,
  refresh,
  threadId,
  ui,
}: {
  plugin: ExtensionPlugin;
  refresh: () => Promise<void>;
  threadId: string | undefined;
  ui: PluginUI | undefined;
}) {
  const endpoint = extensionClient.api.extensions({ id: plugin.id });
  const enable = useMutation(endpoint.enabled.patch, { onSuccess: refresh });
  const reset = useMutation(endpoint.settings.delete, { onSuccess: refresh });
  const CustomSettings = ui?.settings;
  return (
    <article
      aria-label={`${plugin.name} contributions`}
      className="plugin-card plugins-plugin"
      data-plugin-contributions
    >
      <Field orientation="horizontal">
        <div className="flex flex-1 flex-col gap-1">
          <div className="plugins-plugin-title">
            <FieldLabel htmlFor={`extension-enabled-${plugin.id}`}>{plugin.name}</FieldLabel>
            <Badge variant={plugin.enabled ? "secondary" : "outline"}>
              {plugin.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
        </div>
        <Switch
          aria-label={`Enable ${plugin.name} contributions`}
          checked={plugin.enabled}
          disabled={enable.isPending}
          id={`extension-enabled-${plugin.id}`}
          onCheckedChange={(enabled) => enable.mutate({ enabled })}
        />
      </Field>
      {enable.error !== null && (
        <p className="text-destructive text-xs" role="alert">
          {failureMessage(enable.error)}
        </p>
      )}
      {plugin.error !== null && (
        <p className="text-destructive text-xs" role="alert">
          {plugin.error}
        </p>
      )}
      {CustomSettings ? (
        <CustomSettings threadId={threadId} />
      ) : (
        plugin.schema &&
        plugin.settings && (
          <SchemaSettings
            key={JSON.stringify(plugin.settings)}
            plugin={plugin}
            refresh={refresh}
            threadId={threadId}
          />
        )
      )}
      {threadId !== undefined && plugin.settings !== null && (
        <Button
          disabled={reset.isPending}
          onClick={() => reset.mutate({ query: { threadId } })}
          size="sm"
          variant="ghost"
        >
          Use global settings
        </Button>
      )}
      {reset.error !== null && (
        <p className="text-destructive text-xs" role="alert">
          {failureMessage(reset.error)}
        </p>
      )}
      {plugin.auth !== null && <PluginAccount plugin={plugin} refresh={refresh} />}
      {plugin.pages.length > 0 && (
        <FieldGroup>
          {plugin.pages.map((page) => (
            <PluginPageControls key={page.id} page={page} plugin={plugin} refresh={refresh} />
          ))}
        </FieldGroup>
      )}
    </article>
  );
}
function SchemaSettings({
  plugin,
  refresh,
  threadId,
}: {
  plugin: ExtensionPlugin;
  refresh: () => Promise<void>;
  threadId: string | undefined;
}) {
  const save = useMutation(extensionClient.api.extensions({ id: plugin.id }).settings.patch, {
    onSuccess: refresh,
  });
  const [validationError, setValidationError] = useState<string | null>(null);
  const fields = Object.entries(plugin.schema?.properties ?? {}).map(([name, schema]) => ({
    name,
    schema: {
      description: schemaText(schema, "description"),
      title: schemaText(schema, "title"),
      type: schemaText(schema, "type"),
    },
  }));
  const submit = (form: HTMLFormElement) => {
    try {
      if (!(plugin.schema && plugin.settings)) {
        return;
      }
      const patch = settingsFormPatch(plugin.schema, plugin.settings, new FormData(form));
      setValidationError(null);
      save.mutate({ patch, ...(threadId ? { threadId } : {}) });
    } catch (cause) {
      setValidationError(failureMessage(cause));
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
    >
      <FieldGroup className="plugins-configuration">
        {fields.map(({ name, schema }) => {
          const id = `extension-setting-${plugin.id}-${name}`;
          const value: unknown = plugin.settings ? Reflect.get(plugin.settings, name) : undefined;
          const label = typeof schema.title === "string" ? schema.title : name.replaceAll("_", " ");
          return (
            <Field key={name}>
              <FieldLabel htmlFor={id}>{label}</FieldLabel>
              {schema.type === "boolean" ? (
                <Checkbox defaultChecked={value === true} id={id} name={name} />
              ) : schema.type === "string" ||
                schema.type === "number" ||
                schema.type === "integer" ? (
                <Input
                  defaultValue={typeof value === "string" || typeof value === "number" ? value : ""}
                  id={id}
                  name={name}
                  required={plugin.schema?.required?.includes(name)}
                  step={schema.type === "integer" ? 1 : "any"}
                  type={schema.type === "string" ? "text" : "number"}
                />
              ) : (
                <Textarea
                  defaultValue={value === undefined ? "" : JSON.stringify(value, null, 2)}
                  id={id}
                  name={name}
                />
              )}
              {typeof schema.description === "string" && (
                <FieldDescription>{schema.description}</FieldDescription>
              )}
            </Field>
          );
        })}
        {(validationError !== null || save.error !== null) && (
          <p className="text-destructive text-xs" role="alert">
            {validationError ?? failureMessage(save.error)}
          </p>
        )}
        <Button disabled={save.isPending} size="sm" type="submit">
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </FieldGroup>
    </form>
  );
}
function PluginPageControls({
  page,
  plugin,
  refresh,
}: {
  page: ExtensionPlugin["pages"][number];
  plugin: ExtensionPlugin;
  refresh: () => Promise<void>;
}) {
  const endpoint = extensionClient.api.extensions({ id: plugin.id }).pages({ pageId: page.id });
  const create = useMutation(endpoint.post, { onSuccess: refresh });
  const remove = useMutation(endpoint.delete, { onSuccess: refresh });
  const busy = create.isPending || remove.isPending;
  const error = create.error ?? remove.error;
  return (
    <Field>
      <FieldLabel>{page.title}</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        {page.created ? (
          <>
            <a
              aria-disabled={!page.available}
              className={buttonVariants({ size: "sm", variant: "outline" })}
              href={page.available ? page.path : undefined}
            >
              Open page
            </a>
            {page.pinnable === true && (
              <Button
                disabled={busy}
                onClick={() => create.mutate({ pinned: !page.pinned })}
                size="sm"
                variant="outline"
              >
                {page.pinned ? "Unpin" : "Pin to sidebar"}
              </Button>
            )}
            <Button disabled={busy} onClick={() => remove.mutate()} size="sm" variant="ghost">
              Remove page
            </Button>
          </>
        ) : (
          <Button
            disabled={busy || !page.available}
            onClick={() => create.mutate({ pinned: false })}
            size="sm"
            variant="outline"
          >
            Create page
          </Button>
        )}
      </div>
      {error !== null && (
        <p className="text-destructive text-xs" role="alert">
          {failureMessage(error)}
        </p>
      )}
    </Field>
  );
}
function PluginAccount({
  plugin,
  refresh,
}: {
  plugin: ExtensionPlugin;
  refresh: () => Promise<void>;
}) {
  const endpoint = extensionClient.api.extensions({ id: plugin.id }).auth;
  const connect = useMutation(endpoint.post, { onSuccess: refresh });
  const disconnect = useMutation(endpoint.delete, { onSuccess: refresh });
  const [key, setKey] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const { auth } = plugin;
  if (!auth) {
    return null;
  }
  const authorize = async () => {
    try {
      const result = await connect.mutateAsync(auth.type === "api-key" ? { apiKey: key } : {});
      setKey("");
      setAuthorizationUrl(result?.url ?? null);
    } catch {
      // The mutation displays its public error beside the account controls.
    }
  };
  const [customPage] = plugin.pages;
  const error = connect.error ?? disconnect.error;
  const busy = connect.isPending || disconnect.isPending;
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>{auth.label}</FieldLabel>
        <FieldDescription>
          {auth.connected ? "Account connected" : "Account not connected"}
        </FieldDescription>
        {auth.type === "custom" && customPage ? (
          <a className={buttonVariants({ size: "sm", variant: "outline" })} href={customPage.path}>
            Manage account
          </a>
        ) : (
          <>
            {auth.type === "api-key" && !auth.connected && (
              <Input
                aria-label={`${plugin.name} API key`}
                autoComplete="off"
                onChange={(event) => setKey(event.target.value)}
                type="password"
                value={key}
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {auth.connected ? (
                <Button
                  disabled={busy || !plugin.enabled}
                  onClick={() => disconnect.mutate()}
                  size="sm"
                  variant="outline"
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  disabled={busy || !plugin.enabled || (auth.type === "api-key" && !key.trim())}
                  onClick={() => void authorize()}
                  size="sm"
                  variant="outline"
                >
                  Connect account
                </Button>
              )}
              {authorizationUrl !== null && (
                <a
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                  href={authorizationUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Continue authorization
                </a>
              )}
            </div>
          </>
        )}
        {error !== null && (
          <p className="text-destructive text-xs" role="alert">
            {failureMessage(error)}
          </p>
        )}
      </Field>
    </FieldGroup>
  );
}

function schemaText(schema: object, key: string): string | undefined {
  const value: unknown = Reflect.get(schema, key);
  return typeof value === "string" ? value : undefined;
}

/** Convert native form values into a partial patch; blank optional values remain unchanged. */
export function settingsFormPatch(schema: TObject, current: object, form: FormData): object {
  const entries: [string, unknown][] = [];
  for (const [name, field] of Object.entries(schema.properties)) {
    const type = schemaText(field, "type");
    const value = String(form.get(name) ?? "");
    const required = schema.required?.includes(name) ?? false;
    const existing: unknown = Reflect.get(current, name);
    if (type === "boolean") {
      if (required || form.has(name) || existing !== undefined) {
        entries.push([name, form.has(name)]);
      }
      continue;
    }
    const blank = type === "string" ? value === "" : !value.trim();
    if (!required && blank && (type !== "string" || existing === undefined)) {
      continue;
    }
    if (type === "number" || type === "integer") {
      const number = Number(value);
      if (!(value.trim() && Number.isFinite(number))) {
        throw new Error(`${name} must be a number`);
      }
      entries.push([name, number]);
    } else if (type === "string") {
      entries.push([name, value]);
    } else {
      entries.push([name, JSON.parse(value)]);
    }
  }
  return Object.fromEntries(entries);
}
