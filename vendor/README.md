# Furin packages and Remote Servers integration

Both active packages use the latest upstream baseline from
[Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit
`f272df99cbc21bd44010b9f2171bd0bc48ad9c96`.

| Active archive | Local source patch | SHA-256 |
| --- | --- | --- |
| `furin-remote-native-f272df9.tgz` | `patches/0004-aot-process-resource-isolation.patch` | `70692fabbf0afcf416fab7344cd17c6f22271d203bb433d052b9131bd442dbc6` |
| `furin-electrobun-pr163-f272df9.tgz` | None | `5e75583a5cea3ecdd75a247c40c0f9c7123eefe21cecb8dc022d0e81ee2a5668` |

The core patch evaluates Elysia AOT in a child process and waits for its exit before
prerendering. An application can own native file locks and database handles during
compilation; terminating a JavaScript worker does not reliably close these process-owned
resources. Process isolation releases them at the OS boundary. Existing AOT named-plugin,
unnamed-plugin rejection and registration tests pass with this change.

Upstream commit `495de76f797fa0bb64f8fea5290d33d043d7f835` includes Remote Servers network
admission, TLS listener configuration and the client-only manager, so the desktop package
no longer needs a local patch. Commit `c8e0461` also recovers the development supervisor
after backend compilation errors. Commit `9e6e12f` adds client-render recovery after HMR
and corrects WebKit source-map diagnostics. Commit `f272df9` isolates route discovery
imports before AOT so discovery releases import-time resources before compilation.
The Electrobun package is unchanged from `9e6e12f`; its archive has the same checksum.
Tofu's root Elysia application composes
`apiPlugin` and Furin on one listener. Network requests authenticate before dispatch,
while the protected isomorphic Eden client keeps direct in-process dispatch to
`apiPlugin`. No client transport workaround is introduced.

## Rebuilding

Use an isolated Furin checkout at the exact upstream commit above. Install dependencies
with Bun 1.4.3, apply patch 0004 from the repository root, and run each package's
`build.ts`, core first. Pack each package with `bun pm pack` from its package directory
and copy the resulting archives to the names above. Packing resolves workspace catalog
references to published ranges. Archives contain their upstream MIT licenses.

Only the two active archives and their required AOT source patch are kept here.
Historical archives and superseded or unapplied patches are not shipped.

The separate `../patches/libvlc-wasm@0.2.0.patch` is applied by Bun through
`package.json`. It bounds VLC worker shutdown and the HTTP source chunk cache;
both fixes are still needed by the installed player version.
