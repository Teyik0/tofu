---
name: tofu-verify
description: Verify Tofu code changes using its existing Bun integration tests and native build workflows. Use after implementing behavior changes or when investigating a regression.
---

# Verify Tofu changes

Read the root AGENTS.md and the current diff before choosing checks.

Identify the changed behavior, its callers, and the surfaces it reaches:
API, browser, desktop, remote connections, and workers where applicable.

## Static checks

Run:

```sh
bun fix && bun tscheck
```

Keep failures outside the requested scope separate from regressions
introduced by the change. Report both accurately.

## Integration checks

Choose existing scenarios by the behavior affected. Useful entry points:

- Torrent transfers: apps/tofu/tests/torrents/transfers.test.ts
- Torrent lifecycle: apps/tofu/tests/torrents/lifecycle.test.ts
- Startup and cleanup: apps/tofu/tests/lifecycle/
- Remote access and synchronization: apps/tofu/tests/remote/
- AniList: apps/tofu/tests/anilist/
- Plugins and automation: apps/tofu/tests/plugins/
- Updates: apps/tofu/tests/updates/

Inspect the relevant tests before selecting files.

Run focused files or directories through the existing package script:

```sh
bun run --filter @tofu/desktop test tests/torrents/transfers.test.ts
```

This preserves code generation and the repository's test runner settings.

For a reproducible logic bug, demonstrate the failure before the fix
when practical, then rerun the same scenario after it.

Inspect apps/tofu/tests/helpers/ before creating fixtures. Follow AGENTS.md's
integration rules; keep test setup out of production code.

When shared fixtures or services change, include the existing scenarios
that consume them.

## Native and startup checks

Run bun run build when packaging, native integration, startup, or build
behavior changes.

Inspect the existing apps/tofu/scripts/ workflows before selecting native checks.
Use isolated state and temporary downloads. Do not use the developer's
running application or personal database as a test fixture.

For visual changes, capture the affected interaction in the actual
interface when verification is authorized. Static checks alone do not
prove visual behavior.

## Handoff

Report:

- The behavior verified.
- Commands run and their results.
- Surfaces or scenarios not exercised.
- Any remaining failure and whether it predates the change.

Never describe an unexecuted check as passing.
