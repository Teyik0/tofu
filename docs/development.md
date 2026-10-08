# Development

## Runtime and builds

Use Bun for all commands. `bun run setup` prepares the Electrobun SDK through Hutch and installs the prebuilt WebTorrent native addon. No separate torrent service is required.

`bun run dev:desktop` starts the native app from source with React/CSS HMR, retaining the window and component state. Backend and native host edits perform a controlled restart and restore persisted transfers; unsaved UI state across that restart is not preserved. Quit with Ctrl-C. `bun run test:hmr` verifies this flow in the real WebView with temporary data and real peers.

`bun run build:desktop` builds for the current OS and architecture. `bun run desktop` launches its native executable:

| Target | Development bundle |
| --- | --- |
| macOS ARM64 | `build/dev-macos-arm64/Tofu-dev.app` |
| Windows x64 | `build/dev-win-x64/Tofu-dev/` |
| Linux x64 | `build/dev-linux-x64/Tofu-dev/` |
| Linux ARM64 | `build/dev-linux-arm64/Tofu-dev/` |

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
React + Furin → local Elysia API → WebTorrent under Bun
                                      ├── peers and trackers
                                      ├── downloaded files
                                      └── SQLite
Electrobun → native window, dialogs, and app lifecycle
```

The torrent engine lives in the Bun process, so downloads outlast HTTP requests. The browser displays state and sends actions. The same API supports desktop and web modes. Electrobun RPC is an alternative, but would require a second transport for web access.

The optional Furin Electrobun package builds the inert application and starts its guarded backend in the SDK process. `furin.desktop.config.ts` selects Tofu's native host for trays, background windows, protocols and updates. Desktop SSR forwards the incoming session to the same local API; initialization and disposal use the artifact's lifecycle hooks. See the [integration report](furin-electrobun-preview.md).

Shared application types live in `src/types.ts`. Source plugins and automation also run in Bun and hand selected downloads to the existing engine.

The UI uses official shadcn components with Base UI and the `base-nova` style in `components.json`. RSS feeds use `Bun.XML.parse`, available since Bun 1.4; Tsundere uses JSON. No external XML parser is needed.

Furin routes share the persistent `AppShell` layout. `/library` opens the default destination, `/library/all` shows every torrent, and `/library/destinations/:id` opens a destination. Pages use deferred loaders for initial details and Furin query caching for subsequent reads.

A Bun relay publishes engine invalidations through Furin Sync every second. Engine writes are batched every five seconds; actions and shutdown save immediately. WebTorrent actions and native dialogs use `sync: false` because their side effects cannot be replayed as SQL transactions. The engine survives UI hot reloads; restart the server after changing engine code.

## Dependencies

Furin core and Electrobun currently use pinned local PR #163 archives under `vendor/`. Keep the archives, `package.json` and `bun.lock` together; no local Furin checkout is required. [Provenance and checksums](../vendor/README.md) identify the upstream commit.

WebTorrent native addons remain external during bundling. `runtime/node_modules` is packaged with the desktop application. The Electrobun SDK stays external during the Furin build and is resolved from `.hutch/devkit` during the native build.

`src/server/webtorrent-stats.ts` bridges tracker and wire information for **WebTorrent 3.0.21**. Rerun tracker and peer tests when updating the engine.

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
| `tofu.sqlite` | Torrent state and preferences |
| `feeds.sqlite` | Plugins, credentials, automation, and AniList tracking |
| `sync.sqlite` | Furin Sync journal |
| `server.json` | Address of the running instance |
| `release-access.json` | Update check state (last notified version) |
| `instance.json` | Persistent ownership by dev or release |
| `instance.lock` | OS lock held while this instance runs |

The native profile comes from the packaged Electrobun channel, independently of `NODE_ENV` or terminal variables. `bun run dev` forces the development profile. Compiled web builds also use dev unless explicitly started with `TOFU_PROFILE=release bun run start`. Native releases ignore `TOFU_PROFILE` and stay on their packaged profile. Linux state roots are `~/.local/share/Tofu-dev` and `~/.local/share/Tofu`. Windows uses `%APPDATA%/Tofu-dev` and `%APPDATA%/Tofu`, falling back to `~/AppData/Roaming` when `APPDATA` is unset. Existing custom directories remain available through `TOFU_DATA_DIR`.

Existing data in `Tofu` is preserved for the release; development starts with independent empty state. No torrents, automations or credentials are automatically copied between profiles. Development refuses the production data directory and unclaimed existing databases. A persistent marker prevents switching a custom data directory between profiles, including through a symlink.

Only one server can open a data directory. An exclusive OS lock is acquired before any SQLite database opens, released after shutdown and automatically released after a crash. macOS/Linux use `flock`; Windows holds a non-shared `CreateFileW` handle. Both preserve the lock file and avoid stale PID ownership. Furin build inspection does not open user databases. Stop old builds before first launching a new build with this protection. To use a native instance from a browser, choose the tray action instead of starting another server with the same state.

Optional environment variables: `TOFU_DATA_DIR`, `TOFU_DOWNLOAD_DIR`, `TOFU_PORT`, `TOFU_MODE=server|desktop`, `TOFU_PROFILE=dev|release` for source/web servers, and `HUTCH_HOME`. Custom data directories remain protected by profile ownership and locking. Saved download preferences override the initial `TOFU_DOWNLOAD_DIR`; manually selected download folders remain an explicit user choice. Hutch uses `.cache/hutch` unless configured otherwise. The development-only demo checks the target profile and cannot seed the release accidentally.

Both compiled Furin bundles run in production mode, so `NODE_ENV` cannot distinguish the development app from a release. The packaged channel supplies that identity explicitly. The instance profile, state directory and initial server configuration are fixed for the lifetime of the process, alongside the torrent engine. Hot reload keeps them together. Restart the process after changing their environment variables; a hot reload cannot switch a live development engine to the release database.

## Validation

Run the commands listed in the [README](../README.md) after changes. Integration tests exercise public APIs with real TCP peers, HTTP trackers, and temporary directories, including pause/resume, persistence, priorities, removal, relocation, and repair of damaged data.

`bun run test` runs exactly `bun test --parallel --isolate --bail`, using Bun's CPU-based worker count and a fresh global scope per file. Peers, trackers, HTTP servers and databases use independent temporary folders and available ports. Whole-transfer checks wait for `seeding` rather than merely 100% received bytes, which can precede filesystem writes and verification.

The native test launches the actual platform bundle with temporary state. It checks forms, keyboard navigation, live updates, drag and drop, transfers, and downloaded SHA-256 hashes. Its report is `.cache/native-smoke.json`. Test injection is opt-in through `TOFU_SMOKE_SCRIPT`; normal launches never inject a test script. POSIX permission tests are skipped on Windows; directory alias tests use Windows junctions there.

Additional native workflows:

```sh
TOFU_NATIVE_WORKFLOW=anilist bun run test:native
TOFU_NATIVE_WORKFLOW=destination bun run test:native
bun run bench:ui furin-sync
bun run build:release
bun run test:coexist
bun scripts/native-opening.ts
```

The benchmark measures selection latency during four local transfers and checks cached details with delayed API responses. `test:coexist` launches the real dev and stable bundles simultaneously in temporary folders, checks their profiles despite contradictory terminal variables, downloads from a real peer and verifies that closing dev leaves the release available. Native tests use temporary state and OS-selected ports.

On macOS, the release bundle declares `.torrent` and `magnet` associations through Electrobun's application configuration. The main process receives `open-url` events, queues them until the engine and desktop are ready, and processes them sequentially. WebTorrent remains in Bun; repeated opens preserve an existing torrent's state. The native menu changes defaults only on explicit selection, using Launch Services through Bun FFI rather than editing macOS preference files. Development builds never claim these associations. `native-opening.ts` checks cold file launch, a magnet sent to the running app, and reopening from background mode with real peers; it does not change system defaults and saves `.cache/native-opening.json`.

## Current limits

Only macOS Apple Silicon has been validated. Windows/Linux builds are unvalidated. WebTorrent supports BitTorrent v1; v2-only torrents are unsupported. TCP is enabled and uTP is disabled. Plugins are built in; third-party plugin loading and configurable proxies are not implemented.

Local transfer tests validate behavior, not Internet swarm throughput. See [BENCHMARK.md](../BENCHMARK.md) for the separate comparison with WebTorrent Desktop and its limitations.

## AniList development client

The release AniList client `9037` must register `tofu://oauth/anilist`. Development uses client `52735` with Redirect URL `tofu-dev://oauth/anilist`. Both public IDs are shared by source runs and desktop builds; no secret or environment setup is needed. To use another development application, set `TOFU_ANILIST_CLIENT_ID=<development-client-id>` when building or running from source. Its public ID is packaged in the development bundle. This override never changes the release client or callback.
