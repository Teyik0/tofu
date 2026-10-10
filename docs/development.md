# Development

## Runtime and builds

Use Bun for all commands. `bun run setup` installs the prebuilt WebTorrent native addon and generates Tofu's worker, protocol helper and AniList configuration. The desktop commands call `furin-electrobun` directly; its CLI prepares Hutch, builds Furin and packages the app. Build once before typechecking so the SDK types are available. No separate torrent service is required.

`bun run dev:desktop` starts the native app from source with React/CSS HMR, retaining the window and component state. Backend and native host edits perform a controlled restart and restore persisted transfers; unsaved UI state across that restart is not preserved. Quit with Ctrl-C. `bun run test:hmr` verifies this flow in the real WebView with temporary data and real peers.

`bun run build:desktop` builds for the current OS and architecture. `bun run desktop` launches its native executable:

| Target | Development bundle |
| --- | --- |
| macOS ARM64 | `.furin/electrobun/build/dev-macos-arm64/Tofu-dev.app` |
| Windows x64 | `.furin/electrobun/build/dev-win-x64/Tofu-dev/` |
| Linux x64 | `.furin/electrobun/build/dev-linux-x64/Tofu-dev/` |
| Linux ARM64 | `.furin/electrobun/build/dev-linux-arm64/Tofu-dev/` |

Quit that development build before replacing it. Development and the installed release use separate state, download folders and native app identities, so both can run together. Cross-platform releases use native runners rather than cross-compiling native addons from a Mac.

Linux uses WebKitGTK and needs these runtime packages on Ubuntu 24.04 or newer:

```sh
sudo apt-get install libgtk-3-0t64 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2
```

Windows uses WebView2, and macOS uses WKWebView. CEF is not bundled. Native UI tests require a graphical session; Linux also needs a tray implementation to exercise background mode.

For a compiled web server:

```sh
bun run build
bun run start
```

The server listens on loopback only. Remote access requires a tunnel; network authentication is not implemented.

## Architecture

```text
React + Furin → local Elysia API → dedicated Bun Worker → WebTorrent
                                      ├── peers and trackers
                                      ├── downloaded files
                                      └── SQLite
Electrobun → native window, dialogs, and app lifecycle
```

The torrent engine lives in a dedicated Bun Worker, so downloads outlast HTTP requests and synchronous peer encryption cannot block the API or page rendering. A typed message bridge sends commands and publishes real summary statistics once per second; successful commands include an updated summary. Detailed torrent reads still wait for the engine. Shutdown drains pending commands and saves the engine before terminating the Worker. The browser displays state and sends actions through the same API in desktop and web modes. Electrobun RPC is an alternative, but would require a second transport for web access. Scheduling cryptographic work with `defer` on the API thread would still block that thread.

The optional Furin Electrobun package builds the inert application and starts its guarded backend in the SDK process. The `desktop` section of `furin.config.ts` owns all native configuration and selects Tofu's host for trays, background windows, protocols and updates. Furin generates the SDK configuration in `.furin/electrobun`; no root Electrobun configuration is needed. Initialization and disposal use `desktopApp()` lifecycle callbacks. See the [integration report](furin-electrobun-preview.md).

`src/api/index.ts` composes const feature plugins such as `settingsPlugin`, `torrentPlugin` and `automationPlugin`. Each module imports the const `contextPlugin` and receives a complete `application` in its handlers. Contracts live in `src/types.ts`; handlers stay in `index.ts`, validation in `model.ts`, and business operations in `service.ts`. There are no service forwarding getters or route factories. Factories taking dependencies would also isolate applications, but would require constructing every feature plugin at startup.

`src/api/lib/application-host.ts` owns startup, readiness, shutdown and replacement of the application. `lifecycle.ts` acquires the instance lock, opens the real database and worker, validates readiness, and constructs all mandatory services before publishing the ready state. An `AsyncDisposableStack` releases acquired resources on startup failure and in reverse order on shutdown. Desktop startup supplies the SDK before opening the core, then attaches the native controller before opening the window. The context returns HTTP 503 while starting, stopping or stopped; ready handlers receive required references. A module-global engine with definite assignment would hide these lifecycle states and could retain a closed engine after update recovery. Hot reload retains the host and instance configuration, not a bag of optional services.

The isomorphic client in `src/lib/client.ts` uses the current origin in the browser. On Bun, `apiTransportPlugin` supplies a request-scoped fetcher that dispatches trusted loader calls to the mounted router without a network listener or fabricated session cookie. This shares the root AOT router instead of compiling the API plugin as a second router. Install `desktopApp()` first, followed by the transport plugin, so public requests pass the native and loopback guards before loader calls can use the internal transport. A direct API-plugin client remains available for isolated runtime tests inside an application scope.

Shared application types live in `src/types.ts`. Source plugins and automation also run in Bun and hand selected downloads to the existing engine.

The UI uses official shadcn components with Base UI and the `base-nova` style in `components.json`. RSS feeds use `Bun.XML.parse`, available since Bun 1.4; Tsundere uses JSON. No external XML parser is needed.

Furin routes share the persistent workspace and its Jotai store through `src/pages/root.tsx`. The root loader reads the dashboard once, including saved preferences, instead of using separate document and application loaders. `src/pages/index.tsx` renders all torrents directly at `/`, without a redirect. `src/pages/thread/[id].tsx` scopes downloads to `/thread/:id`, including the default thread at `/thread/default`. AniList remains a direct page at `/anilist`. Options and plugins have their own directories with a Furin `_route.tsx` layout and an `index.tsx` default page. There is no route group or library directory. Page loaders call the shared isomorphic client and unwrap successful responses with `readData` from `src/lib/api-data.ts`. API error handlers use explicit HTTP status responses, keeping error payloads outside success data. HTTP and network failures still reach Furin error boundaries through `ApiRequestError`; the root document also supports rendering errors without loader data. Pages use deferred loaders for initial details and Furin query caching for subsequent reads.

Options use `/options` for General, then `/options/appearance`, `/options/downloads` and `/options/updates`. Plugins use `/plugins` for Installed, then `/plugins/sources`, `/plugins/intelligence` and `/plugins/integrations`. Shared layouts retain navigation, the originating workspace and unsaved form drafts across section changes. Only the active section mounts its controls. The plugins layout owns Formisch stores and passes them to those cards; the application shell does not import the plugin editor. This replaces hidden panels and local tab state with deep links and separately built route modules. The plugin layout reads state through its loader. Successful plugin mutations revalidate `/plugins` as a layout, so Furin refreshes its loader across all plugin sections; the Refresh button also uses the router. This keeps the loader as the source of plugin data without a separate query or saved snapshot. `TOFU_NATIVE_WORKFLOW=preferences bun run test:native` checks native section navigation, draft preservation, saves and returning to the workspace.

`themeAtom` in `src/state/workspace.ts` holds the appearance preference in the isolated root store. The application layout initializes it from the saved dashboard preference; settings update it only after a successful save. Tofu retains its SQLite preferences and Sync updates across windows. The root renders `data-theme="light|dark|system"`, and `src/components/tofu-state-sync.tsx` updates that attribute after preference changes. A shared Tailwind `dark` variant in `src/styles.css` resolves explicit dark mode or system mode under `prefers-color-scheme: dark` for both semantic tokens and shadcn utilities. CSS applies appearance before hydration, including error documents, and follows system changes without a bootstrap script or JavaScript media listener. Resolving a `.dark` class in JavaScript would require both startup code and an ongoing system appearance subscription. `TOFU_NATIVE_WORKFLOW=theme bun run test:native` checks CSS-only appearance and actual shadcn controls in script-disabled documents, saved preferences, and external changes through Sync.

AniList list data is cached in SQLite for five minutes and remains available when the provider is offline. The cache is scoped to the endpoint and account credentials, without storing another copy of the token. Local reads return immediately; `Elysia.defer` starts stale refreshes after the response. The AniList page reads both library and automation state from its typed Furin loader through ordinary JSON transport. Its settings and episode panels use that same state; successful mutations revalidate the page instead of storing response copies or issuing duplicate GETs. The automation modal uses a separate query wrapper because it can open on routes without an AniList loader. Catalog searches, selected torrent details and update status also remain client queries because their data is not fully supplied by the active loader. Using `Furin.defer` for the whole AniList library would encode it as a single Seroval route frame, which can exceed Furin's 1 MiB frame limit even when ordinary JSON is smaller. Torrent details still use deferred loaders. Concurrent list requests share one upstream operation, failed automatic refreshes back off for 30 seconds, and the Refresh button forces a new fetch. AniList chunks stay sequential because `hasNextChunk` determines whether to continue.

`src/api/lib/db.ts` creates all local Drizzle connections using `bun:sqlite`. Torrents, settings, destinations, plugins, automation, Jev cache and AniList state use the typed tables in `src/db/schema.ts`. Services use Drizzle's synchronous query builders and pass the active transaction to their persistence helpers. `src/db/migrations.ts` prepares application tables through Drizzle, preserving existing files, JSON values and legacy destination columns. These idempotent migrations also support installations without a migration journal; rebuilding the tables or introducing a new database file would require copying existing state.

`src/sync.ts` bridges route registration to the real Drizzle adapter built during startup. It waits for the core application instead of constructing a SQLite client during imports. Independent transports can scope the bridge to their own application with `applicationScope.run`; this isolates concurrent fixtures without replacing process globals. Business handlers still receive direct application references. Automation and AniList mutations run synchronous `mutation(tx => ...)` callbacks on the same `feeds.sqlite` connection as the journal, so business writes and replay records commit or roll back together. Provider calls precede the transaction; live state refreshes after commit. Mutation responses contain small deltas, and React uses typed `useMutation` methods.

Startup opens and migrates the database after acquiring the instance lock. Registration stays inert for build inspection; Sync delegates to the validated application adapter once the core is available. Existing `sync.sqlite` records migrate once into `feeds.sqlite`, preserving namespaces, cursors and replay responses; the original file remains intact. A separate journal connection would prevent atomic application writes.

A Bun relay publishes engine invalidations through Furin Sync every second. These updates originate outside HTTP mutations, so they still need explicit publication through the native adapter. Engine writes are batched every five seconds; actions and shutdown save immediately. WebTorrent actions and native dialogs use `sync: false` because their side effects cannot be replayed as SQL transactions. Torrent storage stays in the Bun Worker on its own Drizzle connection; the automation journal transaction does not make Worker writes atomic. The engine survives UI hot reloads; restart the server after changing engine code.

## Dependencies

Furin core and Electrobun currently use pinned local PR #163 archives under `vendor/`. Keep the archives, `package.json` and `bun.lock` together; no local Furin checkout is required. [Provenance and checksums](../vendor/README.md) identify the upstream commit.

WebTorrent native addons remain external during bundling. Furin copies the declared packages and their runtime dependencies from the project's single `node_modules` installation. Bun's file loader emits the prepared worker beside the application bundle, where it resolves those external packages. There is no second installation under `runtime/node_modules`. The Electrobun SDK stays external during the Furin build and is resolved from `.furin/electrobun/.hutch/devkit` during the native build. Release installers and update archives stay in `.furin/electrobun/artifacts`; the release postbuild step only normalizes installer names for the updater.

The torrent worker signals readiness after its imports have loaded and its command listener is installed. The host waits for that signal before opening the engine: Electrobun's bundled Bun can drop messages sent during worker loading. A readiness handshake avoids depending on an arbitrary startup delay.

`src/api/modules/torrents/stats.ts` bridges tracker and wire information for **WebTorrent 3.0.21**. Rerun tracker and peer tests when updating the engine.

## Files and statistics

Pause removes the torrent from the active engine while preserving its storage. Resume recreates it from saved metadata and files. Changing trackers also rebuilds discovery without deleting downloaded data.

Downloads keep the folder structure declared in their torrent. Changing a destination affects future additions unless the user explicitly requests a move. Removal deletes torrent files only when requested, preserving unrelated and shared files. Conflicting downloads cannot write the same file simultaneously.

Unknown statistics remain `null` in the API and `—` in the UI. Tracker swarm counts are not summed, since trackers may describe overlapping peers. Speed charts show session traffic. Transfer totals include BitTorrent protocol messages, so traffic can continue after file progress reaches 100%.

## Data and configuration

On macOS, the profiles are separated automatically:

| | Development | Release |
| --- | --- | --- |
| Application state | `~/Library/Application Support/Tofu-dev/` | `~/Library/Application Support/Tofu/` |
| Initial downloads | `~/Downloads/Tofu-dev/` | `~/Downloads/Tofu/` |
| Native identifier | `app.tofu.torrents.dev` | `app.tofu.torrents` |
| Native title / menu bar | Tofu Dev / DEV | Tofu |
| Web server port | 3030 | 3031 |
| Native HTTP server | Available port selected by the OS | Available port selected by the OS |

Each profile has its own files:

| File | Contents |
| --- | --- |
| `feeds.sqlite` | Torrent state, preferences, plugins, credentials, automations, AniList tracking, and the Furin Sync journal |
| `tofu.sqlite` | Preserved legacy torrent state, imported once into `feeds.sqlite` |
| `sync.sqlite` | Preserved legacy journal, imported once into `feeds.sqlite` |
| `server.json` | Address of the running instance |
| `release-access.json` | Update check state (last notified version) |
| `instance.json` | Persistent ownership by dev or release |
| `instance.lock` | OS lock held while this instance runs |

Startup opens and migrates one shared database before serving requests. Drizzle and Furin Sync reuse the API connection; the torrent worker owns a second SQLite connection to the same file because native connections cannot be transferred between threads. Both use WAL with a bounded busy timeout. Route registration and build inspection do not construct fake SQLite clients or open database files. Legacy files remain untouched after their transactional, one-time imports.

The native profile comes from the packaged Electrobun channel, independently of `NODE_ENV` or terminal variables. `bun run dev` forces the development profile. Compiled web builds also use dev unless explicitly started with `TOFU_PROFILE=release bun run start`. Native releases ignore `TOFU_PROFILE` and stay on their packaged profile. Linux state roots are `~/.local/share/Tofu-dev` and `~/.local/share/Tofu`. Windows uses `%APPDATA%/Tofu-dev` and `%APPDATA%/Tofu`, falling back to `~/AppData/Roaming` when `APPDATA` is unset. Existing custom directories remain available through `TOFU_DATA_DIR`.

Existing data in `Tofu` is preserved for the release; development starts with independent empty state. No torrents, automations or credentials are automatically copied between profiles. Development refuses the production data directory and unclaimed existing databases. A persistent marker prevents switching a custom data directory between profiles, including through a symlink.

Only one server can open a data directory. An exclusive OS lock is acquired before any SQLite database opens, released after shutdown and automatically released after a crash. macOS/Linux use `flock`; Windows holds a non-shared `CreateFileW` handle. Both preserve the lock file and avoid stale PID ownership. Furin build inspection does not open user databases. Stop old builds before first launching a new build with this protection. To use a native instance from a browser, choose the tray action instead of starting another server with the same state.

Optional environment variables: `TOFU_DATA_DIR`, `TOFU_DOWNLOAD_DIR`, `TOFU_PORT`, `TOFU_MODE=server|desktop`, `TOFU_PROFILE=dev|release` for source/web servers, and `HUTCH_HOME`. Custom data directories remain protected by profile ownership and locking. Saved download preferences override the initial `TOFU_DOWNLOAD_DIR`; manually selected download folders remain an explicit user choice. Hutch uses `.cache/hutch` unless configured otherwise. The development-only demo checks the target profile and cannot seed the release accidentally.

Both compiled Furin bundles run in production mode, so `NODE_ENV` cannot distinguish the development app from a release. The packaged channel supplies that identity explicitly. The instance profile, state directory and initial server configuration are fixed for the lifetime of the process, alongside the torrent engine. Hot reload keeps them together. Restart the process after changing their environment variables; a hot reload cannot switch a live development engine to the release database.

## AniList typed SDK

AniList [recommends GraphQL Code Generator](https://github.com/AniList/docs/blob/master/docs/guide/graphql/index.md) rather than an AniList-specific SDK. Tofu uses the official schema to generate an operation-specific SDK with `typescript-operations` and `typescript-generic-sdk`, and uses `graphql-request` for transport on Bun. This is a generated Tofu SDK, not an officially maintained AniList package.

- `src/api/modules/anilist/graphql/schema.graphql` is the complete versioned schema snapshot. `schema-source.json` records its official endpoint, fetch time, and SHA-256 hash.
- `src/api/modules/anilist/graphql/operations.graphql` contains the selected media fragment, catalog queries, account queries, paginated library query, and progress mutation.
- `src/api/modules/anilist/graphql/generated.ts` contains generated input/output types, documents, and SDK methods. It is ignored by Git; never edit it manually.
- `codegen.ts` defines generation and scalar mappings (`CountryCode` → `string`, `FuzzyDateInt` → `number`, `Json` → `unknown`).

The `dev`, `dev:desktop`, `build`, `build:desktop`, `build:release`, `tscheck`, `test`, `test:background`, and `test:coexist` scripts explicitly run `bun run codegen` before consuming source code. This also covers clean CI checkouts without a generated SDK. Commands that only run compiled bundles (`start`, `desktop`) or prepare native resources do not need generation. Generation stays offline and uses the versioned schema and operations; it never refreshes the upstream schema automatically. An unchanged SDK is not rewritten, so repeated generation does not trigger unnecessary hot reloads.

After editing an operation while development is already running, run `bun run codegen` again. To pick up an upstream schema change, explicitly run `bun run codegen:schema`, review the snapshot diff, and regenerate. `bun run codegen:check` is an optional local check that detects missing or stale generated output and invalid operations; CI instead generates the SDK through its build, type-check, and test scripts.

The generated SDK is backend-only. Its request options retain the existing timeout/abort signals and request-scoped authentication; public catalog reads never send the account token. GraphQL errors remain sanitized API errors. Tofu still owns native OAuth callbacks, SQLite caching, account-change protection, and torrent automations. Generated types describe the schema, not runtime validation of arbitrary JSON: nullable fields still need handling, and GraphQL error responses must not be treated as successful partial data.

## Frontend state and validation models

Workspace selection, dialogs, the settings return path and appearance use Jotai atoms in `src/state/workspace.ts`. The Furin root layout creates its store with lazy `useState`, so each server render and each hydrated client application owns an independent store. The saved appearance initializes that store and the server-rendered HTML. A module-level default store would share server state between requests. Sidebar and tooltip providers retain their component-specific behavior.

Formisch owns editable form values, validation and submission state. Plugin form stores live in the plugins layout and are passed to cards, preserving unsaved credentials and limits across section navigation. A successful save clears only the submitted credential and preserves edits made while that request was pending. Creating those stores inside each card would lose inputs when the card unmounts.

Valibot API contracts and related form schemas remain in each API module's `model.ts`; there is no separate schema directory. Frontend forms reuse these pure models, and Elysia consumes them through Standard Schema. Shared application types remain in `src/types.ts`. Numeric request coercion preserves existing decimal input, and torrent upload validation retains the 8 MiB file limit.

The pinned Furin version still requires TypeBox object metadata for dynamic page parameters at build time. The `/thread/:id` page retains its small `t.Object` declaration; its API and form models use Valibot. Switching that page declaration also requires updating Furin's route parameter validation.

## Validation

Run the commands listed in the [README](../README.md) after changes. Integration tests exercise public APIs with real TCP peers, HTTP trackers, and temporary directories, including pause/resume, persistence, priorities, removal, relocation, and repair of damaged data.

`bun run test` first generates the AniList SDK, then runs `bun test --parallel --isolate --bail --timeout 30000`, using Bun's CPU-based worker count and a fresh global scope per file. Peers, trackers, HTTP servers and databases use independent temporary folders and available ports. Whole-transfer checks wait for `seeding` rather than merely 100% received bytes, which can precede filesystem writes and verification.

The native test launches the actual platform bundle with temporary state. It checks forms, keyboard navigation, live updates, drag and drop, transfers, and downloaded SHA-256 hashes. Its report is `.cache/native-smoke.json`. Test injection is opt-in through `TOFU_SMOKE_SCRIPT`; normal launches never inject a test script. POSIX permission tests are skipped on Windows; directory alias tests use Windows junctions there.

Additional native workflows:

```sh
TOFU_NATIVE_WORKFLOW=anilist bun run test:native
TOFU_NATIVE_WORKFLOW=destination bun run test:native
TOFU_NATIVE_WORKFLOW=theme bun run test:native
TOFU_NATIVE_WORKFLOW=plugins bun run test:native
bun run bench:ui furin-sync
bun run build:release
bun run test:coexist
bun scripts/native-opening.ts
```

The benchmark measures selection latency during four local transfers and checks cached details with delayed API responses. `test:coexist` launches the real dev and stable bundles simultaneously in temporary folders, checks their profiles despite contradictory terminal variables, downloads from a real peer and verifies that closing dev leaves the release available. Native tests use temporary state and OS-selected ports.

The plugins workflow delays individual HTTP requests to check optimistic switches, concurrent configuration, API rejection recovery, connection tests, and drafts preserved across section navigation. Its report is `.cache/native-plugins-smoke.json`.

On macOS, the release bundle declares `.torrent` and `magnet` associations through Electrobun's application configuration. The main process receives `open-url` events, queues them until the engine and desktop are ready, and processes them sequentially. WebTorrent remains in Bun; repeated opens preserve an existing torrent's state. The native menu changes defaults only on explicit selection, using Launch Services through Bun FFI rather than editing macOS preference files. Development builds never claim these associations. `native-opening.ts` checks cold file launch, a magnet sent to the running app, and reopening from background mode with real peers; it does not change system defaults and saves `.cache/native-opening.json`.

## Current limits

Only macOS Apple Silicon has been validated. Windows/Linux builds are unvalidated. WebTorrent supports BitTorrent v1; v2-only torrents are unsupported. TCP is enabled and uTP is disabled. Plugins are built in; third-party plugin loading and configurable proxies are not implemented.

Local transfer tests validate behavior, not Internet swarm throughput. See [BENCHMARK.md](../BENCHMARK.md) for the separate comparison with WebTorrent Desktop and its limitations.

## AniList development client

The release AniList client `9037` must register `tofu://oauth/anilist`. Development uses client `52735` with Redirect URL `tofu-dev://oauth/anilist`. Both public IDs are shared by source runs and desktop builds; no secret or environment setup is needed. To use another development application, set `TOFU_ANILIST_CLIENT_ID=<development-client-id>` when building or running from source. Its public ID is packaged in the development bundle. This override never changes the release client or callback.
