# Contributing to Tofu

Tofu uses Bun, React/Furin, Elysia, WebTorrent and Electrobun. Use Bun for development and package management. Do not introduce Node, npm, Vite, or another torrent engine. Read [AGENTS.md](AGENTS.md) for the project constraints.

## Setup

You need access to the private Teyik0/Tofu repository, Bun 1.4.2, and a Mac with Xcode command-line tools for native builds.

```sh
bun install --frozen-lockfile
bun run setup
bun run dev
```

`bun install` automatically runs `prepare` to install Lefthook. Keep the Git hooks enabled. `bun run dev` opens the native app for development; `bun run build` builds its compiled package. The Electrobun SDK is prepared through Hutch.

## Before requesting review

`bun run codegen` generates the AniList SDK from the checked-in schema without contacting AniList. To refresh both the schema and SDK from the live API, run `TOFU_UPDATE_ANILIST_SCHEMA=1 bun run codegen` and review the schema diff. Normal development, builds, and tests use the local schema so provider outages do not block them.

```sh
bun check
bun run fix
bun run test
bun run build
```

The integration suite covers 15 essential scenarios grouped by domain under `tests/`. Tests start the real server in temporary directories and call its typed Eden endpoints directly. Transfer tests use real local peers; external providers are simulated at their HTTP boundary. Keep shared resource lifecycle and assertion helpers in `tests/helpers/`, and verify a failing case before implementing a fix.

For changes to development/release isolation, build locally with `bun run build` and check settings, transfers, and shutdown. Stable release builds, signing, artifact preparation, and publication run exclusively through `.github/workflows/release.yml`, triggered by a version tag or manually with an existing tag.

## Changes and commits

- Write identifiers, comments, documentation, UI text, accessibility labels, errors, logs, native menus, test descriptions, and commit scopes in English. Update related assertions and native selectors when translating text. Preserve user-authored content and existing input compatibility.
- Discuss substantial features in an issue before implementation. Explain the architecture and its alternative.
- Describe bugs with a reproducible case, the expected behavior, and the affected version.
- Use Conventional Commits, enforced by commitlint, and update [CHANGELOG.md](CHANGELOG.md) under Unreleased.
- Keep shared types in `src/types.ts`, avoid default function parameters, and retain unknown statistics as `null` in the API and `—` in the interface.
- Pause, resume, tracker changes, and folder changes must preserve downloaded data. File deletion requires an explicit user choice.
- Changes to WebTorrent 3.0.21 require rerunning the torrent, library, and lifecycle scenarios.
- Do not commit tokens, certificates, user databases, or downloaded files. Keep logs and reproductions free of personal data.
- AI-assisted contributions require human review and supervision. Do not copy unattributed code. Be respectful.

The [release workflow](.github/workflows/release.yml) defines release steps and optional Apple signing secrets. Vulnerabilities should follow [SECURITY.md](SECURITY.md).
