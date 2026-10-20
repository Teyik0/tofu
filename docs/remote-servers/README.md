# Remote servers

Remote access is off by default. Each server owns its database, downloads, credentials and
AniList account. A paired server can supply media inside a person's own AniList library:
watching B's file from A records playback on A. The explicit completion prompt updates A's
AniList only; no AniList token is sent to B.

## Current platform boundary

| Path | Status |
| --- | --- |
| Browser pairing, permissions, library and revocation | Tested with real processes and peers |
| Chromium cross-origin player | Tested with H.264/AAC, shared-memory VLC worker and seeking |
| WebKit/Safari cross-origin player | External playback link offered; in-app playback gated |
| LAN HTTPS (desktop and headless hosts) | Companion ingress tested with installation CA, Host/SAN filtering, migration, restart and startup failure; physical phones and other OSes not validated |
| LAN and Tailscale at the same time | Tested with real processes and a simulated Tailscale CLI; same library, identity and grants |
| Native local HTTP workspace | Existing private bootstrap retained; tested across restart |
| Native client-only manager | Packaged macOS proof: no backend/database; sandbox and partitions checked |
| Native remote windows | Blocked: Electrobun 2.0.2 macOS drops HttpOnly; Tofu verifies flags and refuses unsafe navigation |
| Embedded Tailscale host | Compiles and passes local transport tests; real enrollment requires the owner |
| Embedded Tailscale client without an OS route | Requires a per-session proxy API missing in Electrobun 2.0.2 |
| Windows/Linux packages, physical phones, OS keyring persistence | Not validated on those platforms/runtimes |

The native cookie defect is confirmed in the pinned SDK source. An upstream patch is included
in `vendor/patches/electrobun-2.0.2-macos-cookie.patch`; it is **not** applied to the SDK binary.
Its Foundation flags were checked separately, which does not replace a rebuilt WebView proof.
Tofu adds no public bootstrap, certificate bypass or remote native bridge to bypass this gate.

## Hosting and connecting

1. Open **Settings → Connections** on the host. **Local network**, **Tailscale** and **Custom
   HTTPS** are independent connections to the same library, identity and permissions. Turn
   each on or off separately; turning one off leaves the others running. Every address is a
   separate browser origin, so a device pairs once per address it uses.
2. **Embedded Tailscale**: click **Connect Tofu to Tailscale**. Follow the displayed sign-in
   and HTTPS authorization links if prompted. Tofu checks progress and activates private
   access automatically; no separate Check or Apply step is needed. Cancel pauses setup
   without activating access. Existing system Tailscale Serve is an alternative.
   Network access and Tofu pairing are separate authorizations.
3. **Custom HTTPS** forwards to the existing loopback listener. Configure its HTTPS origin and
   immediate trusted peers on the host. Preserve Origin, cookies, Range/HEAD, isolation headers
   and unbuffered SSE. Exclude capability URL paths from proxy access logs. Subpath hosting is unsupported.
4. **Local network HTTPS** lets household browsers connect without installing or joining
   Tailscale. It is not zero setup: create the local certificate on the host, download the
   installation CA, install it as trusted on each connecting device through that device's own
   trust settings, and compare the SHA-256 fingerprint shown in Tofu. Private keys stay on the
   host. The native companion (the same `tofu-tsnet` process that hosts embedded Tailscale, which
   is never enrolled for this) terminates HTTPS on all interfaces at the local network port
   (3443, or 3442 in development) and forwards to the loopback application listener. Only
   names and current addresses the certificate covers are offered and accepted; other `Host`
   values receive `421`, and browser-supplied forwarding headers are replaced. Renew the
   certificate after the host's name or address changes. The host's own window never uses this
   address, so it needs no certificate trust. Guest or isolated Wi-Fi may block devices.
5. Create an invitation with Playback, Management or Administration. Deleting files is an extra
   permission, off by default. Open the QR/link or enter the address and code. Invitations are
   consumed once; a same-device nonce permits bounded recovery after a lost response.

The native manager browses Bonjour `_tofu._tcp` on macOS. macOS hosts advertise the local
network HTTPS port while that connection is open; `TOFU_DISCOVERY=0` disables advertisement. Discovery supplies bounded,
untrusted hints and never grants access. Other platforms and isolated/guest networks use
manual HTTPS entry. The packaged proof covers the discovery CLI boundary; physical network
discovery remains an acceptance check.

A browser needs a route to a private Tailscale address, normally system Tailscale. Embedding the
host does not make `.ts.net` public. Different tailnets require authorized sharing or policy;
Tofu neither discovers nor grants access to every tailnet node.

No connection change restarts Tofu or rebinds its listener. Changes apply one at a time: each is
journaled, activated and then saved, and a failed activation restores the previous forwarding
(for example, a busy local network port keeps the previous port serving). After a crash during a
change, startup never widens access: a connection stays on only if it was on both before and
after the interrupted change, and a Tailscale Serve mapping Tofu may have created is removed if
it is still exactly Tofu's. Enabled connections are startup dependencies: Tofu opens its window
or reports ready only after they forward traffic, and a failure (for example, an expired
certificate or a busy port) prevents startup and stops the companion. Use
`bun run admin disable-remote` to recover.

The application listener is always loopback HTTP. Desktop hosts reserve their configured
loopback port from startup (3030 in development, 3031 in release); headless hosts use
`TOFU_PORT`. Set `TOFU_PORT` explicitly for another installation. A port conflict fails startup;
Tofu does not silently choose another sharing port. Explicit port 0 is useful for isolated tests:
readiness records its actual bound port before forwarding.

Configurations from earlier versions, which allowed one transport at a time, migrate on first
start: the active transport stays on and the others keep their settings but stay off. Earlier
LAN sharing bound the application listener itself. A desktop host keeps that visible LAN port
and moves its private listener to a new loopback port. A headless host keeps `TOFU_PORT` for
the application, so its LAN address moves to port 3443 (3442 in development; the next port if
`TOFU_PORT` already uses it) and the change is logged; update bookmarks or container port
mappings accordingly. An unconfirmed change journaled by an earlier version reverts to the
last confirmed configuration.

## Personal AniList and shared media

On A, use **Libraries from other servers → Link a server** with B's Playback invitation.
Availability is batched per anime/server. Infohash matching still checks season, part and
episode; A reuses its own AniList normalization, including continuous episode numbering.
Conservative title matching is the fallback. The completion prompt names A's account, and
an account change rejects the update. Offline/stale and revoked sources are
separate from absence. File-scoped expiring grants let A stream from B without sharing general
sessions. Individual revocation terminates active reads. The external-player fallback shows
its link expiry and a revoke action.

Files, folder paths, integrations and native OS actions stay attached to the selected server.
Remote administrators choose canonical relative folders under owner-created storage roots.
Signing out closes that window's active streams; the native device can reconnect without
pairing again. Disconnecting or forgetting a client does not stop server downloads. Native Reconnect retains
the last page and tries saved origins after identity verification; healthy windows keep their
current route. Native windows remain subject to the SDK gate above.

## Recovery and backups

Stop Tofu first; the recovery command takes the same instance lease:

```sh
TOFU_DATA_DIR=/path/to/data bun run admin devices
TOFU_DATA_DIR=/path/to/data bun run admin revoke <device-id>
TOFU_DATA_DIR=/path/to/data bun run admin revoke-all
TOFU_DATA_DIR=/path/to/data bun run admin invite administration
TOFU_DATA_DIR=/path/to/data bun run admin disable-remote
TOFU_DATA_DIR=/path/to/data bun run admin root Media /absolute/storage/path
```

A backup restore retains identity and replaces that installation. A new clone must reset its
inherited identity and accounts before starting:

```sh
TOFU_DATA_DIR=/path/to/copied/data bun run admin clone-identity --confirm-clone
```

This explicit operation clears inherited grants, linked credentials, provider configuration,
AniList state/progress, native catalog, TLS keys and embedded network identity. It preserves
torrent data; review storage paths before starting the clone. OS credentials are not exported.
Add/remove receipts survive crashes and use stable device principals. Reusing a key with other
options is a conflict. Move journals reconcile before restored peers start and check inode
ownership before removing old or published copies.

## Development validation

Use isolated `TOFU_DATA_DIR` and `TOFU_DOWNLOAD_DIR` values for builds and route scans.
`src/lib/client.ts` remains unchanged. Companion builds require Go 1.27.1 and checksummed
modules; packaging includes dependency notices and a SHA-256 manifest. Local network sharing
needs the companion on every platform, so packages must include and sign it.

```sh
bun run tscheck
bun test --isolate --timeout 60000
(cd native/tailscale && go test ./...)
bun run build
bun run build:desktop
# Requires FFmpeg and a Playwright Chromium installation:
bun run test:remote-browser
# Requires the desktop build; temporary hosts and memory-only credentials:
bun run test:remote-native
```

See [implementation evidence](implementation-log.md), [embedded transport](embedded-tailscale.md)
and the [accepted specification](specification.md) for contracts and proof gates.
