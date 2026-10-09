# Elysia plugin composition

`src/server.ts` owns the final Elysia root and installs `desktopApp()` before application wrappers. `src/api.ts` mounts the core HTTP API, Jev, AniList, automation, discovery and plugin configuration. Existing HTTP paths and Furin client inference remain unchanged. Durable services start through the desktop plugin's lifecycle hooks, not during route registration.

`src/api/core.ts` exports a named, route-free `core` Elysia dependency. Official modules use the same lazy engine, journal and automation getters. They never construct another engine or open another database. `createCore()` and `createApi()` also accept fixture dependencies so independent applications keep their own services.

An application-authored extension can declare its dependency explicitly:

```ts
import { Elysia } from "elysia";
import { core } from "./api/core";

export const extension = new Elysia({
  name: "plugin-example",
  prefix: "/api/plugins/example",
})
  .use(core)
  .get("/torrents", ({ core: capabilities }) =>
    capabilities.engine().snapshot(null, false)
  );
```

Append `.use(extension)` in `src/api.ts`. Each independently constructed plugin must declare `.use(core)` to obtain its inferred context; importing it only in a parent does not supply TypeScript inference to the child's handlers. Keep the factory's inferred return type.

The alternative is to export the entire torrent API as the dependency. Mounting that route-bearing plugin under an extension's prefix would also mount its torrent routes there. Separating `core` from `coreApi` gives extensions capabilities without rebasing core routes. A public-API regression checks this composition.

## Future third-party capabilities

The current getters are an internal integration surface for trusted Bun code, not a stable third-party SDK. Before external distribution, expose selected torrent operations through a typed facade instead of raw engine/service instances. Keep request and response contracts in `src/types.ts`; exclude engine shutdown, native SDK handles, raw WebTorrent objects and credential records.

Jev should expose a separate route-free capability backed by the existing automation service. Evaluation must reuse its credential handling, cache, quota and cancellation. Check enablement on every call; disabling a plugin must cancel in-flight work. A required Jev evaluation should report that Jev is disabled, while optional callers can deliberately choose local matching. HTTP plugin composition alone does not make a new discovery source available: source contracts and provider dispatch would also need to become extensible.

Register plugin routes once and gate their operations through service state. Elysia has no plugin uninstall contract. Core HTTP/session protection stays on the host; Elysia hook scope is not a sandbox for in-process code. A loader, installation system and capability permissions remain separate future work.

The dependency pattern follows [Elysia's explicit plugin composition](https://elysiajs.com/essential/plugin). This project uses the Elysia 2 lifecycle names and scopes documented in the [Elysia 2 migration notes](https://elysiajs.com/blog/elysia-20).
