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
| Headless LAN HTTPS | Tested with installation CA, restart, crash rollback and confirmation |
| Native local HTTP workspace | Existing private bootstrap retained; tested across restart |
| Native client-only manager | Packaged macOS proof: no backend/database; sandbox and partitions checked |
| Native remote windows / native LAN HTTPS window | Blocked: Electrobun 2.0.2 macOS drops HttpOnly; Tofu verifies flags and refuses unsafe navigation |
| Embedded Tailscale host | Compiles and passes local transport tests; real enrollment requires the owner |
| Embedded Tailscale client without an OS route | Requires a per-session proxy API missing in Electrobun 2.0.2 |
| Windows/Linux packages, physical phones, OS keyring persistence | Not validated on those platforms/runtimes |

The native cookie defect is confirmed in the pinned SDK source. An upstream patch is included
in `vendor/patches/electrobun-2.0.2-macos-cookie.patch`; it is **not** applied to the SDK binary.
Its Foundation flags were checked separately, which does not replace a rebuilt WebView proof.
Tofu adds no public bootstrap, certificate bypass or remote native bridge to bypass this gate.

## Hosting and connecting

1. Open **Settings → Connections** on the host and choose a name and transport.
2. **Embedded Tailscale**: click **Connect Tofu to Tailscale**. Follow the displayed sign-in
   and HTTPS authorization links if prompted. Tofu checks progress and activates private
   access automatically; no separate Check or Apply step is needed. Cancel pauses setup
   without activating access. Existing system Tailscale Serve is an alternative.
   Network access and Tofu pairing are separate authorizations.
3. **Custom HTTPS** forwards to the existing loopback listener. Configure its HTTPS origin and
   immediate trusted peers on the host. Preserve Origin, cookies, Range/HEAD, isolation headers
   and unbuffered SSE. Exclude capability URL paths from proxy access logs. Subpath hosting is unsupported.
4. **LAN HTTPS** creates an installation CA. Compare its fingerprint and install the public CA
   through the connecting device's trust UI. Private keys stay on the host. Native hosting is
   gated above; headless hosts support this transport.
5. Create an invitation with Playback, Management or Administration. Deleting files is an extra
   permission, off by default. Open the QR/link or enter the address and code. Invitations are
   consumed once; a same-device nonce permits bounded recovery after a lost response.

The native manager browses Bonjour `_tofu._tcp` on macOS. macOS LAN hosts advertise while
sharing is enabled; `TOFU_DISCOVERY=0` disables advertisement. Discovery supplies bounded,
untrusted hints and never grants access. Other platforms and isolated/guest networks use
manual HTTPS entry. The packaged proof covers the discovery CLI boundary; physical network
discovery remains an acceptance check.

A browser needs a route to a private Tailscale address, normally system Tailscale. Embedding the
host does not make `.ts.net` public. Different tailnets require authorized sharing or policy;
Tofu neither discovers nor grants access to every tailnet node.

Rebinding the single headless listener requests supervisor restart with exit code 75. Confirm a
remote change through its new address within 90 seconds. Otherwise it reverts; a second boot
without confirmation also restores the last good configuration. Host-local changes confirm
when their new listener is ready.

Desktop hosts reserve their configured loopback port from startup (3030 in development, 3031
in release). Set `TOFU_PORT` explicitly for another installation. A port conflict fails startup;
Tofu does not silently choose another sharing port. Explicit port 0 is useful for isolated tests:
readiness records its actual bound port before forwarding or enabling sharing. Tailscale and
proxy activation preserve the existing listener.

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
modules; packaging includes dependency notices and a SHA-256 manifest.

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
