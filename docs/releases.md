# Tofu background mode and distribution

Release and development can run together: development uses `Tofu-dev` for its databases and default downloads, a distinct macOS identifier, and an independent port. Release keeps existing data in `Tofu`. An OS lock and a profile marker prevent accidental database sharing. See the [development guide](development.md#data-and-configuration).

In **Preferences**, enable **Run in background**, then save. Closing the window or choosing **Switch to background mode now** destroys the native window and its WebView. The Bun process keeps the HTTP server, torrents, and automations running. The Tofu menu bar icon lets you open the app, open the same interface in a browser, check for updates, or quit completely. Without this preference, closing the window quits the app.

This architecture avoids keeping a hidden WebView in memory. It reuses the web mode engine and server rather than introducing a second service. Bun, BitTorrent connections, and active tasks still consume resources. It does not start automatically at login or keep macOS awake.

`bun run test:background` enables the preference through the real WebView, closes it during a transfer with a real peer, checks that no WebView remains, verifies automation access and the completed file's SHA-256, then recreates a single window. Injection remains exclusively opt-in through `TOFU_SMOKE_SCRIPT`.

## Private release access

Code and installers remain in the **private** [Teyik0/Tofu](https://github.com/Teyik0/Tofu) repository. Users must be repository collaborators. In **Preferences → Updates → Connect GitHub**, each user configures a personal GitHub token limited to this repository with **Contents: read** permission. The token stays on the Bun side, in `release-access.json` in the data directory, accessible only to the local account (0600 permissions). The API and journal never return its value. **Disconnect** removes the saved access.

Tofu checks stable releases at startup and every six hours. A new version compatible with the Mac's architecture triggers a native notification once per version and a **Download** banner. The local server streams the DMG installer using the user's personal access. It never forwards the token to the GitHub asset server during redirection.

After downloading, choose **Quit Tofu**, open the DMG, and replace the app in Applications. Preferences and downloaded files are preserved. Automatic app replacement is not implemented: the Electrobun updater expects artifacts accessible by URL, while this repository's releases require GitHub authentication. Checks and downloads therefore use the authenticated GitHub API on the Bun side.

## GitHub Actions pipeline

- **Checks** validates types, lint, tests with real peers, and the desktop build on every push to main or pull request.
- **Release** builds and tests on macOS Apple Silicon. A `vX.Y.Z` tag matching `package.json` exactly publishes the DMG, Electrobun archives and metadata, and `SHA256SUMS` to the private repository's releases. The native version comes from the same package.json. Electrobun 2.0.2 and Hutch do not distribute a macOS Intel runtime; upstream support is required before adding an x64 runner.
- A manual **Release** run tests the build and retains artifacts for seven days without publishing a release. Native UI tests run locally on a Mac with a graphical session.

To prepare a version, update package.json, run `bun run tscheck`, `bun run fix`, `bun run test`, `bun run build:desktop`, `bun run test:native`, and `bun run test:background`, then commit and push the matching tag. Follow the project's Git hooks before committing and pushing. `bun run build:release` also produces the DMG locally.

## Apple signing

Without Apple secrets, the workflow produces unsigned development installers. For signed and notarized distribution, configure all of these Actions secrets together:

| Secret | Value |
| --- | --- |
| APPLE_CERTIFICATE_P12 | Developer ID Application certificate with its private key, exported as P12 and base64 encoded |
| APPLE_CERTIFICATE_PASSWORD | P12 password |
| ELECTROBUN_DEVELOPER_ID | Full Developer ID Application identity name |
| APPLE_API_KEY_P8 | App Store Connect private key contents for notarization |
| ELECTROBUN_APPLEAPIKEY | Key identifier |
| ELECTROBUN_APPLEAPIISSUER | Issuer identifier |

The pipeline imports the certificate into a temporary keychain and cleans up keys after the build. Publication uses only the job's temporary GITHUB_TOKEN with Contents write permission. Users' personal tokens are not CI secrets.
