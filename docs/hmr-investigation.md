# Desktop HMR investigation — 2026-10-20

The experimental `@base-ui/utils@0.5.0` patch has been removed from the manifest,
lockfile, patch directory, and installed dependency. Both installed module formats
again contain the original `hooks = []` and `hooks.push(hook)` implementation.

## Confirmed: a temporary backend compilation error terminates desktop development

A separate minimal Furin desktop application reproduces this without importing
Tofu or Base UI:

1. Start a valid application with `bun --hot server.ts` and wait for native readiness.
2. Change an imported backend file from `export const revision = "one";` to
   `export const revision = ;` and leave it invalid until the next dependency scan.
3. The supervisor closes the running host and exits with `Bundle failed`.
4. Restore the valid file. The supervisor is already gone and cannot recover.

The reproduction recorded `failedOnIntermediateSave: true` and
`supervisorAliveAfterRepair: false`. This matches an agent saving an intermediate
state during a backend change; it is independent of React rendering.

The relevant installed sources are
`@teyik0/furin-electrobun/src/cli.ts` and `src/preload.ts`. In the restart loop:

```ts
await watcher.refresh();
backend = await launchDevBackend(root, generated, sdk, env, !!customHost);
```

`watcher.refresh()` runs `Bun.build()` to discover backend dependencies. A compiler
failure escapes the restart loop, reaches the preload's terminal error handler,
and calls `process.exit(1)`. That handler prints the aggregate message rather than
the compiler's individual diagnostics, explaining the unhelpful `Bundle failed`.

The appropriate fix belongs in the desktop supervisor: report a recoverable
compilation diagnostic, keep watching, and retry when the source is repaired.
It must retain the last known dependency graph, cover repair of an initially
invalid imported file, support cancellation while waiting, and initialize all
required application services before reopening a window. Genuine SDK failures
and unrecoverable resource-cleanup errors must remain distinct from source errors.
This investigation does not install that framework fix.

## Base UI hook-order error: previous attribution was not established

The earlier native trace did contain a React hook-order error in `TooltipRoot`.
Making registration idempotent suppressed it in that earlier test, but that alone
did not identify why a dependency was reevaluated or establish which layer was
responsible. No trace of the registration calls was collected in that first run.

The fresh comparisons used the unmodified dependency:

| Runtime and application | Browser | Changes | Result |
| --- | --- | --- | --- |
| Bun 1.4.3, minimal React and Base UI | Chromium 153 | 4 CSS, 2 component edits | No errors; controlled draft and document preserved |
| Bun 1.4.3, minimal Furin and Base UI | Chromium 153 | 4 CSS, 2 component edits | No errors; controlled draft and document preserved |
| Bun 1.4.0, minimal React and Base UI | Chromium 153 | 4 CSS, 2 component edits | No errors; controlled draft and document preserved |
| Bun 1.4.0, minimal Furin and Base UI | Chromium 153 | 4 CSS, 2 component edits | No errors; controlled draft and document preserved |
| Tofu web, Bun 1.4.3 | Chromium 153 | 3 CSS edits | No React errors |
| Tofu desktop, SDK Bun 1.4.0 | WKWebView and Chromium on the same backend | 18 logged update batches, including concurrent feature edits | No repeated hook-order error; one native host before shutdown |

The current native initial bundle was also inspected: it contained the original
array-based registration, not a cached copy of the removed patch. The native probe
observed HMR blobs without changing dependency code.

These results do not prove that Base UI is faultless, or that Furin caused the
original hook-order error. They do rule out presenting the earlier workaround as
a demonstrated root-cause fix. A future reproduction needs module identity and
evaluation traces at the point the hook count changes.

## Additional observations and limits

- Electrobun 2.0.2 pins Bun 1.4.0; the terminal runs Bun 1.4.3. The SDK explicitly
  rejects per-project Bun version selection. The minimal comparisons passed on
  both versions, so this difference is not established as the cause.
- A Tofu native shutdown exceeded the framework's five-second deadline and caused
  another terminal supervisor failure. The blocked cleanup operation was not
  isolated. Raising that deadline without identifying the operation is not a fix.
- A full Tofu web run on Bun 1.4.0 timed out waiting for a CSS update while the
  server logged recompilation taking over 18 seconds. It is not counted as a pass
  or as a React hook failure.
- The standalone Bun WKWebView harness timed out. Actual native observations use
  the Electrobun WKWebView, rather than treating that failed harness as evidence.
- Other feature edits were occurring in the principal checkout during the full
  Tofu trials. The decisive intermediate-save reproduction used a separate small
  fixture so those edits could not affect its result.

## Local evidence

Evidence is retained under `/tmp/tofu-hmr-investigation-20261020/`:

- `summary.json`, `bun-1.4.3-comparison.json`, `bun-1.4.0-comparison.json`:
  comparison results, including draft/document identity checks.
- `desktop-minimal/`, `minimal-desktop.log`, `intermediate-save.json`:
  the independent supervisor reproduction and repair outcome.
- `original-hook-order-error.log`: the original React error, retained for comparison.
- `native.log`, `native-blob-*.js`, `native-browser-output.log`:
  native console, observed HMR updates, and the second browser's observations.
- `compare.ts`, `tofu-browser.ts`, `native-browser.ts`, `native-probe.js`:
  diagnostic harnesses. These are local investigative artifacts, not application
  code or a replacement for a framework regression test.

Some temporary folders also contain disposable test authentication state; do not
publish the entire evidence directory as an archive.
