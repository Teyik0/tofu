import { defineRoute } from "@teyik0/furin";
import { Callout, Code, DocTitle } from "../../components/docs";
import { route as docs } from "./_route";

export const route = defineRoute()
  .config({ layout: docs, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Plugin API — Tofu" }] }))
  .page(() => (
    <>
      <DocTitle
        description="Small contributions, shared context. Extend the API and interface without taking over the engine."
        label="SDK reference"
        title="The useful pieces."
      />
      <h2>The plugin definition</h2>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Contract</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>id</code>, <code>name</code>, <code>version</code>
            </td>
            <td>
              Required identity. IDs start with a lowercase letter and contain lowercase letters,
              digits, or hyphens.
            </td>
          </tr>
          <tr>
            <td>
              <code>api</code>
            </td>
            <td>
              An Elysia instance or a factory receiving <code>PluginContext</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>ui</code>
            </td>
            <td>Optional pages, thread actions, and settings component.</td>
          </tr>
          <tr>
            <td>
              <code>settings</code>
            </td>
            <td>Optional TypeBox object schema and validated defaults.</td>
          </tr>
          <tr>
            <td>
              <code>auth</code>
            </td>
            <td>Optional OAuth 2, API key, or custom provider declaration.</td>
          </tr>
          <tr>
            <td>
              <code>setup</code>
            </td>
            <td>Optional hook receiving settings, authentication, and the enable-cycle scope.</td>
          </tr>
        </tbody>
      </table>
      <p>
        <code>PluginContext</code> gives the server <code>settings</code>, <code>auth</code> (or{" "}
        <code>null</code>), <code>scope</code>, and optional <code>sync</code> options.
        Authentication adapters, capabilities, and real synchronization are supplied by the host.
      </p>
      <h2>Thread actions and settings UI</h2>
      <p>
        A thread action has an <code>id</code>, <code>label</code>, optional icon, and either a{" "}
        <code>run</code> callback or a <code>dialog</code> component. Both receive the thread,
        dashboard, host settings, and that thread’s torrents. Dialogs also receive{" "}
        <code>close</code>.
      </p>
      <Code>{`import type { ThreadActionContext } from "@tofu/plugins";

function Greeting({ thread, close }: ThreadActionContext & {
  close(): void;
}) {
  return <section role="dialog" aria-label="Thread greeting">
    <h2>Hello, {thread.name}</h2>
    <button type="button" onClick={close}>Close</button>
  </section>;
}

export const ui = {
  threadActions: [{ id: "greet", label: "Say hello", dialog: Greeting }],
  settings: GreetingSettings,
} as const;`}</Code>
      <p>
        <code>GreetingSettings</code> is your settings component; it receives an optional{" "}
        <code>threadId</code>. Omit it to edit global values, or pass the active thread ID to edit
        overrides.
      </p>
      <h2>Persistent, typed settings</h2>
      <p>
        In Plugins, create a contributed page and choose <strong>Pin to sidebar</strong> for a
        shortcut. The host also renders declared settings globally and for the current thread.
        Removing a page removes its saved placement; it does not uninstall the plugin or erase its
        settings.
      </p>
      <p>
        The host persists schema-validated settings locally. <code>settings.get(threadId?)</code>{" "}
        returns a clone of global values merged with that thread’s overrides.{" "}
        <code>update(values, threadId?)</code> validates and persists a partial update.{" "}
        <code>reset(threadId?)</code> clears a thread override or restores global defaults.
      </p>
      <p>
        Thread overrides survive global resets. Settings live outside package source, so disabling
        and enabling a plugin does not erase them. Keep credentials in the authentication store
        rather than the settings schema.
      </p>
      <h2>Typed clients, queries, and mutations</h2>
      <p>
        Build a synchronized backend with <code>createPluginApi(context)</code> from
        <code>@tofu/plugins/server</code>. It installs Furin Sync using the host’s adapter,
        principal, and notifier, and rejects missing options. A plain Elysia API remains valid for
        plugins that do not need synchronization. A standalone preview must supply real Sync
        options, such as a migrated SQLite adapter, through{" "}
        <code>createPluginRuntime({"{ sync }"})</code>.
      </p>
      <Code>{`const settingsQuery = { id: "my-plugin.settings", scope: {} };

return createPluginApi(context)
  .use(core)
  .get("/settings", {
    query: Type.Object({ threadId: Type.Optional(Type.String()) }),
    sync: settingsQuery,
  }, ({ query }) => context.settings.get(query.threadId))
  .patch("/settings", {
    body: Type.Partial(settingsSchema),
    query: Type.Object({ threadId: Type.Optional(Type.String()) }),
    sync: { invalidate: settingsQuery },
  }, ({ body, query }) => context.settings.update(body, query.threadId));`}</Code>
      <p>
        Query IDs should include your plugin ID. Here <code>scope: {"{}"}</code> invalidates all
        matching settings queries, including global and thread reads. Installing the adapter alone
        does not declare query identities or mutation invalidations.
      </p>
      <p>
        <code>createClient</code>, <code>useQuery</code>, and <code>useMutation</code> from{" "}
        <code>@tofu/plugins/client</code> directly reexport Furin’s client implementation. Infer the
        Elysia API type from your server factory with a type-only import.
      </p>
      <Code>{`import { createClient, useMutation, useQuery } from "@tofu/plugins/client";
import type { createAPI } from "../server";

const origin = typeof window === "undefined"
  ? "http://localhost" : window.location.origin;
const client = createClient<ReturnType<typeof createAPI>>(
  origin + "/api/plugins/my-plugin",
);

function GreetingSettings({ threadId }: { threadId?: string }) {
  const query = useQuery(client.settings.get, { query: { threadId } });
  const save = useMutation(client.settings.patch);
  return <button disabled={save.isPending}
    onClick={() => save.mutate({ greeting: "Hello" }, { query: { threadId } })} type="button" >
    {query.data?.greeting ?? "—"}
  </button>;
}`}</Code>
      <p>
        This example uses the generated template’s <code>/settings</code> GET and PATCH routes. The
        explicit Sync invalidation refreshes the native <code>useQuery</code> after
        <code>useMutation</code> saves. The client import is browser-safe; do not import a server
        value into client code. <code>usePluginHost()</code> provides the live dashboard and host
        refresh callback when rendered within the host provider.
      </p>
      <h2>Authentication</h2>
      <p>
        Declare <code>auth</code> as <code>{'{ kind: "api-key", label: "Service API key" }'}</code>,
        an OAuth 2 definition with client ID, authorization/token URLs, scopes, and PKCE choice, or{" "}
        <code>{'{ kind: "custom", label: "Connect account" }'}</code>.
      </p>
      <p>
        The host-owned <code>PluginAuth</code> adapter exposes <code>authorize()</code>,{" "}
        <code>disconnect()</code>, <code>status()</code>, and a backend-only credential store with{" "}
        <code>get</code>, <code>set</code>, and <code>delete</code>. Public status contains only{" "}
        <code>authenticated</code>, <code>pending</code>, <code>account</code>, and{" "}
        <code>error</code>. Never return credentials in your API.
      </p>
      <Callout>
        <p>
          Tofu supplies API-key and OAuth 2 adapters for compatible declarations. Generic custom
          providers need an explicit host integration. AniList retains its existing native callback
          flow. Automatic token refresh and revocation are not implemented.
        </p>
      </Callout>
      <p>
        The SDK credential store uses owner-only local files and directories where supported.
        Credentials are not encrypted, and trusted in-process code still has the host’s
        operating-system access.
      </p>
      <p>
        OAuth 2 uses a separate local HTTP callback listener, protected by one-time state and
        optional PKCE. The native app’s session guard stays in place. By default, Tofu chooses an
        available loopback port. Providers requiring a registered fixed callback can use the
        optional <code>redirectUri</code> declaration: an HTTP URL on <code>127.0.0.1</code> or
        <code>localhost</code> with an explicit port and no query or fragment. Register that exact
        URL with the provider. Disabling the plugin closes its callback listener.
      </p>
      <h2>Lifecycle and cleanup</h2>
      <Code>{`setup({ scope }) {
  const timer = setInterval(() => refresh(), 60_000);
  scope.onDispose(() => clearInterval(timer));
  // Use scope.signal for cancellable fetches and background work.
}`}</Code>
      <p>
        Each enable cycle gets a fresh scope. Disabling removes active API routes and UI
        contributions, aborts the signal, and runs disposers in reverse registration order. A failed
        setup also disposes its scope. Re-enabling creates a new API instance while the host engine
        stays alive.
      </p>
      <p>
        A page can explicitly declare <code>availableWhenDisabled: true</code> to keep an account or
        configuration screen available. AniList does this. This page option does not keep plugin
        background work or feature API routes running.
      </p>
      <p>
        The runtime serializes lifecycle changes and rebuilds the plugin API registry because Elysia
        has no <code>unuse</code>. It does not recreate WebTorrent or remove downloaded files.
      </p>
    </>
  ));
