# Furin PR #163 packages

Tofu pins these archives from [Furin PR #163](https://github.com/Teyik0/furin/pull/163):

| Archive | Upstream commit | Package version | SHA-256 |
| --- | --- | --- | --- |
| `furin-pr163-118d85f.tgz` | `118d85f2d766fc4a21a55b84b8508e70783076fa` | `@teyik0/furin@0.7.0-alpha.5` | `bc9d8eb226be8b6c0af5480c5970a214c00cc684188b486797b29b36033c124e` |
| `furin-electrobun-pr163-a1c9c5d.tgz` | `a1c9c5dc8e7cb652925418c98be06f5fa09ee0b2` | `@teyik0/furin-electrobun@0.1.0` | `c366f5006205e0d1285d2e10157a1b6b03268ac9b3d465b1d8af676429dbac21` |

The core archive comes from the immutable published preview at
`https://pkg.pr.new/Teyik0/furin/@teyik0/furin@118d85f2d766fc4a21a55b84b8508e70783076fa`.
The core package is unchanged between that commit and the current Electrobun
commit, so this upgrade retains the existing core archive.

The Electrobun archive is built from an isolated checkout of its exact upstream
commit using the package's `build.ts`, then packed with `bun pm pack` under Bun
1.4.3. Packing resolves the workspace catalog references to published semver
ranges. Its source matches upstream; no local guard patch is applied. Both
archives include their MIT license.

Tofu mounts `desktopApp()` on its single Elysia application, exported as
`apiPlugin` and used directly by the protected isomorphic Eden client. The
upstream SDK distinguishes trusted in-process dispatch from requests arriving
through Bun's HTTP listener. Network session and origin checks remain enforced;
startup, update pause, and shutdown affect both transports.

The standard native host owns windows, tray, native events, and update handoff.
The runtime data-directory policy in `furin.config.ts` preserves `Tofu` and
`Tofu-dev` and resolves `TOFU_DATA_DIR` at launch. Failed update handoff restarts
the process after releasing the native and application instance leases. Native
smoke injection is opt-in through `FURIN_NATIVE_TEST_SCRIPT`.

The prior provisional guard patch and its archive have been removed. The
upstream change requires no `allowInProcessRequests` option and no changes to
`src/lib/client.ts`.
