# Remote servers — accepted specification

This document consolidates the approved product brief, the UI specification, the target
architecture and the Opus review corrections (2026-10-19). Where earlier proposals conflict,
the review decisions below win. Implementation progress and proof evidence are tracked in
[`implementation-log.md`](implementation-log.md).

## Product scope

- One authoritative library, database and torrent engine per server. Files and downloads stay
  on the host. No library merging, no cross-server mutations.
- A browser visits one server origin. A desktop installation can host its own library, connect
  to several saved servers, or run as a client without a torrent engine.
- Remote access is off by default. Enabling it requires validated configuration; failed
  activation keeps the previous valid configuration.
- Vocabulary: **Server** (machine and library, stable `serverId`), **Device** (authorized
  client), **Address** (one route to a server), **Playback profile** (progress namespace).
- Later extensions (not v1): Tofu cloud relay, SSH provisioning, transcoding, Cast/TV apps,
  automatic library merging, multi-user AniList accounts.

## Identity

- `server_identity` singleton: random `serverId`, `createdAt`, `protocolMajor`,
  `identityEpoch`. Restoring a backup keeps the identity; cloning creates a new identity and
  revokes credentials.
- `GET /.well-known/tofu` is public and minimal: product, `serverId`, display name, protocol
  range, application version, onboarding methods. A public `serverId` is a consistency check
  after TLS validation, never authentication.

## Authorities and roles

- **Owner**: the host's own native window (verified desktop session) or the recovery CLI.
  Holds every permission and cannot be revoked remotely. A headless server with remote access
  disabled keeps the legacy behavior: loopback requests with a loopback `Host` act as owner.
- **Device grants**: role `playback` < `management` < `administration`, plus an independent
  `canDeleteFiles` flag allowed only with Management or Administration (default off).
- Issuer rule: invitations and grant edits may only produce grants that are a subset of the
  issuer's effective grants. An Administration device may edit or revoke only devices whose
  grants are a subset of its own and can never raise itself.
- Owner only: storage roots, absolute host paths (download path, locate, watched folders),
  certificate and key files, trusted proxy peers, host-native actions (open/reveal files,
  directory pickers, logs folder, default-app association, background window, update install).
- Administration: server settings, integrations (AniList, sources, Jev), automation rules,
  destinations beneath storage roots, invitations and devices, exposure changes via
  confirm-or-revert.
- Management: add magnets and `.torrent` files into an existing destination, pause, resume,
  priority, verify/announce, remove a torrent entry while keeping files, move between existing
  destinations with collision refusal.
- Delete files (with Management or Administration): remove with files, destructive automation
  options, destination removal with content.
- Playback: safe library reads, streaming, own playback progress, own preferences, own sign
  out, own external-player links.

## Request admission

- `desktopApp({ admission })` authenticates every listener request before routing.
  `dispatchKind(request)` distinguishes listener requests from in-process Eden dispatch.
- Anonymous allowlist (exact): `GET /.well-known/tofu`, `GET /pair`, `GET /signed-out`,
  `POST /api/auth/pair`, the static assets those two documents use, and local-window
  bootstrap mechanics. Unauthenticated document navigations elsewhere are redirected to
  `/signed-out`; unauthenticated API, data, SSE and media requests receive typed `401`.
- Local-window authority requires the verified desktop session (cookie, origin and a loopback
  TCP peer). Peer address or `Host` alone never grants anything.
- **Invariant A**: every Furin loader reads only Playback-safe data (safe DTO projections).
- **Invariant B**: privileged endpoints reject in-process dispatch with a typed `403`, and
  in-process dispatch is read-only. Privileged and device-personal reads happen in the browser
  through the unchanged shared Eden client after `/api/session` confirms the capability.
- `/pair` and `/signed-out` are standalone documents served by a const Elysia plugin, not Furin
  pages: no root loader, strict CSP, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Every authenticated response is `private, no-store`. Tofu pages use SSR only (no ISR/SSG).

## Sessions and pairing

- Browser session: one opaque random token in an HttpOnly, SameSite=Strict cookie named
  `__Host-tofu-<first 16 hex of serverId>` (Secure; over plain loopback HTTP the cookie is
  named `tofu-<16 hex>` without `Secure` because browsers reject `__Host-` without HTTPS).
  The database stores only its SHA-256. Sliding idle expiry 30 days (last-seen updated at most
  every 10 minutes), absolute expiry 365 days. No refresh-token rotation.
- Native clients keep one durable device token in the OS secret store (`Bun.secrets`, service
  `app.tofu.torrents.servers`, `.dev` suffix in development, `persist: "local"`). It is only
  used by the native process to mint 60-second single-use window grants that become the
  partition cookie. It never enters a WebView. If the secret store is unavailable the user may
  keep a memory-only connection until Tofu quits; secrets are never stored in plain text.
- Invitations: default Playback, 10-minute expiry, single device. Link secret is 128-bit,
  carried in the URL fragment and removed from history. Manual code: 10 Crockford base32
  characters. Five failed attempts burn an invitation; a global failed-code token bucket limits
  guessing. Per-peer limits use forwarded addresses only from configured trusted proxies.
- Response loss: the client sends a 128-bit redemption nonce. Repeating the same secret and
  nonce within 120 seconds re-issues a token for the same device (invalidating the previous
  one). Any other reuse returns typed `410`.
- Revocation is a database flag plus an in-process abort registry that closes SSE, media and
  range waits for that device within one second. Downgrades bump `grantVersion` and abort
  capability-dependent streams. Bytes already delivered cannot be recalled.
- CSRF: cookie-authenticated mutations require a same-origin `Origin` (or `Referer`) matching
  the request origin and reject `Sec-Fetch-Site: cross-site`. No CORS.

## Sync and mutations

- Sync principal: `device:<deviceId>` for paired devices, `local-window` for owner network
  requests, `shared` for in-process reads. Never include `grantVersion`; authorization runs
  before idempotency reservation and replay.
- Browser private caches reset when `/api/session` reports a new `authorizationVersion`.
- Worker side effects (add, remove, move) use durable operation receipts reconciled at startup
  so a crash between effect and receipt does not duplicate the effect.

## Storage boundary

- Owner-only **storage roots**. Remote Administration creates destinations only as root ID plus
  relative subpath, canonicalized with `realpath`, rejecting symlink escapes and `..`.
- Adding or moving a torrent never overwrites a file that does not belong to an indexed torrent
  record: typed `409`.
- Media reads use the indexed torrent file identity, never a request path.

## Media

- Range, suffix range, `416` with `Content-Range: bytes */size`, HEAD without torrent waits.
- No-Range and `/content` responses stream in bounded chunks from one opened descriptor whose
  identity (size, inode) is checked at open. Every media response registers with the device's
  abort controller before its first await.
- Admission budgets: 4 in-flight reads per device, 16 global, 4 MiB chunk cap; excess returns
  typed `429` with `Retry-After`.
- External-player links: opaque token in the path `/media/x/<token>/<filename>`, default TTL
  6 hours, one file, Range-capable, revocable, bound to the issuing device,
  `Referrer-Policy: no-referrer`. UI copy: "Anyone with this link can play this file until
  <time>."
- Playback progress: each player mount creates a `playbackSessionId`; updates carry
  `{ position, duration, playbackSessionId, seq }`. Within a session only increasing `seq` is
  accepted; across sessions the last write by server receive time wins, so explicit
  seek-backwards works. Key: profile + infohash + file index + file length.

## Network exposure

- Remote access persists a stable port (default 3030 development, 3031 release; conflicts are
  reported, never silently changed).
- **Tailscale** (recommended) and **custom HTTPS proxy** terminate TLS outside Tofu and forward
  to the loopback HTTP listener. No host certificate trust, no rebind, no bootstrap change.
  Tofu changes only the exact Tailscale Serve mapping it created, never Funnel, and on
  conflict reports and does nothing. States: Not checked → Not installed / Signed out / HTTPS
  not enabled / Configuration conflict / Ready.
- **Embedded Tailscale setup**: the local owner's Connect action starts enrollment and
  explicitly authorizes private sharing once prerequisites are met. Sign-in and HTTPS consent
  use official Tailscale pages; a bounded, cancellable status loop resumes activation without
  separate Check / Apply clicks. Cancelling or leaving the page prevents subsequent status
  reads from initiating activation. Device invitations remain a separate authorization.
- **Custom proxy**: canonical HTTPS origin plus trusted immediate proxy peers. Forwarded
  headers are honored only from those peers.
- **Local network (LAN-direct)**: TLS on the single listener bound to all interfaces,
  including loopback. Tofu generates an installation CA and a leaf certificate whose SAN covers
  the `.local` name, selected IPs, `127.0.0.1`, `::1` and `localhost`. Every device, including
  the host itself, must trust the CA. Activation is refused until the host's own window can
  connect. No desktop certificate pinning in v1.
- Applying an exposure change that rebinds the listener restarts the backend, then waits up to
  90 seconds for confirmation through the new route (`POST /api/connections/config/confirm`);
  otherwise the previous configuration is restored. A pending journal survives crashes and is
  reverted at boot. Local-window applies confirm automatically after readiness.
- Recovery CLI (`bun scripts/tofu-admin.ts`) works with the instance stopped (exclusive data
  directory lease): create an owner-issued invitation, revoke devices, disable remote access.

## Native desktop

- The native catalog (saved servers, aliases, routes, startup mode) lives in its own file
  under the native data directory, independent from the hosting database lock.
- Client-only startup does not import the backend, database or torrent worker.
- Remote content opens in a main-process sandboxed `BrowserView` with partition
  `persist:srv-<serverId>-<deviceId>`, navigation rules allowing only the selected origin, and
  no RPC. Forget clears that partition's storage and cookies and deletes the stored secret.
- Route changes install a fresh cookie for the new origin, reload the same path and resume
  playback from the last saved position. Healthy playback never moves to a "faster" route.
  Browsers never fail over across origins; they show an authenticated alternative link.

## AniList

- Supported completion: the host window, or a paired Tofu desktop client with Administration
  (the client routes `tofu://oauth/anilist#…` by pending `state` to the bound server/device).
  Browser-only remote administrators are told to finish in the Tofu app or on the host.
  Guest playback never writes to the owner's AniList.

## Cross-server media sources (scope clarification, 2026-10-19)

The user clarified that each person keeps **their own** AniList account, list and progress in
their personal Tofu (server A). Paired servers (B, for example "Home NAS") act as **playback
sources**: when A's AniList episode list shows an episode A has not downloaded but B has an
authorized matching file, A offers **Watch on Home NAS** instead of only "Not downloaded".
Watching it updates A's progress and, with explicit consent under A's normal completion rule,
A's AniList entry — never B owner's AniList. This is cross-server media-source discovery and
playback; it complements, and does not replace, opening B's full remote workspace.

Non-goals and invariants: A's AniList token never leaves A; no database merging; no automatic
duplicate download (Download stays an explicit action); no generic proxy transport; the shared
Eden client is unchanged; cross-origin streams are not assumed compatible with the isolated
player until proven (gate G15).

### Library links (A's server → B)

- A's **server** pairs with B as a device of kind `server` by redeeming an invitation created on
  B (Playback is sufficient and recommended). The link is created on A in Settings › Connections
  › Libraries from other servers (Administration on A). B shows it in Authorized devices as a
  linked server, revocable like any device.
- The link credential is a session of kind `link`: bearer only, accepted by B exclusively on
  `GET /.well-known/tofu`, `POST /api/library/availability`, `POST /api/media-links` and
  `GET /api/session`. It cannot open pages, the live stream or administration endpoints.
- A stores B's `serverId`, display name, verified HTTPS origin(s), device ID and the credential
  in its own database (data directory `0700`, database `0600`), like other host integration
  credentials. Every use verifies that B's public descriptor still reports the stored `serverId`
  after TLS validation; a different ID marks the link `identity-changed` and sends nothing else.

### Matching contract

- A sends, per opened anime, **one batch** per linked server (never one request per card):
  `{ key, infoHashes[], titles[], season, part, episodeOffset, episodes[] }`, where `infoHashes` are the
  releases A's sources found for those episodes and `titles` are the AniList search-plan titles
  and aliases. A's personal-library request includes its AniList media ID; A resolves that
  entry's authoritative search plan, part and continuous-episode offset locally before
  contacting B. No AniList token is included.
- B answers only from torrents its Playback viewers may already see:
  1. `match: "infohash"` — a torrent with the same infohash (exact).
  2. `match: "title"` — a file whose parsed release name (the discovery parser used for
     sources) has a normalized title equal to one of the titles, the same season (when known)
     and the requested episode; packs are matched per file. Shown as "Matched by title".
- Each source is a variant: torrent ID, file index, file name, length, progress, status
  (`playable`, `downloading`, `paused`, `unavailable`), parsed resolution and language. No paths, peers,
  trackers or magnets.
- A's endpoint `POST /api/linked-libraries/availability` fans out once per active link with a
  4-second deadline, caches results for 60 seconds, and reports per link: `available`, `none`
  (reachable, nothing matches), `offline` (unreachable; last known sources returned as stale
  with their check time when younger than 10 minutes), `revoked` (B answered 401/403),
  `identity-changed`, or `incompatible` (protocol).

### Playback handoff and authorization

- **Primary (A's isolated player)**: A's player page asks A's server to open a source; A's
  server requests a file-scoped external media grant from B (`POST /api/media-links` with the
  link credential), and the player streams `https://B/media/x/<token>/<name>` directly from B.
  These grant responses carry `Access-Control-Allow-Origin: *` without credentials,
  `Cross-Origin-Resource-Policy: cross-origin`, exposed `Content-Range`/`Accept-Ranges`, and
  answer the Range preflight; the token is file-scoped, Range-capable, expiring (6 hours) and
  revoked with the link. A never relays bytes.
- The viewing device must reach B's origin and trust its certificate. When it cannot, A shows
  "Home NAS is not reachable from this device" with **Open on Home NAS** (B's own workspace
  player in a desktop window or browser tab) and **Copy playback link** as honest fallbacks;
  progress from those fallbacks is not reported to A.
- Revoking the link on B, or downgrading it, aborts active reads and invalidates its grants; A
  shows "Home NAS removed access for this server".

### Progress and AniList routing

- A's player reports progress to A (`profile` of the viewer on A, media key
  `remote:<B serverId>:<infohash>:<file index>:<length>`); B learns only byte-range reads.
- When playback passes 90% (or ends) and the player was opened from A's AniList episode, A asks
  "Mark episode N as watched on AniList?" Confirming calls A's existing episode completion
  endpoint with A's token and the account ID shown in the prompt. The server rejects an
  account change before applying completion and verifies the provider identity. Nothing is
  ever written to B's AniList, and devices without
  Administration on A cannot update A's AniList.

### Gate

G15: libvlc-wasm in A's cross-origin isolated player streams a Range-capable cross-origin B media
grant (Chromium/WebView2 and WebKit). Until proven on a platform, that platform offers the
fallbacks above instead of in-player remote playback.

## Proof gates

G1 framework provenance · G2 admission under JIT/AOT/HMR · G3 native cookie installation into
partitions · G4 host window over HTTPS with a trusted CA · G5 sandboxed partitioned BrowserView ·
G6 client-only bundle graph · G7 `Bun.secrets` on packaged runtimes · G8 remote browser matrix ·
G9 headless re-listen · G10 Tailscale Serve ownership · G11 leak suite · G12 revocation and
downgrade during streams, retry after upgrade · G13 crash between worker effect and receipt ·
G14 confirm-or-revert · G15 cross-origin linked-library playback in the isolated player. Failing gates narrow the published platform matrix explicitly.

## Revised embedded transport target

The user prefers Tailscale built into Tofu. The hosting target is a supervised,
version-pinned tsnet companion; existing system Serve is optional. See
[the transport decision and proof](embedded-tailscale.md) for dependencies,
community TypeScript alternatives, and the missing per-session WebView routing API.
Embedded host support does not imply zero-install native clients or public browser access.
