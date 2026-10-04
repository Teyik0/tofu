# Changelog

Notable changes to Tofu are tracked here. Release tags follow the version in package.json.

## [Unreleased]

### Changed

- Isolated development and release profiles, native identities and download folders, with database ownership and exclusive process locks.
- Migrated shadcn components from Radix UI to Base UI, including keyboard interactions and native smoke checks.
- Replaced the external XML parser with Bun's native XML parser for RSS and Torznab feeds.
- Shortened the README, translated it into English, and moved detailed documentation into separate guides.

### Added

- Torrent downloads under Bun/WebTorrent with real transfer, peer and tracker statistics.
- Destination tabs, optional relocation of existing files, and explicit errors for missing files and operations in progress.
- Persistent settings, priorities, trackers, pause/resume, verification, and explicit opt-in file deletion.
- Source plugins, AniList subscriptions, discovery, and download automations.
- macOS menu-bar icon and optional background mode that releases the native window and WebView while keeping transfers and automations running.
- Authenticated private GitHub release checks, native notifications and installer downloads.
- macOS Apple Silicon release pipeline with optional Apple signing and notarization.
- MIT license, contribution and security policies, repository templates and Git hooks.
