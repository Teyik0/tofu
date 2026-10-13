<img src="apps/tofu/public/tofu-icon.png" alt="Tofu" width="128" height="128" />

# Tofu

A desktop torrent client with a clean interface, real transfer stats, and built-in anime tracking.

Built with **Bun · React · Furin · Electrobun · WebTorrent**, using **shadcn + Base UI**.

## ✨ What you can do

- **Download your way** — add magnets, torrent URLs, or `.torrent` files, including drag and drop.
- **Keep things organized** — give each destination its own tab and folder.
- **Search everywhere** — press `Cmd+K` (or `Ctrl+K`) to search torrents across threads and enabled sources, then download into a chosen thread.
- **Stay in control** — pause, resume, set file priorities, manage trackers, and verify downloads.
- **Follow new releases** — search Nyaa, Tsundere-Raws, and C411; automate downloads with optional Jev and AniList integrations.
- **Pick up where you left off** — downloads and settings survive restarts; background mode keeps transfers running.

Files stay on disk unless you explicitly choose to delete them. Unavailable stats appear as `—`.

## 📦 Install

Download an installer matching your system from [Releases](https://github.com/Teyik0/Tofu/releases). The release pipeline targets macOS Apple Silicon, Windows x64, and Linux x64/ARM64.

On macOS, open the DMG and move Tofu to Applications. On Windows, extract the entire ZIP before running `Tofu-Setup.exe`; keep its `.installer` folder alongside it. On Linux, extract the `.tar.gz` and run `./installer`.

On macOS, choose **Tofu → Set as default torrent app** to open `.torrent` files and magnet links with Tofu. Opening a torrent starts it in your saved download folder; reopening an existing torrent preserves its destination and paused state. You can also select Tofu in Finder's **Get Info → Open with → Change All…** for `.torrent` files. The development app does not advertise file or magnet associations.

Updates are prepared in the app and installed when you choose to restart. macOS Apple Silicon is the currently validated platform.

## 🚀 Run from source

You need **Bun 1.4.3+**. macOS also requires **Xcode Command Line Tools**. Linux requires GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, and librsvg; see the [documentation site](apps/docs/README.md).

```sh
git clone https://github.com/Teyik0/Tofu.git
cd Tofu
bun install --ignore-scripts
bun run setup
bun run prepare
bun run build:desktop
bun run desktop
```

Run `bun run dev` for desktop development with HMR. For web development, run `bun run dev:web` and open **http://127.0.0.1:3030**.

Want to try a real local transfer? Keep `bun run demo` running while Tofu is open.

The Bun workspace contains the desktop app in `apps/tofu`, the Furin landing/docs site in `apps/docs`, the plugin scaffolder in `apps/scaffolder`, and reusable packages under `package/`. Root commands forward to the desktop app or run checks across workspaces. Run `bun run dev:docs` for the site at **http://127.0.0.1:3040**.

## 🧩 Plugins

Built-in discovery integrations are optional and start disabled. Enable them from **Plugins** in the sidebar. Explicitly trusted local SDK plugins start enabled after installation; their saved enablement can be changed in Plugins.

| Plugin | What it adds |
| --- | --- |
| Nyaa | Torrent search and release feeds |
| Tsundere-Raws | Recent releases from the official JSON feed |
| C411 | Torznab search with your API key |
| Jev · TypeSafe | Natural language search and release matching |
| AniList | Track selected anime from Watching and Plan to Watch |

[Plugin documentation →](apps/docs/src/pages/docs/plugins.tsx)

The experimental `@tofu/plugins` SDK is version `0.0.0` and is currently a local workspace package. Generate a plugin against this checkout with `bun run apps/scaffolder/src/cli.ts ../my-plugin`. It uses one `definePlugin` definition for a typed Elysia API, thread actions, native Furin pages, settings, authentication, and cleanup. AniList is the official plugin built on the same contracts.

After building and reviewing that package, run `bun run plugin:install ../my-plugin --trust` from the Tofu root and restart or rebuild the app. `bun run plugin:list` lists installed pins; `bun run plugin:uninstall my-plugin` removes its registration while retaining plugin data and downloads. Replacing a pin requires both `--replace` and `--trust`.

For synchronized APIs, `createPluginApi(context)` uses the host's actual Furin Sync options. Explicit GET identities and PATCH invalidations refresh the native `createClient` / `useQuery` / `useMutation` flow. Account/configuration pages can opt into `availableWhenDisabled`; AniList uses this to keep account access available while tracking is disabled.

Third-party local installation requires explicit trust. Plugins execute in the host process and share its React/Furin runtime and Bun engine capabilities. Native pages compile through generated physical route adapters and require rebuilding or restarting; there is no iframe or process isolation. See [Plugin architecture](apps/docs/src/pages/docs/plugin-api.tsx) and the [scaffolder guide](apps/scaffolder/README.md) for the workflow and its current limits.

## 🛠️ Development

```sh
bun run tscheck
bun run fix
bun run test
bun run build:desktop
bun run test:native
```

The desktop uses the Furin Electrobun CLI directly, with bundles and artifacts under `apps/tofu/.furin/electrobun`. Build once before typechecking to prepare the Hutch SDK types.

The desktop follows Tofu v0.2.5's shared Elysia service composition. Core automation persists rules and decisions; release automation owns discovery and execution. AniList keeps its service, API, and UI in its own package with injected capabilities. Both local Furin archives are pinned in the root Bun catalog so every workspace resolves the same framework instance.

`bun run test` runs the workspace test scripts. Desktop integration tests use real peers, local trackers, and temporary folders. The native test also checks the actual desktop interface and requires a graphical session.

[Architecture & configuration](apps/docs/src/pages/docs/development.tsx) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

Licensed under [MIT](LICENSE.md).
