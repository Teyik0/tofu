# Furin Electrobun integration

Tofu 0.2.1 uses the core and Electrobun packages from [Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit `b41f29c71a499e958ee9e33902d2e781f480e56d`. [Archive provenance](../vendor/README.md) records the pinned local packages and checksums.

## Architecture

`furin-electrobun build` produces the inert `app.js`, copies its external dependency closure and prepares the Hutch SDK project. `furin.desktop.config.ts` selects `src/desktop-host.ts` through the new `hostEntry` option. That host calls the public `startDesktopBackend()` API with Tofu's existing data directory. The backend lives in the same Bun process as the SDK; WebTorrent remains on Bun.

The app exports `onStartup(signal)` and `onShutdown`. Initialization acquires the instance lease before opening the journal, engine, automations and updater; the private listener opens after initialization completes. Shutdown persists transfers and closes resources. Native update preparation drains durable services while retaining the listener so an unsuccessful helper handoff can restore services with the same session. Normal quit stops the backend through Furin.

Tofu owns its tray, menus, protocol events, window reopening and updater behavior. The alternative of replacing those with a generic framework window would discard existing native behavior. The small host entrypoint and typed SDK additions preserve it without adding torrent-specific framework APIs. This follows the artifact/deployment boundary used by [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output) and [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting).

## Additions to Furin

- Public `@teyik0/furin-electrobun/host` capabilities, including awaited initialization, idempotent bounded shutdown, private native session access and fresh window bootstraps.
- Optional `hostEntry` for applications with existing native integration.
- Typed SDK additions for URL schemes, file associations, platform icons, signing, helper files, Bun externals and release feeds. Sources resolve from the application root; the Furin artifact remains owned by the packager.
- Development SDK packaging through `build --env=dev`; custom hosts currently use build output, while the standard host retains its supervised dev workflow.
- CI publishes both core and Electrobun with a pinned publisher, Bun packing and repository-qualified URLs. Bun packing resolves `catalog:` references, fixing clean consumer installs. See [Bun catalogs](https://bun.sh/docs/pm/catalogs#publishing).

## Session handling in Tofu

Desktop HTTP requests require Furin's per-instance cookie. SSR loaders forward the incoming cookie only to the same application origin; browser data never includes it. The native helper descriptor stores it with owner-only permissions alongside the existing process/profile/origin metadata. OAuth forwarding and native integration scripts use that descriptor to access the correct instance. Server mode retains its existing request guard.

Each newly created window or OS browser receives a fresh, single-use bootstrap. Closing the window in background mode keeps the backend, private session and tray alive. Navigation is sandboxed and limited to the app and bootstrap origins; other HTTP(S)/mail links open in the system browser.

## Validation and limits

The public API migration test starts the real Tofu app through the package, checks unauthenticated rejection and authenticated SSR, downloads from a real peer with identical SHA-256 and restores a paused torrent after restart. Native background validation destroys and reopens the actual WebView while the real transfer completes. Native opening checks cover torrent files, magnets and OAuth forwarding. The coexistence test extracts the stable archive into its temporary directory, runs both native profiles together and verifies isolated preferences, a real transfer and independent shutdown. Development and release packaging pass, including the macOS DMG signature check. Type checking, formatting, public API tests and desktop packaging are required alongside the Git hooks.

The full native smoke workflow still reaches its 90-second WebView timeout observed before this migration. Windows and Linux native UI behavior require their own platform validation. No stable release, merge or system-default torrent association change is part of this update.
