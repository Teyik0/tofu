# Changelog

Notable changes to Tofu are tracked here. Release tags follow the version in package.json.

## [Unreleased]

### Changed

- Rebuild the integration suite around 15 essential API scenarios with real server processes, local peers, HTTP provider fixtures, and shared resource cleanup; cover missing-file recovery across restarts and remote permissions.
- Update the vendored Furin core and Electrobun packages to PR #163 revision `f272df9`, isolating route discovery imports before AOT while retaining the local AOT process-isolation patch.
- Move stable release builds, signing, artifact preparation, and publication into GitHub Actions; use `bun run build` for local desktop builds.

## [0.2.7] - 2026-10-19

### Added

- Audio and subtitle track menus, keyboard seeking, and seek feedback in the media player.
- Live desktop update download progress in the sidebar and Updates panel.

### Changed

- Replace the torrent table with a compact list beside a persistent detail inspector on desktop, stacking the panels on smaller screens. Adapt file priorities, actions, and detail controls to the narrower inspector.
- Show destination paths in All torrents and search by torrent name, destination name, or path.
- Check desktop updates through the native update manifest when available, avoiding GitHub API rate limits.

### Fixed

- Open completed media with file caching for local playback.
- Limit Windows CI integration tests to two concurrent processes and allow more time for watch-mode server startup.
- Wait for completed disk writes and seeding verification in storage deletion and AniList download tests.

## [0.2.6] - 2026-10-18

### Added

- In-app media playback with VLC compiled to WebAssembly, including seeking, volume, fullscreen, embedded subtitles, and a system-player fallback.
- Stream incomplete torrent files through byte-range requests that wait for verified pieces without changing saved file priorities.
- Persistent local JSONL diagnostics for startup, shutdown, API mutations and failures, background services, and torrent storage errors, with credential redaction and 5 MiB rotation retaining three backups.
- An **Open logs folder** action in general desktop settings, and original filesystem error codes, stacks, and expected and observed directory identities in storage diagnostics.

### Fixed

- Bound media response sizes and the player's media cache to limit memory use during playback, and cancel pending streaming reads when transfers stop or become unavailable.
- Limit Windows release tests to two concurrent processes and install publisher dependencies before running the release script.

## [0.2.5] - 2026-10-13

### Added

- Torrent storage validation with **Repair download** and **Locate files** actions, preserving paused state and reporting missing, inaccessible, or replaced destinations without recreating them automatically.
- Download settings for deleting successfully imported `.torrent` files and controlling seeding connections, plus peer connection diagnostics.
- Source registration and automation integration APIs with persisted configuration, rule revisions, and retryable execution.

### Changed

- Compose database, torrent, automation, AniList, discovery, plugin, Jev, and update services through Elysia plugins, replacing the central application host with explicit dependency and lifecycle ownership.
- Separate automation policy and persistence from release discovery and execution, and keep management endpoints separate from service plugins.
- Reorganize AniList library controls, cards, episode panels, and list editing, with improved release matching.
- Use Elysia typed problem responses for API failures and Furin's native workflow runner for desktop smoke checks.
- Publish torrent telemetry only while a browser is subscribed, while retaining background persistence, storage checks, and state-change notifications.

### Fixed

- Drain torrent storage before bounded network shutdown so transfer state persists cleanly.
- Dispose initialized resources after startup failures and route-type generation, and preload the native host for desktop builds.

## [0.2.4] - 2026-10-11

### Added

- Global search with `Cmd+K` / `Ctrl+K` across torrents, destination threads, and enabled release sources, with release review and destination selection before downloading.
- AniList list editing with queued autosave for status, progress, score formats, custom lists, advanced scores, dates, notes, repeat counts, and favorites.
- Cover-derived AniList preview colors, list status indicators, unread airing counts, multiple-format catalog filters, and episode downloads without adding anime to a personal list.
- Plugin credential validation and links to API key pages; C411 accepts either an API key or a Torznab URL.
- Short synthesized sound cues when torrents are added or removed.

### Changed

- Default new automation rules to 1080p/720p, H.264/H.265, and VOSTFR/MULTI preferences.

### Fixed

- Match multi-part anime releases against episode offsets from library history, and recognize more parenthesized episode numbers and French subtitle patterns in feeds.

## [0.2.3] - 2026-10-10

### Fixed

- Allow prepared desktop updates to restart after torrent state is saved, without Furin's ordinary quit handler cancelling the native update handoff.
- Cover update handoff through the real Furin desktop host with a real peer transfer and verify downloaded bytes survive engine shutdown and reopening.
- Bundle the native host's torrent parser so installed apps start without repository dependencies, and run native smoke tests from an isolated copy of the application.

## [0.2.2] - 2026-10-10

### Added

- Public AniList catalog browsing without an account, with search, pagination, grid and list views, and sorting by popularity, score, trending, favorites, date added and release date.
- AniList filters for included and excluded genres and tags, airing status, country, source material, streaming providers, release years, episode counts, duration and doujin titles.
- Anime hover previews with studio information, scores, formats, genres and next-episode countdowns based on actual airing timestamps, with season and partial-date fallbacks.
- Persistent AniList list caching for immediate local reads and offline access, shared concurrent refreshes, background stale refreshes and retry backoff after provider failures.
- Public API coverage for the isolated torrent engine, AniList cache and catalog, Jev title fallbacks, API composition, theme rendering and section routes; opt-in native workflows for preferences, themes and catalog navigation.

### Changed

- Run WebTorrent in a dedicated Bun Worker behind a typed command bridge, keeping dashboard and health reads responsive during peer handshakes while retaining real statistics and durable lifecycle behavior.
- Move application persistence to typed Drizzle tables over Bun SQLite, with idempotent migrations that preserve existing databases, preferences, credentials, transfers and legacy thread data.
- Declare Sync configuration in `src/sync.ts` and use Furin's native Drizzle adapter, preserving the existing journal file and namespace and supporting transactional SQL mutations.
- Organize the API into feature modules with HTTP handlers, validation models and services, shared infrastructure under `src/api/lib`, and direct Elysia plugin composition instead of API factories and repeated dependency wrappers. Declare the shared `/api` prefix once on the root API plugin.
- Reuse one isomorphic API client: direct Eden plugin transport on Bun and same-origin credentialed requests in the browser. Page loaders call the client and check responses directly, without page-data wrappers.
- Render all torrents directly at `/`, move individual threads to `/thread/:id`, and keep AniList at `/anilist`, removing the redundant library directory and home redirect.
- Split Options into General, Appearance, Downloads and Updates routes under `/options`, and Plugins into Installed, Sources, Intelligence and Integrations routes under `/plugins`.
- Keep navigation and unsaved drafts in persistent Options and Plugins layouts while mounting only the active section's controls. Remove hidden-panel monoliths and the application shell's eager plugin-editor import.
- Use a shared theme provider initialized from saved dashboard preferences. Resolve light, dark and system appearance through the document's `data-theme` attribute and CSS, including before hydration and after system appearance changes.
- Consolidate native app metadata, associations, icons, signing and packaging settings in `furin.config.ts`, removing redundant root Electrobun and Hutch configuration files and the custom build wrapper.
- Call the Furin Electrobun CLI directly for desktop development and builds, with separate Tofu resource preparation and release installer naming. Use its generated bundle and artifact directories directly, and package the isolated worker with Bun's file loader and a single native dependency installation.
- Delegate desktop loopback restrictions and native session protection to Furin Electrobun instead of maintaining a duplicate application request guard.
- Move all artwork, source images, proposals and native icon sizes into `public`, update configuration and icon-generation paths, and remove the extra `assets` directory.
- Use `bun check` for repository type checking and update developer documentation for the new API, persistence, Worker and route structure.

### Fixed

- Build release bundles before type checking and testing so clean runners have the Electrobun Hutch SDK available.
- Prevent large AniList libraries from exceeding deferred route-frame limits by loading list state through ordinary JSON transport while keeping torrent details deferred.
- Search anime romaji titles first and fall back to English when no release passes matching requirements, consistently across previews, baseline exclusions and scheduled automation checks.
- Exclude Jev matches below 75% confidence from previews and automation decisions while retaining explicit review for uncertain eligible matches.
- Preserve option drafts and unsaved plugin credentials across section navigation, and return to the originating workspace when leaving either route family.
- Keep saved theme preferences available during server rendering and propagate preference changes across windows without a separate theme bootstrap script or JavaScript media listener.
- Align CI and release builds on Bun 1.4.3, matching the minimum version required by `bun check`.
- Run Furin and Electrobun CLI entrypoints directly with Bun to bypass Windows binary launcher remapping failures.
- Finalize SQLite prepared statements when their owning service shuts down, releasing Windows file locks before temporary directory cleanup.
- Wait for the hot reload test's readiness file before reading it to avoid startup races on slower CI runners.
- Preserve LF endings in GraphQL snapshots so Windows checkouts retain their recorded checksums.
- Temporarily skip blocked-request cancellation tests on Windows because Bun 1.4.3 can crash during their teardown; retain coverage on macOS and Linux.
- Generate Furin route and asset declarations before type checking on clean checkouts, without starting the development server.

## [0.2.1] - 2026-10-10

### Added

- Native source development with React/CSS HMR and controlled backend restarts through Furin Electrobun.
- In-app desktop update downloads and restart installation through Electrobun, with torrent state persistence and recovery when the update helper fails.
- Sidebar tab deletion with confirmation and an explicit Shift-click shortcut, including support for deleting the default tab while preserving torrents and automation rules.

### Changed

- Use local core and Electrobun packages from Furin PR #163: Furin packages and guards the in-process backend, while Tofu retains native menus, background transfers, protocol handling and update recovery.

### Fixed

- Jev activation without an API key now shows an inline error and focuses the credential field; activation and deactivation preserve saved credentials.
- Plugins navigation responds while route data loads and preserves the selected section and return destination.
- AniList episodes and watched controls remain available while release discovery runs; full release titles appear in accessible tooltips.
- Native AniList links open in the system browser without leaving the episode dialog.
- Release publication validates native update metadata and archives for every supported target.

## [0.2.0] - 2026-10-07

### Added

- AniList library page with a cover grid, saved status filters, search, and an episode modal that searches torrent sources, shows release variants, and downloads with live progress.
- Per-episode watched marks that write consecutive progress to AniList, plus a per-anime Automation tab for source, quality, and destination overrides.
- AniList sign-in without a client secret through the implicit grant and the `tofu://oauth/anilist` scheme, registered per platform.
- Dedicated Plugins and Settings pages with their own navigation and back behavior.
- Opening `.torrent` files and magnet links with Tofu, including **Set as default torrent app** on macOS; reopening an existing torrent preserves its destination and paused state.
- Destination context menus with custom icons and pinned threads in the collapsed sidebar.
- Release pipeline for Windows x64 and Linux x64/ARM64 alongside macOS ARM64, with parallel native runners, dependency caching, and free ad hoc signing.

### Changed

- Release checks and installer downloads use the GitHub API anonymously on the now-public repository, with no access token.

### Fixed

- Release publication validates the repository before checking installers.

## [0.1.0] - 2026-10-04

### Added

- Torrent downloads under Bun/WebTorrent with real transfer, peer and tracker statistics.
- Destination tabs, optional relocation of existing files, and explicit errors for missing files and operations in progress.
- Persistent settings, priorities, trackers, pause/resume, verification, and explicit opt-in file deletion.
- Isolated development and release profiles, native identities and download folders, with database ownership and exclusive process locks.
- Source plugins, AniList subscriptions, discovery, and download automations.
- macOS menu-bar icon and optional background mode that releases the native window and WebView while keeping transfers and automations running.
- Authenticated private GitHub release checks, native notifications and installer downloads.
- macOS Apple Silicon release pipeline with optional Apple signing and notarization.
- English interface and documentation, Base UI components, and Bun's native XML parser for feeds.
- MIT license, contribution and security policies, repository templates and Git hooks.

[Unreleased]: https://github.com/Teyik0/tofu/compare/v0.2.7...HEAD
[0.2.7]: https://github.com/Teyik0/tofu/releases/tag/v0.2.7
[0.2.6]: https://github.com/Teyik0/tofu/releases/tag/v0.2.6
[0.2.5]: https://github.com/Teyik0/tofu/releases/tag/v0.2.5
[0.2.4]: https://github.com/Teyik0/tofu/releases/tag/v0.2.4
[0.2.3]: https://github.com/Teyik0/tofu/releases/tag/v0.2.3
[0.2.2]: https://github.com/Teyik0/tofu/releases/tag/v0.2.2
[0.2.1]: https://github.com/Teyik0/tofu/releases/tag/v0.2.1
[0.2.0]: https://github.com/Teyik0/tofu/releases/tag/v0.2.0
[0.1.0]: https://github.com/Teyik0/tofu/releases/tag/v0.1.0
