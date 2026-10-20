<img src="public/tofu-icon.png" alt="Tofu" width="128" height="128" />

# Tofu

A desktop torrent client with a clean interface, real transfer stats, and built-in anime tracking.

[![Watch the Tofu demo — plugins, AniList, and dark theme](.github/assets/tofu-demo.jpg)](.github/assets/tofu-demo.mp4)

[Watch the 53-second demo](.github/assets/tofu-demo.mp4)

Built with **Bun · React · Furin · Electrobun · WebTorrent**, using **shadcn + Base UI**.

## ✨ What you can do

- **Download your way** — add magnets, torrent URLs, or `.torrent` files, including drag and drop.
- **Keep things organized** — give each destination its own tab and folder.
- **Search everywhere** — press `Cmd+K` (or `Ctrl+K`) to find torrents across all threads, search enabled sources, and review releases before downloading into a chosen thread.
- **Stay in control** — pause, resume, set file priorities, manage trackers, and verify downloads.
- **Follow new releases** — search Nyaa, Tsundere-Raws, and C411; automate downloads with optional Jev and AniList integrations.
- **Pick up where you left off** — downloads and settings survive restarts; background mode keeps transfers running.

Files stay on disk unless you explicitly choose to delete them. Unavailable stats appear as `—`.

If downloaded files disappear or change, Tofu stops the transfer and reports a storage problem. **Repair download** verifies the remaining pieces before downloading missing data; a paused torrent stays paused. **Locate files** verifies an existing folder without moving or deleting anything. Disconnected or replaced destinations are never recreated automatically: reconnect the original storage or select its new location. Storage problems survive restarts, and inaccessible data is shown as unknown until verified.

Tofu keeps local diagnostics in `logs/app.jsonl` inside its data directory. On macOS, release logs are in `~/Library/Application Support/Tofu/logs/`; development uses `Tofu-dev`. **Settings → General → Open logs folder** opens them in the desktop app. Logs record startup, shutdown, API mutations and errors, and torrent storage failures with their original system codes, stacks, and directory identities. Routine speed and progress updates are omitted. Files rotate at 5 MiB with three backups (about 20 MiB total), and credentials, request bodies, and headers are excluded or redacted. Logs stay on the machine hosting Tofu and are not uploaded.

## 📦 Install

Download an installer matching your system from [Releases](https://github.com/Teyik0/Tofu/releases). The release pipeline targets macOS Apple Silicon, Windows x64, and Linux x64/ARM64.

On macOS, open the DMG and move Tofu to Applications. On Windows, extract the entire ZIP before running `Tofu-Setup.exe`; keep its `.installer` folder alongside it. On Linux, extract the `.tar.gz` and run `./installer`.

macOS releases use free ad hoc signing unless an Apple Developer ID is configured. These releases are not notarized, so macOS may block the first launch. After downloading from the official releases page, try opening Tofu, dismiss the alert, then go to **System Settings → Privacy & Security → Open Anyway** and confirm **Open**. See [Apple's instructions](https://support.apple.com/en-us/102445) for details.

On macOS, choose **Tofu → Set as default torrent app** to open `.torrent` files and magnet links with Tofu. Opening a torrent starts it in your saved download folder; reopening an existing torrent preserves its destination and paused state. You can also select Tofu in Finder's **Get Info → Open with → Change All…** for `.torrent` files. The development app does not advertise file or magnet associations.

In **Settings → General**, **Set Tofu as default** changes the `.torrent` file association while keeping your magnet link application. This action requires the installed release; some systems ask you to complete the choice in their default application settings.

**Delete .torrent file after adding** is off by default. When enabled, a successful import from your file manager permanently removes the original `.torrent` file after Tofu has saved its metadata. Downloaded content, invalid files, and files for torrents already in the library are kept. Browser uploads and drag-and-drop imports keep the original because they do not expose its filesystem path.

See the [release guide](docs/releases.md) for updates and signing details. macOS Apple Silicon is the currently validated platform.

## 🚀 Run from source

You need **Bun 1.4.3+** for the built-in `bun check` type checker. macOS also requires **Xcode Command Line Tools**. Linux requires GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, and librsvg; see the [development guide](docs/development.md).

```sh
git clone https://github.com/Teyik0/Tofu.git
cd Tofu
bun install --ignore-scripts
bun run setup
bun run prepare
bun run build:desktop
bun run desktop
```

Run `bun run dev` to open the native app and a browser against the same authenticated backend. Bun's Furin preload manages the desktop supervisor. For browser-only development, run `bun run dev:web` and open **http://127.0.0.1:3030**.

Frontend CSS and React changes use HMR in the existing window. Backend changes restart
its native host after releasing application resources; unsaved UI state is not preserved
across those restarts. `bun run desktop` launches a compiled package without HMR.
Stop it before starting `bun run dev`, since both normally use the same development profile.
Known development failures and their reproductions are recorded in the [HMR investigation](docs/hmr-investigation.md).

Want to try a real local transfer? Keep `bun run demo` running while Tofu is open.

## 🧩 Plugins

Plugins are optional and start disabled. Enable them from **Plugins** in the sidebar.

| Plugin | What it adds |
| --- | --- |
| Nyaa | Torrent search and release feeds |
| Tsundere-Raws | Recent releases from the official JSON feed |
| C411 | Torznab search with your API key |
| Jev · TypeSafe | Natural language search and release matching |
| AniList | Track selected anime from Watching and Plan to Watch |

[Plugin guide →](docs/plugins.md)

### Service composition

Each module exports its service class, Elysia plugin, and input types directly. Consumers declare their dependencies with `.use()`.

Services and HTTP management are separate. `automationPlugin` has no endpoints; `automation/management.ts` retains the existing interface API. `AutomationService` depends on SQLite and Jev, not Discovery, torrent execution, or source providers. The built-in `ReleaseAutomationService` collects releases, submits candidates, and executes committed decisions. AniList owns its account/media bindings and uses that release integration.

Each application initializes its services before serving requests. Elysia service plugins construct their shared instances once at module initialization and expose them with `decorate`. The database has its own plugin. The torrent service plugin owns the worker and exposes the ready engine through `.use(torrentServicePlugin)`. The global `src/sync.ts` builds Furin's SQLite adapter and notifier, then routes opt in with `furinSync(sync)`. AniList, Jev, Discovery, automation, source registration, and updates live in their own service plugins.

The native startup hook supplies the runtime context before the database opens. Startup acquires the instance lock, opens and validates SQLite, initializes the torrent engine, and imports the API routes before mounting them with Furin on the single application. An `AsyncDisposableStack` releases initialized resources on failure and shutdown. The API entry exports that shared application as `apiPlugin`; importing it for build inspection never opens the user's database. The server-side Eden client dispatches directly to this same application.

An integration can consume the automation service without mounting its management API:

```ts
import { Elysia } from "elysia";
import { furinSync } from "@teyik0/furin/sync";
import { automationPlugin } from "./src/api/modules/automation";
import { draft } from "./src/api/modules/automation/model";
import { sync } from "./src/sync";

export const filmsPlugin = new Elysia({ name: "acme-films" })
  .use(automationPlugin)
  .use(furinSync(sync))
  .put(
    "/films/:id/rule",
    {
      body: draft,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ automation, body, params, mutation }) => {
      const prepared = await automation.prepareRule(null, body, [], {
        ownerId: "acme.films",
        key: params.id,
      });
      const rule = await mutation((tx) => automation.writeRule(tx, prepared));
      automation.refreshState();
      return rule;
    }
  );
```

Rules are reconciled by `(ownerId, key)`. Each configuration change increments `revision`; `prepareIngestion` and `writeIngestion` reject obsolete work. Integrations supply `{ contentKey, release }` candidates, active sources, existing torrent IDs, and collection errors. Network reads and Jev evaluations happen before the write transaction. Refresh in-memory state only after commit. For `includeExisting: false`, supply existing candidates when preparing a new rule; the core does not discover its own baseline.

The executor defaults to the rule's integration owner. Only `tofu.releases` rules are polled by Tofu's built-in scheduler; legacy rules remain compatible. An external integration is responsible for its own scheduling, execution, retries, and shutdown. Persisted `adding` decisions serve as pending actions. Report results with `writeDecisionResult`, supplying the collected rule revision. Execution is retryable, not exactly-once: use torrent hashes to recover an already added transfer. Manual approval persists across retries, and replacement removal waits until the new transfer completes.

Register a source with `plugins.registerSource` during application initialization, using a unique namespaced ID such as `acme.releases`. Its `search` callback receives the query, configured API key, and cancellation signal; an optional `download` callback receives the release and the same credentials/cancellation context. Source configuration persists, and new sources start disabled. Set `privateDownloads: true` when download or page URLs contain credentials. The registry keeps those URLs server-side in public snapshots. Register sources again on each startup before starting integrations.

The current candidate and policy contract remains release-oriented (`FeedRelease`, torrent destinations, quality preferences); this does not yet promise a universal workflow API. Third-party routes must be included statically in the application to participate in its inferred Eden type. Plugins execute trusted code in the host process.

## 🛠️ Development

The desktop commands use the Furin Electrobun CLI and generated standard native host. Furin owns windows, tray, native events, session bootstrap and update handoff; Tofu owns torrent/AniList behavior and application resources. The runtime data-directory policy in `furin.config.ts` preserves the existing `Tofu`/`Tofu-dev` directories and resolves `TOFU_DATA_DIR` at launch. Each process owns one set of application services; failed native update handoff restarts the whole application after releasing both instance leases. Bundle outputs and release artifacts stay under `.furin/electrobun/`. Build once before typechecking to prepare the Hutch SDK types.

The torrent worker commits engine invalidations to the shared SQLite journal and sends the committed cursor with its snapshot. The server updates its cache before notifying Furin; cursor notifications do not poll SQLite. Transfer events schedule grouped telemetry publications while a browser is subscribed. With no subscribers, telemetry publications and chart sampling stop, while persistence and storage checks run every five seconds. State changes such as completion and storage errors still publish in the background. Peer connections and encryption continue independently of interface subscriptions.

```sh
bun run tscheck
bun run fix
bun run test
bun run build:desktop
bun run test:native
```

`bun run test` runs the integration suite with Bun in isolated processes. API tests call the typed endpoints through Eden and exercise real application services, real peers, local trackers, and temporary folders. Shared fixtures and assertions live in `tests/helpers/`; AniList tests live in `tests/anilist/` without repeating the feature name in filenames. Keep only essential integration scenarios, with no function unit tests, component snapshots, or tests of framework internals. The native test also checks the actual desktop interface and requires a graphical session.

Native tests launch an isolated application copy outside the repository. After `bun run build:release`, use `TOFU_NATIVE_PROFILE=release bun run test:native` to extract and test the stable update archive, or additionally set `TOFU_NATIVE_LAUNCHER` to an extracted application's launcher. Self-extracting installers are rejected to avoid modifying the installed app. User data remains separate, and the smoke script is injected only by this opt-in test command.

Use `TOFU_NATIVE_WORKFLOW=global-search bun run test:native` for the global search workflow: keyboard navigation, cross-thread results, stale responses, source failures, destination selection, duplicate detection, and a real peer download. Discovery responses use an HTTP fixture; the release cache, addition API, and file transfer are real.

The default native workflow covers torrent transfers, settings, updates, and tab deletion. The focused workflows are `global-search`, `plugins`, `anilist`, and `anilist-catalog`. AniList integration tests live in `tests/anilist/`, with native scenarios in its `native/` subdirectory. Small presentation checks and duplicate native workflows are omitted in favor of API integration tests and complete native flows.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

Licensed under [MIT](LICENSE.md).
