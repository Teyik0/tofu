# Project rules

These rules apply throughout the repository, to both new files and changes to existing code.
Always use ponytail skills when starting a feature.

## Async syntax

- Use `async` / `await` for all promise sequencing. Never use `.then()`.
- Never use promise `.catch()` or `.finally()` chains.
- Preserve concurrency explicitly: reserve operation queues before the first `await`, and use `await Promise.all(...)` or `await Promise.allSettled(...)` for independent work.

## No routine try/catch

- Do not use `try` / `catch` in business logic or for normal control flow. Expected API failures are returned as typed `problem(...)` or `status(...)` results and propagated directly.
- Catch an exception only at the external I/O, native SDK, worker, or process boundary that must translate it into a typed failure or report an otherwise unobserved error. Catching merely to rethrow, return a default, or hide a broken invariant is prohibited.
- Register resource cleanup when acquiring the resource. Prefer `using`, `await using`, or `AsyncDisposableStack` over handwritten nested cleanup and error-collection loops when they preserve dependency order and concurrency.
- Use `try` / `finally` only when it is necessary to release a resource, reservation, or listener that cannot use the disposal mechanisms above.
- Never move exception handling into a helper, factory, class, or proxy merely to hide it. Any remaining catch must have a concrete boundary or cleanup requirement that can be explained from its call site.

## Returned API errors

- Never throw errors to express API failures. Return Elysia's typed `problem(...)` or `status(...)` responses so Elysia and Eden can infer the failure status and body.
- Apply this rule to route handlers and the services and processing functions they call. Propagate returned failures explicitly through every caller; never discard a failure and return a success response.
- Preserve inferred return types and literal status codes. Do not widen failure results into `unknown`, `Response`, or a generic status type at the API boundary.
- Worker transport must preserve returned failures and reconstruct Elysia status responses in the receiving process; do not turn returned API failures into rejected promises.
- Unexpected runtime exceptions still require resource cleanup and diagnostics; thrown exceptions do not establish a typed API error contract.
- This rule concerns producing API responses. Route loaders must still throw received Eden errors and use Furin's `notFound()` as required below.
- Reference: https://elysiajs.com/essential/handler#status

## No function wrappers

- Never create a function that simply wraps a call, a configuration object, or a construction chain. Write that code directly where it is used.
- Do not move this indirection into a helper, a factory, a class, or a proxy. Renaming a wrapper does not make it acceptable.
- Do not extract code merely to give it a name or avoid repeating a few lines. Prefer direct code.
- Functions that perform actual processing are allowed; function wrappers are prohibited.

Prohibited:

```ts
export function createSync(db: TofuDatabase) {
  return {
    adapter: drizzleSyncAdapter({ db, namespace: "tofu" }),
    principal: () => "local",
  };
}

const sync = createSync(db);
```

Required, directly where the database is available:

```ts
const sync = {
  adapter: drizzleSyncAdapter({ db, namespace: "tofu" }),
  principal: () => "local",
};
```

## Elysia plugins

- Always declare plugins directly as constants using `new Elysia()` and chain their configuration.
- Never create plugin or application factories: no `createApi`, `createDashboardApi`, `createServer`, or equivalents under other names.
- Do not wrap a plugin declaration in a function to inject its configuration.
- Keep direct exports and infer types from the constants.

```ts
export const plugin = new Elysia({ name: "tofu-plugin" })
  .use(contextPlugin)
  .get("/example", handler);

export type Plugin = typeof plugin;
```

## Elysia application composition

- `api/index.ts` declares the API plugin as `apiPlugin` and composes API routes inside `.group("/api", ...)`.
- `server.ts` declares the root application directly with `new Elysia()`, installs `desktopApp()` first, then uses `apiPlugin` and Furin. It exports the root as default and owns listening and process shutdown. Do not introduce an `app.ts` entry or an application factory.
- Keep desktop host initialization, network admission and lifecycle hooks on the root application in `server.ts`, before route plugins install wrappers.
- The server-side Eden client dispatches directly to `apiPlugin`; network requests enter through the root application and its desktop network guards. Do not add another HTTP listener or custom client transport.
- Preserve inferred API types from the route plugins. Initialize dependencies and mount routes before listening.

## No interfaces that mirror implementations

- Never introduce an interface that merely copies a class's public methods or properties. Use the class's instance type directly.
- Infer function and method result types with `ReturnType<typeof functionOrMethod>`, using `Awaited` for asynchronous results, instead of maintaining duplicate result interfaces.
- Do not create large service or port interfaces solely to wrap an existing implementation's type.
- Interfaces for inputs, options, and configuration are allowed.

Prohibited:

```ts
interface TorrentEnginePort {
  pause(id: string): Promise<{ ok: boolean }>;
  resume(id: string): Promise<{ ok: boolean }>;
  close(): Promise<void>;
}

let engine: TorrentEnginePort | null = null;
```

Use the class directly:

```ts
let engine: TorrentEngine | null = null;
```

Or infer the result of its initialization method:

```ts
type Engine = Awaited<ReturnType<typeof TorrentEngine.open>>;

let engine: Engine | null = null;
```

Input interfaces remain valid:

```ts
interface TorrentEngineOptions {
  dataDir: string;
  downloadPath: string;
}
```

## Isomorphic Eden client: mandatory and protected

- Never modify `src/lib/client.ts` unless the user explicitly requests a change to that file. Architecture, startup, AOT, and desktop fixes do not authorize changing it.
- The server branch must remain `treaty(apiPlugin).use(furinSync).api`, with direct in-process Eden dispatch and no network request. The separate root application handles network admission; direct server-side dispatch to the API plugin is intentional.
- The browser branch must use `treaty<Api>(window.location.origin, { fetch: { cache: "no-store", credentials: "include" } }).use(furinSync).api`.
- Never add a custom `fetcher`, manual `app.handle()` dispatch, an internal HTTP origin, request-scoped `AsyncLocalStorage`, or cookie/origin/header forwarding for this client.

Required implementation:

```ts
import { treaty } from "@elysia/eden";
import { createIsomorphicFn } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/client";
import { type Api, apiPlugin } from "@/api";

export const api = createIsomorphicFn()
  .server(() => treaty(apiPlugin).use(furinSync).api)
  .client(
    () =>
      treaty<Api>(window.location.origin, {
        fetch: { cache: "no-store", credentials: "include" },
      }).use(furinSync).api,
  )();
```

## Route loaders and the Eden client

- All route loaders must use the shared isomorphic Eden client from `src/lib/client.ts` directly for API reads.
- Destructure `{ data, error }` from each Eden response. Check `error` in the loader and throw the original error when present before using or returning `data`.
- When a missing resource should render a 404 page, check `error.status === 404` directly and call Furin's `notFound()` inside the loader. Throw the original error for other statuses.
- Never wrap Eden reads in helpers, service functions, or generic response-unwrapping functions. Call the typed endpoint directly.
- Never introduce wrappers to read, extract, normalize, classify, or rethrow the typed client's errors. Handle the typed error directly where the request is made.
- Apply the same direct error handling to each response when a loader performs multiple or deferred reads.

Required pattern:

```ts
import { defineRootRoute } from "@teyik0/furin";
import { api } from "../lib/client";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(async () => {
    const { data, error } = await api.state.get.live({
      query: { detail: "false" },
    });
    if (error) {
      throw error;
    }
    return { dashboard: data };
  });
```

For a resource that should render a 404 page:

```ts
const { data, error } = await api.torrents({ id: params.id }).get.live();
if (error) {
  if (error.status === 404) {
    notFound({ message: "This torrent does not exist" });
  }
  throw error;
}
return { torrent: data };
```

## Startup

- Required dependencies must be initialized and validated before the server starts listening or the interface opens.
- Initialization failures must prevent the application from opening and release resources that have already been initialized.
- Do not work around startup order with a deferred adapter or a wrapper that waits for dependencies on every call. Resolve the initialization order directly.

## English throughout the repository

- Use English for all project-authored content throughout the repository, including documentation, agent instructions, comments, identifiers, UI text, accessibility labels, errors, logs, scripts, tests, and configuration descriptions.
- Translate existing non-English project-authored content into English when editing it. Write all new content in English.
- Preserve proper names, external API contracts, user-provided data, and third-party content as required for correctness. Do not translate machine-readable values whose meaning depends on their exact spelling.

## Integration tests

- Keep only essential integration scenarios. Exercise API behavior through typed Eden endpoints with real application services; do not add function unit tests, component snapshots, or tests of framework internals.
- Test torrent transfers and lifecycle behavior with real peers in temporary directories. Simulate external providers only at their HTTP or native SDK boundaries.
- Put shared fixtures, resource cleanup, and assertion helpers in `tests/helpers/`. Keep endpoint calls visible in the tests rather than wrapping them in request helpers.
- Keep AniList tests in `tests/anilist/` and omit redundant `anilist-` filename prefixes.
- The overall runtime codebase should not be affected by testing. Don't make the code write unnecessary export function / config files for testing purpose.
