# Furin packages and Remote Servers integration

Both active packages are built without local source patches from
[Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit
`2ce23218e9b84023796d0635f110fd342cb0a458`.

| Active archive | SHA-256 |
| --- | --- |
| `furin-pr163-2ce2321.tgz` | `1553e3081cee062caa54bc7c7f78c3462f067eddcaaeeae7c83e7359749b5f3a` |
| `furin-electrobun-pr163-2ce2321.tgz` | `ad331d2bcfe997b862157ef8090de3334b40806c75caedb53304ab12deae29b8` |

Commit `b156c07` preserves API plugin types in desktop composition, including
request-aware macros. Commit `2ce2321` restores `background` as a callback;
Tofu reads the current torrent settings whenever the native host checks the policy.

Commit `95c290a` infers service decorators in `desktopApp(({ access, torrents }) => ...)`
and uses Elysia's native listeners. Tofu configures admission and background behavior
directly from those services without awaiting API modules or extracting their context.

Commit `05cbdc8` replaces `desktopApp.onOpen` with the Electrobun SDK's `open-url`
event. Tofu registers its existing backend link handler from the native entrypoint;
associated files arrive as `file:` URLs. Commit `49a5663` removes Furin's global
evlog initialization. Tofu initializes its logger once in `src/server.ts`,
preserving its file drain and redaction throughout Furin composition.

Commit `4abac21` makes the generated SDK bootstrap own native startup.
Tofu installs `desktopApp(...)` on its root Elysia application and uses
`desktop.build.bun.entrypoint` only for native server windows and pairing capabilities.
The customization no longer starts or imports the backend. Its readiness and open-event
callbacks run through the desktop plugin; Furin owns data-directory resolution,
session protection, window creation, smoke-script injection and shutdown.

Upstream evaluates Elysia AOT in a child process and waits for its exit before
prerendering. An application can own native file locks and database handles during
compilation; terminating a JavaScript worker does not reliably close these process-owned
resources. Process isolation releases them at the OS boundary. Commit `cb21588`
supersedes the local AOT process isolation patch, which is no longer shipped.

Upstream commit `495de76f797fa0bb64f8fea5290d33d043d7f835` includes Remote Servers network
admission, TLS listener configuration and the client-only manager, so the desktop package
no longer needs a local patch. Commit `c8e0461` also recovers the development supervisor
after backend compilation errors. Commit `9e6e12f` adds client-render recovery after HMR
and corrects WebKit source-map diagnostics. Commit `f272df9` isolates route discovery
imports before AOT so discovery releases import-time resources before compilation.
Commit `a9f9ded` lets source entries own their listener and Elysia shutdown lifecycle
through the desktop preload. The native host installs session protection before listening,
awaits readiness before opening a window, and reports startup errors before native cleanup.
Tofu's root Elysia application composes
`apiPlugin` and Furin on one listener. Network requests authenticate before dispatch,
while the protected isomorphic Eden client keeps direct in-process dispatch to
`apiPlugin`. No client transport workaround is introduced.

## Rebuilding

Use an isolated Furin checkout at the exact upstream commit above. Install dependencies
with Bun 1.4.4 and run each package's
`build.ts`, core first. Pack each package with `bun pm pack` from its package directory
and copy the resulting archives to the names above. Packing resolves workspace catalog
references to published ranges. Archives contain their upstream MIT licenses.

Only the two active archives are kept here.
Historical archives and superseded or unapplied patches are not shipped.

The separate `../patches/libvlc-wasm@0.2.0.patch` is applied by Bun through
`package.json`. It bounds VLC worker shutdown and the HTTP source chunk cache;
both fixes are still needed by the installed player version.
