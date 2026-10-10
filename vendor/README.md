# Furin PR #163 packages

These temporary local archives are downloaded from the immutable published preview for [Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit `53e7c56a05fa0c21703d7fc5fda8371ee1983291`:

| Archive | Package version | SHA-256 |
| --- | --- | --- |
| `furin-pr163-53e7c56.tgz` | `@teyik0/furin@0.7.0-alpha.5` | `1c9bb37bd5036fac6c608844d228a291b53c8086bb1a948460c2ca68d99339e2` |
| `furin-electrobun-pr163-53e7c56.tgz` | `@teyik0/furin-electrobun@0.1.0` | `c677aab77398027e0533caa3e0a695c4a8102ad103a0be5b3c5fa6d2b29714f4` |

The downloads are `https://pkg.pr.new/Teyik0/furin/@teyik0/furin@53e7c56a05fa0c21703d7fc5fda8371ee1983291` and `https://pkg.pr.new/Teyik0/furin/@teyik0/furin-electrobun@53e7c56a05fa0c21703d7fc5fda8371ee1983291`. Published manifests contain resolved semver ranges, including Elysia, and no `catalog:` references. Both packages include their MIT license. No manifest, source or bundle is patched after download.

Core is byte-identical to the prior `914e82a` preview. Electrobun is independently versioned at `0.1.0` and scans resolved backend inputs through Bun's build metafile, avoiding a Bun panic when file-loader assets pass through an `onLoad` hook.

The preview uses unified desktop configuration, `desktopApp()` lifecycle callbacks and `runDesktopHost()`. Tofu retains immutable local archives for reproducible installation. The [integration report](../docs/furin-electrobun-preview.md) describes the native boundary and validation.
