# Tofu background mode and distribution

Release and development can run together: development uses `Tofu-dev` for its databases and default downloads, a distinct native identifier, and an independent port. Release keeps existing data in `Tofu`. An OS lock and a profile marker prevent accidental database sharing. See the [development guide](development.md#data-and-configuration).

In **Preferences**, enable **Run in background**, then save. Closing the window or choosing **Switch to background mode now** destroys the native window and its WebView. The Bun process keeps the HTTP server, torrents, and automations running. The Tofu menu bar icon lets you open the app, open the same interface in a browser, check for updates, or quit completely. Without this preference, closing the window quits the app.

This architecture avoids keeping a hidden WebView in memory. It reuses the web mode engine and server rather than introducing a second service. Bun, BitTorrent connections, and active tasks still consume resources. It does not start automatically at login or keep macOS awake.

`bun run test:background` enables the preference through the real WebView, closes it during a transfer with a real peer, checks that no WebView remains, verifies automation access and the completed file's SHA-256, then recreates a single window. Injection remains exclusively opt-in through `TOFU_SMOKE_SCRIPT`.

## Release checks

The [Teyik0/Tofu](https://github.com/Teyik0/Tofu) repository is **public**: checks and installer downloads use the GitHub REST API anonymously, with no personal access token. Tofu checks stable releases at startup and every six hours, well under the unauthenticated rate limit. A new version compatible with the machine's OS and architecture triggers a native notification once per version and a **Download** banner. The local server streams the matching installer instead of opening an external browser. The download follows GitHub's redirect to the signed asset URL without forwarding credentials.

After downloading, choose **Quit Tofu** and install the new version. On macOS, open the DMG and replace the app in Applications. On Windows, extract the entire ZIP before running `Tofu-Setup.exe`; its `.installer` directory contains required payload and metadata. On Linux, extract the `.tar.gz` and run `./installer`. Preferences and downloaded files are preserved. Automatic app replacement is not implemented: the Electrobun updater expects its own artifact metadata structure, while releases here ship plain installers per target. Checks and downloads therefore use the GitHub API on the Bun side. If the repository ever becomes private again, anonymous checks would fail and token-based access would need to be reintroduced.

## GitHub Actions pipeline

- **Checks** validates types, lint, tests with real peers, and the desktop build on every push to main or pull request, using parallel native runners for all four release targets.
- **Release** builds and tests on macOS ARM64, Windows x64, and Linux x64/ARM64. A `vX.Y.Z` tag matching `package.json` exactly publishes the installers, Electrobun archives and metadata, and `SHA256SUMS` to the repository's releases. Publication requires all four installers. The native version comes from the same package.json. Electrobun 2.0.2 and Hutch do not distribute a macOS Intel runtime; upstream support is required before adding an x64 runner.
- Tests run exactly `bun test --parallel --isolate --bail` in both workflows. Bun downloads and the Hutch toolchain are cached per OS, architecture, Bun version and dependency lockfile. Superseded check runs are cancelled.
- A manual **Release** run tests the build and retains artifacts for seven days without publishing a release. Native UI tests require a graphical session; macOS is the locally validated native platform until the other platforms pass their own UI smoke tests.

| Target | Runner | Installer |
| --- | --- | --- |
| macOS ARM64 | `macos-15` | `Tofu-X.Y.Z-macos-arm64.dmg` |
| Windows x64 | `windows-2025` | `Tofu-X.Y.Z-win-x64.zip` |
| Linux x64 | `ubuntu-24.04` | `Tofu-X.Y.Z-linux-x64.tar.gz` |
| Linux ARM64 | `ubuntu-24.04-arm` | `Tofu-X.Y.Z-linux-arm64.tar.gz` |

The ZIP and Linux archive retain Electrobun's installer payload structure; renaming an extracted Windows executable would separate it from the sidecar files it needs. Signing and notarization are configured only on the macOS runner.

To prepare a version, update package.json, run `bun run tscheck`, `bun run fix`, `bun run test`, `bun run build:desktop`, `bun run test:native`, and `bun run test:background`, then commit and push the matching tag. Follow the project's Git hooks before committing and pushing. `bun run build:release` produces the installer for the current platform locally.

## Free macOS distribution

An Apple Developer subscription is not required to build or run Tofu. Without Apple secrets, `bun run build:release` uses the free ad hoc identity (`codesign --sign -`). Electrobun signs the app, its native libraries, the self-extracting installer, and the DMG during packaging, and verifies the app signatures before publishing artifacts. This preserves the same packaging pipeline rather than repairing a finished installer whose embedded app would still have an invalid signature.

Ad hoc signing provides a valid local signature, but does not identify the developer to Apple or notarize the app. After copying a downloaded Tofu app to Applications and attempting to open it, approve it in **System Settings → Privacy & Security → Open Anyway**. See [Apple's instructions](https://support.apple.com/en-ie/102445). This is a per-app exception; keep Gatekeeper enabled.

If macOS does not offer **Open Anyway**, first verify the downloaded DMG against the release's `SHA256SUMS`. For this verified Tofu copy only, remove its download quarantine and open it:

```sh
xattr -dr com.apple.quarantine /Applications/Tofu.app
open /Applications/Tofu.app
```

No Apple account, signing secrets, or notarization submission is needed for this distribution path. Users must approve each newly downloaded version when macOS requests it.

## Optional Apple signing

To distribute with a Developer ID signature and Apple notarization instead, configure all of these Actions secrets together:

| Secret | Value |
| --- | --- |
| APPLE_CERTIFICATE_P12 | Developer ID Application certificate with its private key, exported as P12 and base64 encoded |
| APPLE_CERTIFICATE_PASSWORD | P12 password |
| ELECTROBUN_DEVELOPER_ID | Full Developer ID Application identity name |
| APPLE_API_KEY_P8 | App Store Connect private key contents for notarization |
| ELECTROBUN_APPLEAPIKEY | Key identifier |
| ELECTROBUN_APPLEAPIISSUER | Issuer identifier |

The pipeline imports the certificate into a temporary keychain and cleans up keys after the build. Publication uses only the job's temporary GITHUB_TOKEN with Contents write permission.
