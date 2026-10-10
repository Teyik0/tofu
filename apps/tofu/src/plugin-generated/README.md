# Managed local plugin contributions

`bun scripts/plugins.ts inspect /path/to/built-plugin` reads metadata, validates the experimental SDK version and package containment, and computes a package hash without importing plugin code. `install /path/to/built-plugin --trust` copies that reviewed package into `.tofu-plugins/packages`, installs additional dependencies with Bun and lifecycle scripts disabled, and writes an atomic pin registry. Replacing a pin also requires `--replace`.

The host owns one engine. Installed backend factories receive its SDK `PluginCore` facade; they never receive the engine object. The generated server registry loads factories lazily after validating their package pins. The client registry imports only source UI entries and supplies native Furin page adapters beneath `/extensions/<plugin-id>/<page-id>`, independently of the plugin's own relative page path. Source layouts and factories are compiled with the real host thread layout. Route graph changes require generation and a rebuild/restart.

`empty.server.ts` and `empty.client.ts` are checked-in baseline contracts. `server.ts`, `client.ts`, the generated extension page adapters, and `.tofu-plugins` are local generated files. Generation preserves identical files so repeated development startup does not trigger another HMR cycle. It removes only stale adapters carrying its own header.

The official IDs `anilist`, `jev`, `nyaa`, `tsundere`, and `c411` are reserved. Installation rejects those identities before copying or executing package code, and generated pages cannot overwrite developer-authored routes.

Shared SDK, React, Furin, Elysia, and UI packages resolve through the host. Additional package dependencies are installed in a separate managed directory so Bun cannot rewrite the inspected source or its lockfile. Portable local `file:` dependencies must be included in the inspected package; unresolved workspace/catalog references must be resolved by the plugin author first.

`materializePluginRuntime(hostDirectory, destinationDirectory)` verifies the installed pins and copies their package source and dependency files to a movable runtime cache. Desktop builds place this at `runtime/plugins` and copy it beside the bundled Bun entry as `bun/plugins`. The loader supports the packaged cache and source/web-build caches without embedding a developer's absolute path. Backend definitions may describe UI, while SSR/browser rendering consumes the statically compiled client registry so components share the host's React identity.

Uninstall removes the pin and generated contributions. Cached code, settings, credentials, and torrent data remain on disk. This experimental installation path executes explicitly trusted code and does not provide a sandbox.
