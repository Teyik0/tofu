# Furin PR #163 packages

These temporary local packages are built from [Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit `88dcf453d68a4a4d92762cece40522433684e503`:

| Archive | Package version | SHA-256 |
| --- | --- | --- |
| `furin-pr163-88dcf45.tgz` | `@teyik0/furin@0.7.0-alpha.4` | `949ec981267e0b6db20915798bc6339fe911cf461931557fddf346240fa07721` |
| `furin-electrobun-pr163-88dcf45.tgz` | `@teyik0/furin-electrobun@0.7.0-alpha.4` | `2f612fdd57f9cf81581ceb3450bfd7badd95341fc653decef002fb7746d29da8` |

Run `bun install --frozen-lockfile` and `bun run build` in that checkout, then `bun pm pack` from `packages/core` and `packages/electrobun`. Bun packing normalizes the upstream catalog references into semver ranges. No source or bundle is patched after packaging. Both archives include their MIT license.

The PR workflow publishes both packages with Bun packing and repository-qualified preview URLs. The stable release workflow also publishes Electrobun after the core. Tofu retains local archives as requested; a published preview may replace them after a fresh frozen installation and native validation pass. The [integration report](../docs/furin-electrobun-preview.md) describes the host boundary and remaining platform limits.
