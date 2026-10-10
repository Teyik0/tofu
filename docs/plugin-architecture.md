# Elysia plugin composition

`src/server.ts` owns the final Elysia root and installs `desktopApp()` before mounting the application. `src/api/index.ts` composes exported Elysia plugins with `.use(settings)`, `.use(dashboard)`, `.use(anilist)` and the other feature modules. Existing HTTP paths and Furin client inference remain unchanged. Durable services start through the desktop plugin's lifecycle hooks, not during route registration.

`src/api/lib/services.ts` exports the shared `services` object. Its getters resolve the running engine, automation, updates and native host when a handler needs them. Modules import it directly, and reuse the global journal configuration from `src/sync.ts`. Registering a plugin never constructs another engine or opens another database. There are no API or dependency factories in application code.

An application-authored extension can reuse the shared services directly:

```ts
import { Elysia } from "elysia";
import { services } from "./api/lib/services";

export const extension = new Elysia({
  name: "plugin-example",
  prefix: "/api/plugins/example",
})
  .get("/torrents", () => services.engine.snapshot(null, false));
```

Append `.use(extension)` in `src/api/index.ts`. Service imports retain their TypeScript inference without Elysia context decoration or injected argument objects.

Importing services does not rebase application routes under an extension's prefix. The alternative, injecting getters through plugin factories, adds constructors and argument plumbing to every feature. Request-local overrides now live only in `tests/api-fixture.ts`, where concurrent tests still exercise real engines and journals without replacing the production architecture. Public-API regressions check direct composition and simultaneous peer transfers between isolated fixtures.

## Future third-party capabilities

The current getters are an internal integration surface for trusted Bun code, not a stable third-party SDK. Before external distribution, expose selected torrent operations through a typed facade instead of raw engine/service instances. Keep request and response contracts in `src/types.ts`; exclude engine shutdown, native SDK handles, raw WebTorrent objects and credential records.

Jev should expose a separate route-free capability backed by the existing automation service. Evaluation must reuse its credential handling, cache, quota and cancellation. Check enablement on every call; disabling a plugin must cancel in-flight work. A required Jev evaluation should report that Jev is disabled, while optional callers can deliberately choose local matching. HTTP plugin composition alone does not make a new discovery source available: source contracts and provider dispatch would also need to become extensible.

Register plugin routes once and gate their operations through service state. Elysia has no plugin uninstall contract. Core HTTP/session protection stays on the host; Elysia hook scope is not a sandbox for in-process code. A loader, installation system and capability permissions remain separate future work.

Routing uses [Elysia's plugin composition](https://elysiajs.com/essential/plugin). This project uses the Elysia 2 lifecycle names and scopes documented in the [Elysia 2 migration notes](https://elysiajs.com/blog/elysia-20).
