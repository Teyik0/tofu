# Contributing to Tofu

Tofu uses Bun, React/Furin, Elysia, WebTorrent and Electrobun. Use Bun for development and package management. Do not introduce Node, npm, Vite, or another torrent engine. Read [AGENTS.md](AGENTS.md) for the project constraints.

## Setup

You need access to the private Teyik0/Tofu repository, Bun 1.4.2, and a Mac with Xcode command-line tools for native builds.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run setup
bun run prepare
bun run dev
```

`prepare` installs Lefthook. Keep the Git hooks enabled. `bun run desktop` opens the built native app; `bun run build:desktop` rebuilds it. The Electrobun SDK is prepared through Hutch.

## Before requesting review

```sh
bun run tscheck
bun run fix
bun run test
bun run build:desktop
```

For interface or native integration changes, also run:

```sh
bun run test:native
bun run test:background
```

Native tests require a graphical macOS session. Their injected workflow is explicitly enabled by `TOFU_SMOKE_SCRIPT`; never inject it by default. Transfer tests use real peers and temporary directories. Add tests through public APIs for changes to the engine or lifecycle, and verify a failing case before implementing the fix.

For changes to development/release isolation, build both native channels with `bun run build:desktop` and `bun run build:release`, then run `bun run test:coexist`. The coexistence test opens both real bundles in temporary data directories and checks independent settings, transfers and shutdown. See [docs/development.md](docs/development.md#data-and-configuration) for the profile defaults and ownership rules.

## Changes and commits

- Write identifiers, comments, documentation, UI text, accessibility labels, errors, logs, native menus, test descriptions, and commit scopes in English. Update related assertions and native selectors when translating text. Preserve user-authored content and existing input compatibility.
- Discuss substantial features in an issue before implementation. Explain the architecture and its alternative.
- Describe bugs with a reproducible case, the expected behavior, and the affected version.
- Use Conventional Commits, enforced by commitlint, and update [CHANGELOG.md](CHANGELOG.md) under Unreleased.
- Keep shared types in `src/types.ts`, avoid default function parameters, and retain unknown statistics as `null` in the API and `—` in the interface.
- Pause, resume, tracker changes, and folder changes must preserve downloaded data. File deletion requires an explicit user choice.
- Changes to WebTorrent 3.0.21 require rerunning tracker, wire, transfer, and lifecycle tests.
- Do not commit tokens, certificates, user databases, or downloaded files. Keep logs and reproductions free of personal data.
- AI-assisted contributions require human review and supervision. Do not copy unattributed code. Be respectful.

Release instructions and Apple signing requirements are in [docs/releases.md](docs/releases.md). Vulnerabilities should follow [SECURITY.md](SECURITY.md).
