# Changelog

Notable changes to Tofu are tracked here. Release tags follow the version in package.json.

## [0.2.2]

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

- Prevent large AniList libraries from exceeding deferred route-frame limits by loading list state through ordinary JSON transport while keeping torrent details deferred.
- Search anime romaji titles first and fall back to English when no release passes matching requirements, consistently across previews, baseline exclusions and scheduled automation checks.
- Exclude Jev matches below 75% confidence from previews and automation decisions while retaining explicit review for uncertain eligible matches.
- Preserve option drafts and unsaved plugin credentials across section navigation, and return to the originating workspace when leaving either route family.
- Keep saved theme preferences available during server rendering and propagate preference changes across windows without a separate theme bootstrap script or JavaScript media listener.
- Align CI and release builds on Bun 1.4.3, matching the minimum version required by `bun check`.
- Run Furin and Electrobun CLI entrypoints directly with Bun to bypass Windows binary launcher remapping failures.
- Generate Furin route and asset declarations before type checking on clean checkouts, without starting the development server.

## [0.2.1]

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

## [0.2.0]

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
