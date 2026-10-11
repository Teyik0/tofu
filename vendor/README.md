# Furin PR #163 packages

These temporary local archives are downloaded from the immutable published preview for [Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit `118d85f2d766fc4a21a55b84b8508e70783076fa`:

| Archive | Package version | SHA-256 |
| --- | --- | --- |
| `furin-pr163-118d85f.tgz` | `@teyik0/furin@0.7.0-alpha.5` | `bc9d8eb226be8b6c0af5480c5970a214c00cc684188b486797b29b36033c124e` |
| `furin-electrobun-pr163-118d85f.tgz` | `@teyik0/furin-electrobun@0.1.0` | `31bced6d3888f26a5162b12b2cb13cdf0adc7d89382d163ee21385f0a3c8dccd` |

The downloads are `https://pkg.pr.new/Teyik0/furin/@teyik0/furin@118d85f2d766fc4a21a55b84b8508e70783076fa` and `https://pkg.pr.new/Teyik0/furin/@teyik0/furin-electrobun@118d85f2d766fc4a21a55b84b8508e70783076fa`. Published manifests contain resolved semver ranges, including Elysia, and no `catalog:` references. Both packages include their MIT license. No manifest, source or bundle is patched after download.

Electrobun is independently versioned at `0.1.0`. This preview adds the standard native host, typed capabilities, native instance forwarding, and the opt-in Bun hot-development preload. Core adds the explicit development launcher, including browser-only mode.

Tofu uses `desktopApp()` lifecycle contexts and `runStandardDesktopHost()`. A small host entry preserves runtime data-directory resolution; application code retains resource generations, torrent/OAuth validation, release policy and the SSR API transport. Bootstrap configuration is read synchronously after SDK loading so Furin attaches native open-event capture before startup yields. Native test scripts remain opt-in through `TOFU_SMOKE_SCRIPT`; the host also accepts Furin's `FURIN_NATIVE_TEST_SCRIPT`.

The Bun configuration uses Furin's public preload package specifier so SDK subprocesses resolve it from their own working directory. The launcher only starts for unmanaged `--hot` application commands. This preview still imports desktop build tooling in ordinary Bun commands and test subprocesses.

Upstream currently skips three backend reload regression cases pending dependency-path fixes. Backend/host replacement remains subject to that upstream limitation; frontend refresh and packaged native behavior must be validated separately. Supplied host options also bypass Furin's internal development failure reporter: the supervisor still rejects failed shutdowns, but reports a generic failure instead of the precise shutdown timeout. Windows CI also needs follow-up before claiming platform parity.
