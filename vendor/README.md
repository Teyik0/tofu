# Furin PR #163 packages

These temporary local packages are built from [Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit `11783aca93c2350f7cfbc6a438caa6a6b6abfa62`:

| Archive | Package version | SHA-256 |
| --- | --- | --- |
| `furin-pr163-11783ac.tgz` | `@teyik0/furin@0.7.0-alpha.3` | `db21ebe58c311b17549343f6d37674422996e306cd2de62bb041ae501221213b` |
| `furin-electrobun-pr163-11783ac.tgz` | `@teyik0/furin-electrobun@0.7.0-alpha.3` | `2d9e437858f30767974e35391cc5ebfc04774e4ff01c9a82e0d0c607496d2d38` |

Run `bun install --frozen-lockfile` and `bun run build` in that checkout, then `bun pm pack` from `packages/core` and `packages/electrobun`. Bun packing normalizes the upstream catalog references into semver ranges. No source or bundle is patched after packaging. Both archives include their MIT license.

The PR workflow now publishes both packages with Bun packing and repository-qualified preview URLs. Tofu retains local archives as requested; a published preview may replace them after a fresh frozen installation and native validation pass. The [integration report](../docs/furin-electrobun-preview.md) describes the host boundary and remaining platform limits.
