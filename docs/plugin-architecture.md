# Experimental plugin architecture

`@tofu/plugins` version `0.0.0` lives in `package/plugins`. It is an experimental local SDK, with no stable published distribution or marketplace. `package/anilist` is the official plugin built on the same definition, native route factory, and lifecycle contracts. Run `bun run dev:docs` for the guided tutorial and API reference at `/docs/plugins` and `/docs/plugin-api`.

## One host, one engine

`apps/tofu/src/server.ts` owns the final Elysia root and installs `desktopApp()` before application wrappers. `apps/tofu/src/api.ts` composes the core HTTP API, Jev, AniList, automation, discovery, and plugin configuration. Durable services start through the desktop lifecycle hooks. The WebTorrent engine stays in Bun.

The host's internal `apps/tofu/src/api/core.ts` dependency holds its lazy services. Third-party factories receive a route-free typed facade exposing selected domain capabilities rather than raw WebTorrent objects, native SDK handles, or credential records. Each plugin API calls `.use(core)` to obtain its own inferred handler context.

This avoids mounting the entire torrent router under an extension prefix and reuses the existing engine. A second engine would create competing storage and lifecycle ownership. Shared desktop contracts remain in `apps/tofu/src/types.ts`; the SDK exports the selected public domain contracts.

The extension and AniList API boundaries use Elysia `.mount()`, which preserves independent runtime routers. Furin deliberately skips Elysia's build-time AOT when it detects these mounts: AOT seals one router per process and cannot represent a registry rebuilt on activation. The alternative would be a fixed plugin set that cannot change until the application restarts. The core API still composes with `.use(core)` in the same process.

## Definition and browser boundary

Use one `definePlugin({ id, name, version, api, ui, settings, auth, setup })` from `@tofu/plugins`. The generated server entry exports `createPlugin(core)`. The browser entry exports the `ui` contribution. IDs start with a lowercase letter and use lowercase letters, digits, or hyphens.

- `api` is an Elysia instance or a factory receiving host-owned settings, auth, a lifecycle scope, and optional real Furin Sync options.
- `ui.pages` contributes native Furin route factories; `ui.threadActions` contributes a callback or dialog, and `ui.settings` contributes a component receiving an optional thread ID.
- `settings` declares a TypeBox object schema and defaults.
- `auth` declares an OAuth 2, API key, or custom provider; the host supplies its actual adapter.
- `setup` starts enable-cycle work and registers cleanup.

`@tofu/plugins/client` directly reexports Furin's `createClient`, `useQuery`, and `useMutation`, preserving the host's query and React contexts. Use type-only imports to infer your Elysia API from the backend factory. Do not import server values into browser code.

## Native synchronization

Use `createPluginApi(context)` from `@tofu/plugins/server` when your API needs Furin Sync. It installs the host's actual Sync adapter, principal, and notifier; missing options are rejected. The runtime receives these through `createPluginRuntime({ sync })` and passes them to setup/API context. Plain Elysia APIs remain supported without Sync. Standalone previews must supply real options, such as a migrated SQLite Sync adapter.

Declare a read identity and the corresponding mutation invalidation explicitly:

```ts
import { createPluginApi } from "@tofu/plugins/server";
import type { PluginContext } from "@tofu/plugins";
import type { PluginCore } from "@tofu/plugins/server";
import { Type } from "typebox";

const settingsSchema = Type.Object({ greeting: Type.String() });
const settingsQuery = { id: "my-plugin.settings", scope: {} };

export function createAPI(core: PluginCore, context: PluginContext<typeof settingsSchema>) {
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
    }, ({ body, query }) => context.settings.update(body, query.threadId));
}
```

Use a plugin-specific query ID. The empty scope selector refreshes all matching global and thread settings reads, which is useful when a global update affects inherited thread values. Installing the adapter alone does not invent query identities or invalidations.

The browser uses native Furin clients and hooks:

```tsx
import { createClient, useMutation, useQuery } from "@tofu/plugins/client";
import type { createAPI } from "../server";

const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
const client = createClient<ReturnType<typeof createAPI>>(origin + "/api/plugins/my-plugin");

function GreetingSettings({ threadId }: { threadId?: string }) {
  const query = useQuery(client.settings.get, { query: { threadId } });
  const save = useMutation(client.settings.patch);
  return <button type="button" disabled={save.isPending}
    onClick={() => save.mutate({ greeting: "Hello" }, { query: { threadId } })}>
    {query.data?.greeting ?? "—"}
  </button>;
}
```

The PATCH invalidates the GET identity, so the shared native query cache refreshes without adding a separate client or custom refresh protocol.

## Native pages and inherited loaders

Each page has an ID, title, path, optional icon, `pinnable`, and a route factory. Import `defineRoute` directly from `@teyik0/furin`; the compiler recognizes and strips that native route declaration. Import only `PluginRouteContext` as a type from `@tofu/plugins/routes`.

Account or configuration pages can explicitly set `availableWhenDisabled: true`. Their saved page placement remains accessible while the plugin's active features are disabled. AniList uses this to keep its account screen available. The option does not keep background work or feature API routes running.

```tsx
import { defineRoute } from "@teyik0/furin";
import type { PluginRouteContext } from "@tofu/plugins/routes";

export function createPage({ threadLayout }: PluginRouteContext) {
  return defineRoute()
    .config({ layout: threadLayout, mode: "ssr" })
    .loader(async ({ dashboard, settings, thread }) => {
      const [state, preferences, currentThread] = await Promise.all([
        dashboard, settings, thread,
      ]);
      return {
        name: currentThread?.name ?? "All threads",
        count: state.destinations.length,
        downloadPath: preferences.downloadPath,
      };
    })
    .page(({ name, count }) => <h1>{name}: {count} threads</h1>);
}
```

The injected layout is the host's actual native parent, including its shell and thread selection. The public structural type exposes promised loader data (`dashboard`, `settings`, nullable `thread`) while hiding private host render props. Thread action context always includes a real thread and that thread's torrents.

The pinned Furin preview compiles a fixed route graph. The host generates normal physical page adapters under controlled `/extensions/<plugin-id>/<page-id>` paths before development and builds. Source client route factories must remain available. New or removed page contributions need rebuild/restart; dynamically loading arbitrary browser route graphs after installation is not supported.

In Plugins, use **Create page**, then **Pin to sidebar** to save a shortcut. The host renders plugin settings globally and for the selected thread, and thread actions in the active thread's controls. Removing a saved page placement does not uninstall the plugin or erase its data.

## Settings and authentication

`settings.get(threadId?)` merges global settings with that thread's partial overrides. `update(values, threadId?)` validates and persists updates atomically. `reset(threadId?)` removes an override or restores global defaults while retaining thread overrides. Reads return clones; disabling does not erase persisted settings.

The host adapter keeps credentials on the Bun side. Public status includes only `authenticated`, `pending`, `account`, and `error`. SDK credential storage is plaintext. On POSIX systems, credential files use mode `0600` and their plugin directory uses `0700`. On Windows, access follows the containing directory's ACLs; the SDK does not configure ACLs, and [Bun's file mode API can only manipulate write permission](https://bun.com/reference/node/fs/open). Trusted code still has the host's operating-system access.

The SDK provides API-key, custom, and OAuth 2 adapter building blocks. OAuth 2 supports authorization code with optional PKCE, one-time expiring state, explicit client authentication, and private access/refresh tokens. Automatic refresh and revocation are not implemented. AniList retains its provider-specific implicit grant and native callbacks through a custom adapter. Tofu supplies API-key and OAuth 2 adapters for compatible declarations. OAuth 2 also requires the provider client and matching callback configuration; generic custom providers need an explicit integration.

Generic OAuth 2 uses a separate loopback HTTP listener, so provider redirects do not pass through the desktop app's private session guard. One-time state and optional PKCE validate the callback. The default listener uses an available port. Set the optional `redirectUri` declaration when the provider requires a registered fixed callback: it must be an HTTP URL on `127.0.0.1` or `localhost`, with an explicit port and no query or fragment. Register the exact URI with the provider. The plugin scope closes the listener on disable or shutdown.

## Lifecycle

The runtime installs definitions disabled, serializes lifecycle changes, and gives every enable cycle a fresh scope. Use `scope.signal` for cancellable work and `scope.onDispose()` for timers and other resources. Disable removes the active API/UI contributions, except explicitly available account/configuration pages, aborts the signal, and runs disposers in reverse registration order. Failed setup also disposes its scope. Re-enable creates a new plugin API while preserving the host engine and plugin data.

Elysia has no `unuse`, so the SDK rebuilds its active API registry rather than the host's durable services. Uninstall removes the registration; neither disable nor uninstall deletes downloads.

## Create and install a local plugin

From the repository root:

```sh
bun run apps/scaffolder/src/cli.ts ../my-plugin
cd ../my-plugin
bun install
bun run tscheck
bun run build
bun test
bun run dev
```

The preview at `http://127.0.0.1:3000` uses explicit empty fixtures and the same physical route adapter shape as Tofu. It creates no second engine. The scaffolder copies a portable local SDK snapshot and the pinned Furin archive; it refuses existing destinations and never executes scripts or installs dependencies. See its [README](../apps/scaffolder/README.md) for flags.

The generated ESM package includes:

```json
{
  "tofuPlugin": {
    "id": "my-plugin",
    "apiVersion": "0.0.0",
    "server": "./dist/server/index.js",
    "client": "./src/client/index.tsx"
  }
}
```

`inspectPluginPackage()` validates metadata and compatibility, rejects symlinks and escaping paths, and calculates SHA-256 over package files (excluding `.git` and `node_modules`). Inspection only reads files; it never imports code or executes lifecycle scripts. Integrity identifies reviewed contents rather than proving safety.

After building and reviewing the plugin, return to the Tofu root:

```sh
bun run plugin:install ../my-plugin --trust
bun run dev
# Or: bun run build:desktop && bun run desktop

bun run plugin:generate
bun run plugin:uninstall my-plugin
```

Installation requires explicit `--trust`; replacing an installed pin also requires `--replace`. The host copies source into `apps/tofu/.tofu-plugins`, verifies its recorded integrity, shares its React/Furin/SDK dependencies, and generates native contributions. Package install scripts are never run, but trusted client compilation and server execution do run. Uninstall keeps cached code, settings, credentials, and downloads. Restart or rebuild after installation changes. New trusted local plugins start enabled; manage their enablement in Plugins. Existing saved disabled states remain respected.

Plugins execute in the same host process. There is no iframe, process isolation, or capability sandbox. This supplies normal native routes and a shared interface; isolation would require a separate process and an explicit capability/UI bridge.
