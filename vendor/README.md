# Furin packages and Remote Servers integration

Both active packages use the latest upstream baseline from
[Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit
`9e6e12fbf571c305444d133f911cc905b78c9718`.

| Active archive | Local source patch | SHA-256 |
| --- | --- | --- |
| `furin-remote-native-9e6e12f.tgz` | `patches/0004-aot-process-resource-isolation.patch` | `480ba40f2ba406d88c257fe3925f1190e9dabf25a18ec198f52d5a9afff32a00` |
| `furin-electrobun-pr163-9e6e12f.tgz` | None | `5e75583a5cea3ecdd75a247c40c0f9c7123eefe21cecb8dc022d0e81ee2a5668` |

The core patch evaluates Elysia AOT in a child process and waits for its exit before
prerendering. An application can own native file locks and database handles during
compilation; terminating a JavaScript worker does not reliably close these process-owned
resources. Process isolation releases them at the OS boundary. Existing AOT named-plugin,
unnamed-plugin rejection and registration tests pass with this change.

Upstream commit `495de76f797fa0bb64f8fea5290d33d043d7f835` includes Remote Servers network
admission, TLS listener configuration and the client-only manager, so the desktop package
no longer needs a local patch. Commit `c8e0461` also recovers the development supervisor
after backend compilation errors. Commit `9e6e12f` adds client-render recovery after HMR
and corrects WebKit source-map diagnostics. Tofu still uses a single `apiPlugin` listener;
network requests authenticate before dispatch, while the protected isomorphic Eden client
keeps direct in-process server dispatch. No client transport workaround is introduced.

## Rebuilding

Use an isolated Furin checkout at the exact upstream commit above. Install dependencies
with Bun 1.4.3, apply patch 0004 from the repository root, and run each package's
`build.ts`, core first. Pack each package with `bun pm pack` from its package directory
and copy the resulting archives to the names above. Packing resolves workspace catalog
references to published ranges. Archives contain their upstream MIT licenses.

The older `*c8e0461.tgz` and `*3a83c0d.tgz` archives, `furin-electrobun-remote-native-v5.tgz` and patches
0001/0002/0003 are retained as historical references; they are not active dependencies.
Historical implementation notes reference those earlier pins and are superseded by this
integration.

The Electrobun 2.0.2 cookie proposal in `patches/electrobun-2.0.2-macos-cookie.patch`
remains a separate SDK change. Rebuilding Furin does not fix that native SDK binary:
Tofu continues to refuse remote views when HttpOnly and other cookie flags cannot be
verified. Per-session embedded client routing also remains a separate platform gate.
