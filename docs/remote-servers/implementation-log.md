# Remote servers implementation evidence

Validated on macOS arm64 on 2026-10-19 with Bun 1.4.3. This records working behavior
and release gates separately. The [platform matrix](README.md) is the support contract;
passing a local fixture does not establish Windows, Linux, mobile or real-tailnet support.

## Accepted scope and provenance

Tofu base: `325b548f8541c4adcf6b45c20a626107e86f0c4c`. The accepted brief, architecture,
review, prototype and handoff are retained in [design](design/implementation-handoff.txt).
The user's subsequent scope includes personal AniList on A with authorized media on B,
and Tofu-owned embedded Tailscale hosting. No additional visual approval was required.

Both original Furin archives were reproduced from their exact source commits before
changes. Core remains unchanged at `118d85f`. Electrobun is rebuilt from `a1c9c5d` plus
the two source patches in `vendor/patches`; the current archive is
`furin-electrobun-remote-native-v5.tgz`. See [checksums and rebuild instructions](../../vendor/README.md).
The isolated framework checkout and all temporary hosts are outside the user's main checkout.
`src/lib/client.ts` remains byte-for-byte unchanged.

## Implemented behavior

- One listening `apiPlugin`, desktop admission first, direct in-process Eden for safe SSR.
  Network admission checks identity, sessions, Origin and trusted immediate proxy peers before
  routing. Only exact standalone pairing, signed-out, descriptor and file-grant paths are public.
  Privileged reads and mutations reject in-process dispatch. Documents/data are private and uncached.
- Installation identity, opaque hashed sessions, bounded invitations and same-device retry nonce,
  Playback/Management/Administration roles, independent delete-files grant, stable device principals,
  grant invalidation and recovery CLI. Device revoke aborts streams; window sign-out aborts that
  window's streams while preserving the native device credential. Reader registration owns its
  expiry timer and cleanup; idle renewal is checked against current database state.
- Approved Connections UI, QR/code invitation, authorized-device controls, transport readiness,
  linked libraries, owner-only capabilities and safe browser-side privileged reads. Browser AniList
  OAuth truthfully directs to a host or paired desktop; callback state is bound to its initiating device.
- Owner-created storage roots and canonical remote relative directories, symlink/collision checks,
  retained-file ownership receipts and refusal to overwrite foreign bytes. Durable mutation receipts
  reserve before effects, survive grant changes and reconcile after crashes. Move journals reconcile
  inode ownership before restored peers start. Expected failures in these paths retain typed status
  and response headers across the torrent worker; legacy unrelated service paths are not a complete
  repository-wide error-contract migration.
- Cancellable opened-file streaming with descriptor identity, global/device budgets, bounded Range,
  suffix/HEAD/416 support and incremental no-Range reads. Bun sends streaming bodies chunked;
  no-Range is a full sequential 200 response, not an artificial first-range response. Expiring,
  file-scoped external links support individual revoke and device revoke. Capability paths and
  invitation fragments are redacted from diagnostics; media grant paths are excluded from request logs.
- Personal playback positions use per-session sequence numbers, explicit rewind and profile isolation.
  Player retry preserves position, selected tracks, volume and intended play/pause. External-copy
  fallback, expiry and revoke remain available, including when in-app playback is unsupported.
- A links to B with least-privilege Playback. Availability batches queries without per-card fanout,
  reuses A's AniList title/season/part/continuous-episode normalization, preserves file variants and
  distinguishes absent, offline/stale, unavailable, identity-changed and revoked sources. A obtains
  file-scoped grants and the viewer streams directly from B. B receives no AniList token. Completion
  requires explicit consent on A and an expected A account ID; changing account rejects the update.
- Native client-only entry imports no backend/database/worker. Trusted manager and server strips own
  sandboxed per-server/device views, identity checks before credentials, credential keyring or explicit
  memory-only choice, targeted OS torrent/magnet handoff, reconnect, forget and startup/recovery controls.
  Bonjour hints on macOS are bounded, untrusted and manual-entry compatible. Current remote views
  remain blocked by the SDK security gate below.
- Headless LAN installation CA/TLS, trusted custom HTTPS proxy, owned system Serve mapping, and
  journaled 90-second confirm-or-revert with supervisor restart code 75. The compiled Furin entry
  invokes Tofu's named `startServer` lifecycle, preserving its selected address, port and TLS settings.
  Desktop startup reserves the configured port even while sharing is off; explicit port 0 records
  the resolved forwarding target. The desktop integration checks that enabling proxy sharing
  returns `restarting: false` and preserves the current workspace.
- Bundled tsnet host companion, narrow inherited-pipe control, independent protected state, owner
  enrollment/status/logout and TLS forwarding solely to the existing loopback listener. Startup
  validates an enabled enrollment before accepting traffic. EOF/shutdown closes the companion.
  Build pins module checksums and toolchain, signs/verifies the macOS executable, and packages its
  licenses and checksum manifest in both native and standalone server output.

## Integration evidence

The tests use typed Eden calls, real application services, temporary databases and real local
WebTorrent peers. AniList is simulated only at its HTTP boundary; system Serve and Bonjour are
simulated at their CLI boundaries. No real account enrollment, system trust installation, Funnel
configuration or user sharing was performed.

| Evidence | Result / coverage |
| --- | --- |
| Final complete Tofu suite | `bun test --isolate --timeout 60000`: 244 passed, 0 failed, 15,985 assertions across 57 files (415.94 s) |
| Latest remote access, recovery and linked-library tests | 6 passed, 394 assertions; account mismatch, A-only AniList, season mismatch, active revoke, log redaction, session logout, stable receipts, clone reset and callback binding |
| Crash integration | Real 64 MiB transfer and SIGKILL during pending move journal; hash, ownership, cleanup and subsequent move checked |
| Network recovery integration | Real installation CA, TLS listener, crash before confirmation, rollback and confirmed restart; 58 assertions |
| System Serve integration | 3 scenarios: owned mapping cleanup, foreign mapping refusal, existing identical mapping preserved; Funnel never invoked |
| Stable listener regression | First failed on configured port 0 versus actual bound port; after correction, desktop startup/restart, proxy activation without restart, LAN recovery and Serve tests passed (7 scenarios, 224 assertions) |
| Browser player proof | Chromium 153.0.8010.12, two actual hosts, generated H.264/AAC file from a real peer, isolated libvlc worker, decoding and seeking beyond 12 s of 20.021 s; no page errors |
| Packaged native proof | Bun 1.4.0; backend false, database false, sandboxed manager, discovery CLI hint; unsafe SDK cookie rejected before remote navigation |
| Framework suite | 144 passed, 4 skipped, 0 failed, 890 assertions across 42 files; includes admission, client-only, TLS readiness and lifecycle |
| Go transport integration | `go test ./...` passed; local TLS forwarding, Range/Origin/headers/SSE and cancellation, without enrollment |
| Compiled server smoke | `http://127.0.0.1:47993`, expected PID; descriptor/owner/SSR 200; after enabling sharing, anonymous API 401/page 302, pairing 200, Playback library 200/host 403; shipped companion checksum and signature verified |
| Responsive Connections | Chromium 390 px viewport, 390 px document width, no page errors; desktop and mobile screenshots inspected |
| Static checks | Typecheck: 406 files, no errors. Biome: source, scripts, tests, configuration and evidence JSON; no errors or warnings |
| Packaging | Native macOS arm64 and standalone Bun builds completed; both include the signed companion, module notices and checksum manifest |

Browser and native acceptance scripts are `scripts/browser-remote-proof.ts` and
`scripts/native-remote-proof.ts`. They preserve reports while removing isolated credentials.
A native report with `gate: blocked-native-cookie` is evidence of refusal, not a successful
remote workspace or native media playback proof.
Sanitized fixture reports are retained in [evidence](evidence/).

An earlier parallel run passed 243 scenarios and timed out while waiting for a local peer in
the file-priority scenario. That file passed all nine scenarios across three isolated repeats.
The shared peer fixture now awaits its listener before exposing an address; resume and peer
addition failures are asserted explicitly. The final full serial run above passed on the final
code. Native proof timeouts observed during concurrent builds were rerun after builds finished;
the preserved native report is the completed packaged security-gate proof.

## Proof gate assessment

| Gate | Assessment |
| --- | --- |
| G1 provenance | Passed; pinned archives and source patches are reproducible |
| G2 admission | Source, framework and compiled paths covered; no static-response bypass; full HMR/browser matrix remains limited to the tested environment |
| G3 native cookie | Failed in packaged macOS SDK 2.0.2: setter discards HttpOnly; readback verification blocks navigation |
| G4 native LAN HTTPS host | Blocked on G3; headless TLS is tested |
| G5 sandboxed partitions | Public SDK implementation and earlier macOS partition/no-RPC probe; full safe remote acceptance awaits G3, including fullscreen/focus |
| G6 client-only | Packaged startup has neither backend nor database; isolated import graph |
| G7 secure storage | Explicit memory-only fallback available; persistent OS keyring on packaged platforms remains unverified |
| G8 browser matrix | Chromium passed; Safari/WebKit in-app remote player gated; physical mobile and other browsers remain unverified |
| G9 listener lifecycle | Explicit supervisor restart on same configured root; compiled custom lifecycle and real network recovery passed |
| G10 Serve | Ownership CLI fixtures passed; real CLI/version/OS matrix remains unverified |
| G11 leak surfaces | Anonymous/Playback documents, six data routes, library/detail/live and privileged denials covered; exhaustive browser/OS matrix remains open |
| G12 revocation | Active complete/incomplete reads, live stream, link revoke, logout and permission changes covered |
| G13 crash receipts | Add/remove restart replay and real SIGKILL move reconciliation covered |
| G14 network rollback | Crash rollback, timed confirmation and persisted confirmed TLS tested |
| G15 cross-origin media | Chromium proof passed; WebView2/WKWebView/WebKitGTK acceptance remains open |

## Dependencies that remain open

The pinned Electrobun macOS cookie setter omits HttpOnly. The proposed upstream SDK patch
in `vendor/patches/electrobun-2.0.2-macos-cookie.patch` sets Foundation's HttpOnly property and
normalizes SameSite; a small Foundation proof passed. It has **not** been compiled into the
SDK. Both the manager and Furin host check installed flags and refuse unsafe cookies. No
public bootstrap or certificate bypass was added. A rebuilt SDK must pass packaged acceptance.

Embedding tsnet does not route native WebView/Eden/media traffic. The pinned public SDK has no
per-session proxy/transport API. Zero-install native clients require a framework/SDK extension
and separate WKWebView, WebView2 and WebKitGTK transport proofs. A browser still requires a
route to private tailnet addresses. See the [comparison and dependency contract](embedded-tailscale.md).

Windows/Linux packages, physical phones, real tailnet enrollment, real certificate issuance,
production signing/notarization and persistent packaged keyrings are not claimed from macOS
source or fixture evidence. These are explicit release limits, not silently completed gates.

## Elysia best-practice review (2026-10-20)

Reviewed against https://next.elysiajs.com/essential/best-practice/ and the Elysia v2 skill
(feature folders with controller, model and service; returned errors; `decorate` for app-lifetime
dependencies; thin handlers passing explicit values).

- Thrown HTTP errors in services: 101 → 0 in `src/api`. Plugins, Jev, discovery, automation,
  AniList, desktop associations and native opening return `problem()` values propagated to their
  routes, so Eden infers each failure. Remaining throws are internal invariants, the generated
  AniList SDK requester contract (`AniListUnavailable`, converted to 502 in one place) and a
  locally caught legacy OAuth branch.
- Controllers thinned: remote access updates (`connections/update.ts`), linked-library anime
  plans, media-link issuance and description, playback positions (`playback/service.ts`),
  automation rule writes and the owner-only settings rule. Duplicated create/update logic removed.
- Dependency injection made consistent: service instances live in `plugin.ts` and reach handlers
  through named `decorate` plugins (linked libraries, media links, storage roots, database).
- Schemas moved from handlers to `model.ts` for the new modules; types inferred from them.
- Session cookies use Elysia's `cookie` jar instead of hand-built `Set-Cookie` strings.
- Role ranking and grant checks live once in `access/grants.ts` (macros, session view, UI);
  request classification in `access/admission.ts`. `callers` stays in `access/service.ts` because
  the test harness shares modules named `service.ts` between bundle and process.
- Promise chains replaced with async/await and synchronous queue reservations (logs, updates,
  plugins, Jev, automation).
- `scripts/route-types.ts` scans pages in a temporary data directory; type checking no longer
  opens the developer's own `Tofu-dev` instance.
- Stacked `.guard()` calls were verified to accumulate macros (no authorization gap).
- Access service split by responsibility (same folder): `service.ts` keeps identity, sessions,
  admission, stream interruption and the `callers` map (1023 → 540 lines); `invitations.ts`
  owns invitations and atomic redemption; `devices.ts` owns device grants and revocation;
  `tokens.ts` hashes and generates secrets. Routes receive `invitations` and `devices` through the
  access plugin's `decorate`. The recovery CLI gained `revoke-all` (integration-tested).
- The developer `Tofu-dev` database, previously migrated by a provisional `0002`, was repaired on
  2026-10-20 after a `.backup` copy to `Tofu-dev/backups/`; the repair was rehearsed on a copy,
  then the current migrations were applied and integrity checked. Data was unchanged.

## Desktop library rendering regression — 2026-10-20

The owner's live snapshot exposed a temporal-dead-zone error in `App`: the folder lookup
invoked a `find` callback that read `destination` before the library model initialized it.
Safe SSR did not execute this lookup because its host data is absent; the initial browser
render also passed until the live host snapshot arrived. Typecheck did not flag the reference
inside the callback. WebKit then displayed the route error boundary despite successful API reads.

The lookup now follows the model's destination declaration. The browser proof first opens
`/thread/default` and waits for the private folder path supplied by the real live stream,
then continues with remote playback and Connections. This failed before the correction and
passed after rebuilding. The macOS development package was rebuilt with isolated build data;
no running user application or personal database was stopped or modified. Typecheck passed
for 420 files, and lint passed for the changed component and proof script. Restart the running
application to load the reconstructed package.

## Connections setup spacing — 2026-10-20

The expanded network setup now has padding above its transport selector. Embedded Tailscale
uses an explicit vertical layout, a spaced action row and consistent description typography.
Transport options use equal columns on desktop and stacked 44 px targets on narrow screens;
installation choices wrap and long origins retain the existing address wrapping. The selected
installation group also has an accessible name. Verified in the collaborative preview with
light/dark themes and the embedded, system, proxy and LAN drafts, including a 390 px viewport
with 390 px document width. No sharing configuration or network enrollment was applied.

## Embedded HTTPS prerequisite and Connections integration — 2026-10-20

A user-enrolled node reached `Running` with a DNS name while tailnet HTTPS certificates
were still disabled. Enrollment and HTTPS eligibility are different states. The companion
now reports `httpsEnabled` on status reads, before any listener is opened. Connections
shows the missing prerequisite and links directly to Tailscale DNS settings. Apply returns
a typed 409 with the exact DNS / HTTPS Certificates step, preserving the disabled sharing
configuration. The HTTPS authorization remains an external Tailscale account decision;
Tofu does not change tailnet settings. The native component was rebuilt and signed locally.

Desktop workspace controls now live in Settings / Connections for the local native owner:
add/discover, open, reconnect, edit addresses, disconnect, forget and local startup selection.
The separately bundled host and backend share a process-local capability registry. Owner
admission and the desktop runtime check protect its narrow typed endpoints; credentials
remain in the native host keyring or explicit memory store. No new listener, remote bridge,
custom Eden transport or framework archive is introduced. Native boundary failures return
ordinary results and become typed API problems. Action requests reserve their queue before
awaiting. Playback and paired Administration sessions cannot read or invoke these controls.

Healthy local startup no longer opens the standalone manager. The native Servers menu
opens Connections through the trusted local backend bootstrap. The standalone document
remains available for client-only startup, local startup failure and explicit torrent-target
or incoming-link flows. The existing remote cookie and per-session networking gates remain.

Validation: the real Eden HTTPS prerequisite/retry integration passes against a simulated
companion pipe boundary, and existing Serve ownership tests pass. Access integration
verifies Playback and Administration denial of native catalog reads/actions. The packaged
macOS Connections workflow verifies the shared host catalog, unauthenticated rejection,
workspace controls and pairing dialog in the main UI, no horizontal overflow and no runtime
errors. Physical phone access and real TLS issuance are not established by these fixtures.

Final checks: typecheck passes for 426 files; lint passes for the changed implementation
and native harness. The rebuilt macOS package passes all seven Connections workflow checks,
including the HTTPS guidance before Apply, with no runtime errors. Client-only packaged proof
still opens its fallback manager without creating the local database and stops at the existing
HttpOnly SDK gate before creating an unsafe remote view. The user's running application and
real tailnet enrollment were left untouched; restart Tofu to load this rebuilt package.

## Guided embedded Tailscale connection — 2026-10-20

The explicit Connect action now starts an enrollment flow that polls status and enables
private remote access as soon as Tailscale reports the node Running with HTTPS eligibility.
There is no separate Check / Apply step for the local owner's embedded setup. Sign-in and
tailnet HTTPS consent remain visible external authorization steps. The companion queries
`LocalClient.QueryFeature("serve")`, as Tailscale's CLI does, to obtain the private HTTPS
consent URL; only official HTTPS login/console origins are accepted, with DNS settings as
a fallback. This requests instructions, never changes Serve mappings or enables Funnel.
The new approval endpoint is owner-only and returns typed failures.

Polling exists only for a user-started setup, is sequential and bounded to ten minutes, and
stops on cancel, navigation, error or completion. Cancellation prevents a later status result
from enabling sharing. Draft controls are locked during setup, and cancel is disabled while
the activation request is in flight. Account authorization and Tofu device invitations remain
separate; this flow does not grant a phone access merely because it joined the tailnet.

Guided-flow validation: three real Eden integration scenarios pass (165 assertions), including
owner-only HTTPS approval and unchanged access after a refused activation. The packaged macOS
workflow passes nine checks with no runtime errors: it cancels setup, simulates subsequent HTTPS
authorization at the companion pipe boundary, verifies sharing stays off, then resumes Connect
and observes automatic activation without Check or Apply. Typecheck passes for 426 files and
lint passes for the changed implementation and harness. The Go companion and desktop package
were rebuilt. No real account authorization, certificate issuance or user application state
was changed during these checks.

## Consolidation into the principal checkout — 2026-10-20

Remote Servers and the principal checkout's pending work were merged from their common
`325b548` baseline. Both original working trees, untracked sources, binary diffs and staged
patches were backed up before integration. Subsequent implementation and verification use
the principal checkout. The old feature worktree remains an unchanged recovery copy.

The integration preserves the principal checkout's Elysia beta.32, React 19.3.1, storage
recovery after device changes, player diagnostics and command recovery, and exact protected
Eden client. Routes now use the current Furin route IDs and live-query API. Explicit sync
opt-outs use `idempotent: false`; transactional mutations retain the enabled sync lifecycle,
and route invalidations use the handler's typed `invalidate()` operation. Shared plugin
credential-page metadata now lives with its browser-safe model rather than importing server
services into the client build.

Both Furin packages retain upstream `3a83c0d`. The desktop admission/client-only patches are
ported onto that baseline. A separate core patch gives AOT a child process with
IPC disconnect handling and awaited termination, releasing native instance locks
before the prerender child starts. See the active archives, checksums and source patches in
`vendor/README.md`. This does not bypass native cookie or embedded client-networking gates.

Consolidation validation: all 251 integration tests pass (15,325 assertions), typecheck
passes for 427 files, and lint passes for 392 files. The regenerated torrent worker passes
its source/bundle/host real-peer scenarios. Both framework patch suites pass (eight desktop
checks and five AOT checks). The principal checkout's macOS package builds successfully;
its Connections workflow passes nine checks without runtime errors. Chromium 153 verifies
real remote playback and seeking, no browser errors, and a 390 px Connections viewport.
The client-only native proof preserves the existing cookie gate and does not create a local
database. No running user application, personal database or real tailnet authorization was
changed. All further work uses the principal checkout; the old worktree is retained only
for recovery. The T3 thread's visual binding remains unchanged because its available tools
cannot rebind an already attached thread to an existing checkout.
