# Furin Electrobun preview

`furin-pr163-a74cd57.tgz` contains the core preview from [Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit `a74cd57c321adb97beb69c8180344632f5829d8a`.

Source archive: <https://pkg.pr.new/Teyik0/furin/@teyik0/furin@a74cd57>.

The published preview contains unresolved `catalog:` dependencies. The only change to its extracted package is replacing those references in `package.json` with the versions from that commit's root catalog, then repacking with `bun pm pack`. Source files, generated declarations, bundles, README, and MIT license are unchanged. This temporary archive keeps clean, frozen installations working until Furin publishes normalized previews.

- Original archive SHA-256: `2eb71354ae95b345d4ae77e8f5e6dba5c906a3fc73691649ed4bd5a201a6f522`.
- Normalized archive SHA-256: `ab722252b712bb8e71d7ad80927bebd6750db2899c817a72ffb6795658c6bfaa`.

Catalog replacements: `elysia` → `2.0.0-beta.21`, `evlog` → `^2.29.0`, `exact-mirror` → `1.2.6`, `react` and `react-dom` → `19.3.0`, `typebox` → `1.3.34`, and `@types/react` and `@types/react-dom` → `^19.3.0`.

Replace this archive dependency with the published preview URL once both installation and `bun install --frozen-lockfile` succeed in a fresh directory. The optional Electrobun integration package is not vendored or installed.
