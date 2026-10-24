# Furin packages and Remote Servers integration

Both active packages are based on
[Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit
`ce5d778f91925464a75e84ca15365edf1f8e572d`. The core package additionally
includes [furin-session.patch](furin-session.patch); Electrobun is unmodified.

| Active archive | SHA-256 |
| --- | --- |
| `furin-pr163-ce5d778-session-v1.tgz` | `4e2d24f3efcb2d256701caa189ac0f83e7bafbf3d823806524f6876b15dbb44b` |
| `furin-electrobun-pr163-ce5d778.tgz` | `424811d675b30284de7fccbee5437cc9495ad260433807c6364e17ab76e37d65` |

Commit `ce5d778` adds `createSyncClient` through `@teyik0/furin/sync/client`
for continuous live queries outside React, plus `createLocalSyncClient` through
`@teyik0/furin/sync` for direct in-process Eden subscriptions. Both clients share
query recovery and cancellation behavior. Commit `636cef7` lets background
invalidations declare their principal provenance, preserving targeted recovery
without exposing another principal's journal entries. Tofu's browser and native
consumers now subscribe to `/api/state` through the standalone client.

The local patch adds `sync.connection(context)`, returning an optional
`{ signal, release }` session resource. Furin closes the event connection when
the signal aborts and releases the resource on disconnect or failed startup,
for both WebSocket and SSE. WebSocket close code `4409` means the session
context changed: the standalone client cancels old reads, clears its cache and
reauthenticates. A grant change can reconnect; a revoked or expired session
receives an HTTP denial. Codes `1008`, `4401` and `4403` retain their existing
terminal-denial meaning.

Tofu connects its existing `callerReader()` in `src/sync.ts`. Torrent telemetry
no longer depends on connected readers: a one-second engine tick samples
transfers and their final zero-speed point, publishing only changed values.
There is no custom event-route hook in `src/server.ts`.

Commit `4aa5fec` derives native window origins from the application's actual
listener, including its hostname, port and TLS configuration.

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

Use an isolated Furin checkout at the exact upstream commit above. Apply
`git apply /absolute/path/to/Tofu/vendor/furin-session.patch` from its root.
Install dependencies with Bun 1.4.4, then run `bun run build.ts` in
`packages/core`. Pack it with `bun pm pack --filename
/absolute/path/to/Tofu/vendor/furin-pr163-ce5d778-session-v1.tgz`.
The patch also includes the transport and standalone-client regression tests;
run them with `bun test --isolate` to avoid cross-file framework state.
Packing resolves workspace catalog references to published ranges. Archives
contain their upstream MIT licenses. The existing Electrobun archive does not
need rebuilding for this core-only change.

The unmodified `furin-pr163-ce5d778.tgz` archive is retained as the upstream
reference. The local patch is already included in the active archive; Bun does
not apply it again during installation.

The separate `../patches/libvlc-wasm@0.2.0.patch` is applied by Bun through
`package.json`. It bounds VLC worker shutdown and the HTTP source chunk cache;
both fixes are still needed by the installed player version.
