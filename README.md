# 🌱 Tofu

A desktop torrent client with a clean interface, real transfer stats, and built-in anime tracking.

Built with **Bun · React · Furin · Electrobun · WebTorrent**, using **shadcn + Base UI**.

## ✨ What you can do

- **Download your way** — add magnets, torrent URLs, or `.torrent` files, including drag and drop.
- **Keep things organized** — give each destination its own tab and folder.
- **Stay in control** — pause, resume, set file priorities, manage trackers, and verify downloads.
- **Follow new releases** — search Nyaa, Tsundere-Raws, and C411; automate downloads with optional Jev and AniList integrations.
- **Pick up where you left off** — downloads and settings survive restarts; background mode keeps transfers running.

Files stay on disk unless you explicitly choose to delete them. Unavailable stats appear as `—`.

## 📦 Install

Download the macOS Apple Silicon build from [Releases](https://github.com/Teyik0/Tofu/releases) and move Tofu to Applications.

See the [release guide](docs/releases.md) for updates and signing details. macOS Apple Silicon is the currently validated platform.

## 🚀 Run from source

You need **Bun 1.4+** and **Xcode Command Line Tools** on macOS.

```sh
git clone https://github.com/Teyik0/Tofu.git
cd Tofu
bun install --ignore-scripts
bun run setup
bun run prepare
bun run build:desktop
bun run desktop
```

For web development, run `bun run dev` and open **http://127.0.0.1:3030**.

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

```sh
bun run tscheck
bun run fix
bun run test
bun run build:desktop
bun run test:native
```

Tests use real peers, local trackers, and temporary folders. The native test also checks the actual desktop interface.

[Architecture & configuration](docs/development.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Benchmarks](BENCHMARK.md)

Licensed under [MIT](LICENSE.md).
