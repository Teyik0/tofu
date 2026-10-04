# Tofu

Desktop torrent client: React/Furin → Elysia API → WebTorrent running on Bun, packaged with Electrobun. Use Bun for all commands; do not introduce Node, npm, Vite, or another torrent engine.

- Use English throughout the repository: identifiers, comments, documentation, UI text, accessibility labels, API errors, logs, native menus, test descriptions, and commit scopes. Do not introduce French project-authored text. User-provided content, proper names, and language codes such as VF and VOSTFR retain their original meaning.
- When translating text, update related test assertions and native selectors together. Use English date/number formatting and byte units (B, KiB, MiB, GiB, TiB). Preserve support for existing user input and persisted data; do not rewrite user-authored content merely to change its language.
- Read the TDD skill before changing behavior. Test transfers and lifecycle behavior through public APIs with real peers in temporary directories.
- Keep the engine on the Bun side and shared types in `src/types.ts`.
- WebTorrent addons are external to the bundle. Resolve the Electrobun SDK from the Hutch devkit.
- The tracker/wire bridge depends on WebTorrent 3.0.21; rerun the tests when upgrading it.
- Never delete files when pausing, changing trackers, or resuming. Deleting data requires the explicit form option.
- Display real statistics. Unknown values remain `null` in the API and `—` in the UI.
- Do not use default function parameter values; prefer precise types over unstructured dictionaries.
- Keep changes focused and explain the architecture choice and its alternative.
- After changes, run `bun run tscheck`, `bun run fix`, `bun run test`, and `bun run build:desktop`. For UI or native integration changes, also run `bun run test:native`.
- The native test script is opt-in through `TOFU_SMOKE_SCRIPT`. Never inject it by default.
- Run the existing Git hooks before committing or pushing.
