# Changelog

Notable changes to Tofu are tracked here. Release tags follow the version in package.json.

## [Unreleased]

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
