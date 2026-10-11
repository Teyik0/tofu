<img src="public/tofu-icon.png" alt="Tofu" width="128" height="128" />

# Tofu

A desktop torrent client with a clean interface, real transfer stats, and built-in anime tracking.

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

## 📦 Install

Download an installer matching your system from [Releases](https://github.com/Teyik0/Tofu/releases). The release pipeline targets macOS Apple Silicon, Windows x64, and Linux x64/ARM64.

On macOS, open the DMG and move Tofu to Applications. On Windows, extract the entire ZIP before running `Tofu-Setup.exe`; keep its `.installer` folder alongside it. On Linux, extract the `.tar.gz` and run `./installer`.

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

## 🛠️ Development

The desktop commands use the Furin Electrobun CLI and standard native host. Furin owns windows, tray, native events, session bootstrap and update handoff; Tofu owns torrent/AniList behavior and application resources. The small host entry resolves the existing `Tofu`/`Tofu-dev` directories and `TOFU_DATA_DIR` at launch. Using the generated entry directly would change those locations, while a build-time absolute override would embed the build machine's paths. Bundle outputs and release artifacts stay under `.furin/electrobun/`. Build once before typechecking to prepare the Hutch SDK types.

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
