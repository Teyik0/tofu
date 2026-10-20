# Furin packages and Remote Servers integration

Both active packages retain the principal checkout's upstream baseline,
[Furin PR #163](https://github.com/Teyik0/furin/pull/163), commit
`3a83c0dacaa1b94c951c639c13c3abfa0c77c14e`.

| Active archive | Local source patch | SHA-256 |
| --- | --- | --- |
| `furin-remote-native-3a83c0d.tgz` | `patches/0004-aot-process-resource-isolation.patch` | `f06e611b5b1e634404d1737438e10b30b82daa62dd483151e2fc727e54af35c9` |
| `furin-electrobun-remote-native-3a83c0d.tgz` | `patches/0003-remote-servers-on-3a83c0d.patch` | `47599dec578936e43a7ed83dd4ba698ab35283a45229daefc2e0378449033c15` |

The core patch evaluates Elysia AOT in a child process and waits for its exit before
prerendering. An application can own native file locks and database handles during
compilation; terminating a JavaScript worker does not reliably close these process-owned
resources. Process isolation releases them at the OS boundary. Existing AOT named-plugin,
unnamed-plugin rejection and registration tests pass with this change.

The desktop patch ports Remote Servers network admission, TLS listener configuration and
the client-only manager onto the newer upstream lifecycle and diagnostics. It preserves
startup deadlines and error reporting. Tofu still uses a single `apiPlugin` listener;
network requests authenticate before dispatch, while the protected isomorphic Eden client
keeps direct in-process server dispatch. No client transport workaround is introduced.

## Rebuilding

Use an isolated Furin checkout at the exact upstream commit above. Install dependencies
with Bun 1.4.3, apply patches 0003 and 0004 from the repository root, and run each package's
`build.ts`, core first. Pack each package with `bun pm pack` from its package directory
and copy the resulting archives to the names above. Packing resolves workspace catalog
references to published ranges. Archives contain their upstream MIT licenses.

The unpatched `*-pr163-3a83c0d.tgz` archives are retained as upstream references. Patches
0001/0002 and `furin-electrobun-remote-native-v5.tgz` document the previous Remote Servers
baseline; they are not active dependencies. Historical implementation notes reference
those earlier pins and are superseded by this integration.

The Electrobun 2.0.2 cookie proposal in `patches/electrobun-2.0.2-macos-cookie.patch`
remains a separate SDK change. Rebuilding Furin does not fix that native SDK binary:
Tofu continues to refuse remote views when HttpOnly and other cookie flags cannot be
verified. Per-session embedded client routing also remains a separate platform gate.
