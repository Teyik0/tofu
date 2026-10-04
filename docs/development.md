# Development

## Runtime and builds

Use Bun for all commands. `bun run setup` prepares the Electrobun SDK through Hutch and installs the prebuilt WebTorrent native addon. No separate torrent service is required.

`bun run build:desktop` creates `build/dev-macos-arm64/Tofu-dev.app` on Apple Silicon. Quit Tofu before replacing an installed development build. Settings and downloads live in your user folders.

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

Shared application types live in `src/types.ts`. Source plugins and automation also run in Bun and hand selected downloads to the existing engine.

The UI uses official shadcn components with Base UI and the `base-nova` style in `components.json`. RSS feeds use `Bun.XML.parse`, available since Bun 1.4; Tsundere uses JSON. No external XML parser is needed.

Furin routes share the persistent `AppShell` layout. `/library` opens the default destination, `/library/all` shows every torrent, and `/library/destinations/:id` opens a destination. Pages use deferred loaders for initial details and Furin query caching for subsequent reads.

A Bun relay publishes engine invalidations through Furin Sync every second. Engine writes are batched every five seconds; actions and shutdown save immediately. WebTorrent actions and native dialogs use `sync: false` because their side effects cannot be replayed as SQL transactions. The engine survives UI hot reloads; restart the server after changing engine code.

## Dependencies

Furin is installed from the registry at an exact version. Keep `package.json` and `bun.lock` together; no local Furin checkout is required. Eden is pinned through an override for compatibility with Furin Sync.

WebTorrent native addons remain external during bundling. `runtime/node_modules` is packaged with the desktop application. The Electrobun SDK stays external during the Furin build and is resolved from `.hutch/devkit` during the native build.

`src/server/webtorrent-stats.ts` bridges tracker and wire information for **WebTorrent 3.0.21**. Rerun tracker and peer tests when updating the engine.

## Files and statistics

Pause removes the torrent from the active engine while preserving its storage. Resume recreates it from saved metadata and files. Changing trackers also rebuilds discovery without deleting downloaded data.

Downloads keep the folder structure declared in their torrent. Changing a destination affects future additions unless the user explicitly requests a move. Removal deletes torrent files only when requested, preserving unrelated and shared files. Conflicting downloads cannot write the same file simultaneously.

Unknown statistics remain `null` in the API and `—` in the UI. Tracker swarm counts are not summed, since trackers may describe overlapping peers. Speed charts show session traffic. Transfer totals include BitTorrent protocol messages, so traffic can continue after file progress reaches 100%.

## Data and configuration

On macOS, state lives in `~/Library/Application Support/Tofu/`:

| File | Contents |
| --- | --- |
| `tofu.sqlite` | Torrent state and preferences |
| `feeds.sqlite` | Plugins, credentials, automation, and AniList tracking |
| `sync.sqlite` | Furin Sync journal |
| `server.json` | Address of the running instance |

Downloads initially use `~/Downloads/Tofu/`. Other systems store application state in `~/.local/share/Tofu`.

Optional environment variables: `TOFU_DATA_DIR`, `TOFU_DOWNLOAD_DIR`, `TOFU_PORT`, `TOFU_MODE=server|desktop`, and `HUTCH_HOME`. Saved download preferences override the initial `TOFU_DOWNLOAD_DIR`. Hutch uses `.cache/hutch` unless configured otherwise.

## Validation

Run the commands listed in the [README](../README.md) after changes. Integration tests exercise public APIs with real TCP peers, HTTP trackers, and temporary directories, including pause/resume, persistence, priorities, removal, relocation, and repair of damaged data.

The native test launches the actual `.app` with temporary state. It checks forms, keyboard navigation, live updates, drag and drop, transfers, and downloaded SHA-256 hashes. Its report is `.cache/native-smoke.json`. Test injection is opt-in through `TOFU_SMOKE_SCRIPT`; normal launches never inject a test script.

Additional native workflows:

```sh
TOFU_NATIVE_WORKFLOW=anilist bun run test:native
TOFU_NATIVE_WORKFLOW=destination bun run test:native
bun run bench:ui furin-sync
```

The benchmark measures selection latency during four local transfers and checks cached details with delayed API responses. Close the normal app before native tests and reopen it afterward with `bun run desktop`.

## Current limits

Only macOS Apple Silicon has been validated. Windows/Linux builds are unvalidated. WebTorrent supports BitTorrent v1; v2-only torrents are unsupported. TCP is enabled and uTP is disabled. Plugins are built in; third-party plugin loading and configurable proxies are not implemented.

Local transfer tests validate behavior, not Internet swarm throughput. See [BENCHMARK.md](../BENCHMARK.md) for the separate comparison with WebTorrent Desktop and its limitations.
