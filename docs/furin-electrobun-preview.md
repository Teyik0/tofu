# Furin Electrobun preview assessment

Assessment of [Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit `a74cd57c321adb97beb69c8180344632f5829d8a`, with Tofu 0.2.1 and Bun 1.4.2 on macOS ARM64.

## Dependency update

Tofu now uses the PR's core preview through `vendor/furin-pr163-a74cd57.tgz`. Its source and bundles are unchanged; only the package manifest's catalog references are resolved before repacking. [Archive provenance and hashes](../vendor/README.md) explain the temporary packaging workaround.

The upstream preview has three publication problems:

1. The compact URL posted by the PR, `https://pkg.pr.new/@teyik0/furin@163`, returns HTTP 404. The repository-qualified URL `https://pkg.pr.new/Teyik0/furin/@teyik0/furin@a74cd57` returns the core archive.
2. That archive retains `catalog:` in dependencies and peer dependencies. A direct `bun add` fails on `exact-mirror@catalog:`. An override appeared to work with Tofu's existing installation, but a clean `bun install --frozen-lockfile` still failed. Catalog declarations in the consuming app do not fix a published package. [Bun's publication contract](https://bun.sh/docs/pm/catalogs#publishing) resolves these references during `bun pm pack` or `bun publish`.
3. The PR workflow publishes only `packages/core`; repository-qualified and compact previews for `@teyik0/furin-electrobun` return HTTP 404. The optional integration package is not installed in Tofu.

The smallest upstream publication fix is to publish both packages together from the repository root, use Bun packing, and disable compact URLs:

```sh
bunx --bun pkg-pr-new publish --bun --no-compact --packageManager=bun ./packages/core ./packages/electrobun
```

For CI, pin the publisher in the repository lockfile and run its installed executable instead of resolving the latest CLI on every publication. See the [publisher's options and monorepo contract](https://github.com/stackblitz-labs/pkg.pr.new#publish-packages). Validate each published archive in a fresh consuming project, including a frozen installation.

## Migration experiments

The integration source was extracted from the exact PR commit into ignored scratch files. Neither the existing Furin checkout nor its PR was modified or published.

- The preview core passes Tofu's 153 public API tests, type checking, formatting, and desktop build with the existing host.
- `furin build --target bun --output app` produces Tofu's inert `app.js` successfully.
- `prepareDesktop` copies that output and the installed `webtorrent` / `parse-torrent` dependency closure successfully. This checks packaging preparation, not native addon ABI compatibility in a replacement host.
- Passing the unchanged Tofu root to `startDesktopBackend` is rejected with the documented `createDesktopApp()` migration diagnostic.
- In a temporary copy of Tofu, changing only the root constructor allows session bootstrap and listening, but an authenticated `/api/state` request returns HTTP 503: `The engine is starting, please wait`.

The constructor and HTTP 503 results are Tofu migration work, rather than defects in Furin: Tofu currently initializes its journal, engine, automation, instance lease and updates inside `startServer()`. A new host would need that initialization separated from listener/window ownership and connected to Elysia startup, with the existing disposal connected to `onShutdown`. Tofu's explicit data directory and development/release identities must also be retained rather than silently adopting a different storage path.

## Missing host capabilities

The [PR's integration README](https://github.com/Teyik0/furin/blob/a74cd57c321adb97beb69c8180344632f5829d8a/packages/electrobun/README.md) deliberately describes an MVP. Its `DesktopConfig` and generated runtime cannot currently replace these Tofu behaviors:

| Tofu requirement | Gap in the Furin host |
| --- | --- |
| Menu-bar tray, native menus, reopen and background transfers | No host extension hook receives the SDK, window or backend. Window close always shuts down the backend and quits. |
| Magnet links, torrent files and AniList OAuth callbacks | Generated app metadata omits URL schemes and file associations; the runtime does not dispatch these native events to Tofu. |
| Download, prepare and restart native updates | Generated configuration omits the release feed; no updater/lifecycle extension coordinates installation and failure recovery. |
| Platform icons and signing/distribution options | The small configuration surface does not pass through Tofu's Electrobun platform options. |
| Native integration tests | No explicit opt-in window/script hook corresponding to `TOFU_SMOKE_SCRIPT`; Tofu's current native tests cannot target the generated window unchanged. |

The native full smoke test launched with the preview core but timed out waiting for its WebView workflow. This environment already exhibited hidden-window timeouts before the dependency update, so this does not establish a new Furin regression. The background lifecycle smoke passed with real peer transfer and matching SHA-256, including window destruction and reopening.

## Recommendation

Keep Tofu's existing Electrobun host while evaluating the updated core. The alternative of replacing it immediately with the generated host would remove background transfers, native integrations and updater behavior that Tofu already supports.

For Furin, first fix preview publication. Then add a small optional host lifecycle seam and a validated SDK configuration extension in the Electrobun package. Let applications attach trays, menus, URL/file events and updater behavior while Furin retains guarded app startup, session bootstrap and artifact ownership. A custom renderer, another production backend process or application-specific torrent logic in Furin core would add complexity without addressing these gaps. The separate server artifact already follows the useful precedent of [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output) and [TanStack Start deployment](https://tanstack.com/start/latest/docs/framework/react/guide/hosting).
