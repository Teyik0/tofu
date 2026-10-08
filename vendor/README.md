# Furin PR #163 packages

These temporary local packages are built from [Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit `b41f29c71a499e958ee9e33902d2e781f480e56d`:

| Archive | Package version | SHA-256 |
| --- | --- | --- |
| `furin-pr163-b41f29c.tgz` | `@teyik0/furin@0.7.0-alpha.3` | `335fff9fe3817602a7c8b25d14812606c1a4d671278bee7f7d34d3836e31206c` |
| `furin-electrobun-pr163-b41f29c.tgz` | `@teyik0/furin-electrobun@0.7.0-alpha.2` | `30c8b7e2d5dd578907d93c9437349bfed36d1222937f30e1e8ce2dfdd565e79c` |

Run `bun install --frozen-lockfile` and `bun run build` in that checkout, then `bun pm pack` from `packages/core` and `packages/electrobun`. Bun packing normalizes the upstream catalog references into semver ranges. No source or bundle is patched after packaging. Both archives include their MIT license.

The PR workflow now publishes both packages with Bun packing and repository-qualified preview URLs. Tofu retains local archives as requested; a published preview may replace them after a fresh frozen installation and native validation pass. The [integration report](../docs/furin-electrobun-preview.md) describes the host boundary and remaining platform limits.
