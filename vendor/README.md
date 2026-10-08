# Furin PR #163 packages

These temporary local packages are built from [Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit `dd9edb4bda9c2726ea3add56f25bbeb6a27f8fdb`:

| Archive | Package version | SHA-256 |
| --- | --- | --- |
| `furin-pr163-dd9edb4.tgz` | `@teyik0/furin@0.7.0-alpha.5` | `b0ec7f60f0afee8f72c73d480ec0a8246306627ae0960ada63a733581c27442a` |
| `furin-electrobun-pr163-dd9edb4.tgz` | `@teyik0/furin-electrobun@0.7.0-alpha.5` | `72834a0cae90ce7b644218ff2c59db42367accf5b5cc7f399c92f8a60b726a43` |

Run `bun install --frozen-lockfile` and `bun run build` in that checkout, then `bun pm pack` from `packages/core` and `packages/electrobun`. Bun packing normalizes the upstream catalog references into semver ranges. No source or bundle is patched after packaging. Both archives include their MIT license.

The PR workflow publishes both packages with Bun packing and repository-qualified preview URLs. The stable release workflow also publishes Electrobun after the core. Tofu retains local archives as requested; a published preview may replace them after a fresh frozen installation and native validation pass. The [integration report](../docs/furin-electrobun-preview.md) describes the host boundary and remaining platform limits.
