# Embedded Tailscale decision and proof

User steering, 2026-10-19: make Tailscale part of Tofu's primary hosting experience.
An existing system installation remains an explicit alternative.

## Decision

Use a Tofu-owned Go companion built with `tailscale.com/tsnet` pinned to **v1.104.1**
(the official stable release checked on 2026-10-19), with Go's module checksums and a
reproducible `CGO_ENABLED=0`, `-trimpath`, empty build-ID build. The companion is a
separate executable inside the signed native application resources. It runs only
when the owner starts enrollment or enables a previously enrolled transport. It
never starts a system daemon, modifies routes, installs a VPN, or calls Funnel.

Control uses inherited stdin/stdout pipes, not a control HTTP port. Each bounded JSON
message has a request ID. Only start, status, serve, stop and logout are implemented;
there is no arbitrary URL fetch, dial, shell command or local target input. The only
forwarding target is the existing Tofu listener on `127.0.0.1:<port>`. EOF and process
shutdown close tsnet and its listeners. Its independent node identity lives in a
0700 directory in this installation's private data directory. It must not be copied
when cloning a server. Tofu pairing credentials and the AniList token never enter it.

`tsnet.ListenTLS` accepts private HTTPS connections and a Go streaming reverse proxy
forwards them to the **sole existing `apiPlugin` listener**. This is TLS termination,
like an external reverse proxy, not another Elysia application or client transport.
Forwarding headers are reconstructed from the actual incoming connection and the
node's own name. Cookies, Origin, Range, HEAD and streaming bodies retain their
semantics; no response buffering, transcoding or client URL rewriting is introduced.
Tofu admission, device permissions, CSRF and revocation remain mandatory.

Tailnet enrollment requires the user's Tailscale login and any administrator approval.
The explicit Connect action guides sign-in and HTTPS consent, then checks status and enables
private access automatically. The companion requests the private Serve consent URL through
`LocalClient.QueryFeature("serve")`, with the official DNS settings page as fallback. It never
requests Funnel. Cancelling setup stops automatic activation; no certificate or tailnet
authorization is bypassed. Polling stops on navigation, error or a ten-minute timeout.
Network enrollment grants no Tofu permissions. Tofu's invitation is a separate step.
Different tailnets require authorized node sharing or an appropriate network policy;
Tofu does not discover all users' nodes. A browser still needs a network route into
the tailnet, normally system Tailscale, or another configured HTTPS exposure.

## Native client proof: blocked by SDK surface

Inspected the shipped Electrobun **2.0.2 macos-arm64** SDK, specifically
`api/sdks/main/core/BrowserView.ts` and `api/sdks/main/proc/native.ts`.
`BrowserViewOptions` supports partition, sandbox and navigation rules. `Session`
supports cookies and storage clearing. **Neither exposes a proxy configuration or
socket transport for a native WebView/session.** A successful `tsnet.Dial` proves
only Go connectivity, not WKWebView, WebView2, WebKitGTK, Eden or libvlc connectivity.

Consequently zero-install **desktop client** routing is not claimed. Do not insert
an Eden fetcher, localhost application proxy, rewritten origin or certificate bypass.
A supported implementation requires an Electrobun SDK extension providing per-session
HTTPS CONNECT transport with remote DNS, strict destination restrictions and lifecycle
ownership. Each backend must then prove normal origin/TLS checks, host-only HttpOnly
cookies, per-server partition isolation, navigation denial, SSE, bounded Range reads,
seeking, cancel, revocation, COOP/COEP and libvlc worker playback. macOS WKWebView,
Windows WebView2 and Linux WebKitGTK need separate implementation and packaged tests.
Until then native clients use an existing OS route; embedded hosting is independent.
This is a concrete framework/SDK dependency, not a reason to change `src/lib/client.ts`.

## Additional native security gate

Packaged macOS testing found that Electrobun 2.0.2 ignores `httpOnly` in its cookie setter.
The upstream source at `e424efbc8af0315e565811fcef0920d3b757e3fc` confirms the omission in
`package/src/native/macos/nativeWrapper.mm:sessionSetCookie`. Both the native remote manager
and Furin TLS host read installed flags back and refuse opening when protections are lost.
Native LAN HTTPS is disabled for this pinned SDK. The proposed upstream patch is in
`vendor/patches/`; it has not been compiled into a replacement SDK. This gate also applies
to clients with a system Tailscale route.

## Alternatives inspected

| Option | Actual dependency | Packaging / lifecycle | Decision |
| --- | --- | --- | --- |
| Official tsnet | Go userspace network stack | Companion per target; process can be stopped/reaped independently | Selected for hosting |
| Official libtailscale | Go compiled to C archive/shared library | FFI/ABI ownership and cross-platform build needed; no WebView routing API | No advantage for this host boundary |
| `mastermakrela/tailscale-js` | Bun FFI and a libtailscale shared library | README lists macOS/Linux prebuilds, separate shared library, shutdown and first-TLS-request issues; wraps Bun.serve | Not a drop-in for the shared Elysia listener; no Windows or WebView proof |
| `vibecook-dev/truffle` | Native addon / companion and a larger mesh API | README currently requires installed authenticated Tailscale; broad discovery/transport surface | Does not prove this application's zero-install requirement |

A TypeScript API does not remove the Go/native binary. Bun's FFI documentation calls
FFI experimental and recommends Node-API for a more stable native interface. Neither
community binding resolves the SDK's missing per-view network configuration.

## Evidence and release gates

- Compile companion on the development machine; run transport integration against
  a local HTTP provider boundary without enrolling a real account.
- Test the real single Tofu listener through a local TLS forwarding fixture, including
  Origin/CSRF, pairing, safe SSR, Range bytes, SSE cancellation and revocation.
- No actual tailnet enrollment, real certificate issuance, physical mobile or other-OS
  packaged validation is implied by those tests. Account enrollment is user-controlled.
- Release must include the matching companion, upstream licenses, target checksums and
  application signing. Windows and Linux require their own packaged acceptance.

Primary references (checked 2026-10-19):

- [tsnet overview](https://tailscale.com/docs/features/tsnet)
- [tsnet Server API: ListenTLS, Dial, HTTPClient and LocalClient](https://tailscale.com/docs/reference/tsnet-server-api)
- [Official libtailscale source](https://github.com/tailscale/libtailscale)
- [Tailscale v1.104.1](https://github.com/tailscale/tailscale/releases/tag/v1.104.1)
- [tailscale-js source and stated limits](https://github.com/mastermakrela/tailscale-js)
- [Truffle source and installation requirements](https://github.com/vibecook-dev/truffle)
- [Bun FFI stability](https://bun.sh/docs/runtime/ffi)
