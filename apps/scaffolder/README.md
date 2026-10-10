# Tofu plugin scaffolder

Create a developer plugin against this checkout's experimental SDK and pinned Furin preview:

```sh
bun run apps/scaffolder/src/cli.ts ../my-plugin
cd ../my-plugin
bun install
bun run tscheck
bun run build
bun test
bun run dev
```

Use `--name plugin-id` for an ID different from the directory name, `--sdk /path/to/package/plugins` for another compatible local SDK, or `--furin /path/to/furin-preview.tgz` for a local Furin archive. The CLI refuses every existing destination and does not execute package scripts or install dependencies. `--help` prints the options.

The template uses one `definePlugin` definition and distinct server/client entries. Backend Elysia routes consume host capabilities through `.use(core)`; UI contributes a native Furin route factory injected with the actual thread layout, a thread action dialog, and typed persistent settings. Furin clients and hooks are direct SDK reexports. The controlled developer shell uses explicit empty fixtures, not a second engine. It compiles and serves the same page adapter shape that the Tofu host generates.

Local SDK workspace catalogs cannot be resolved by an external `file:` dependency. The scaffolder copies the SDK source into `.tofu-sdk`, preserves conditional exports, removes development scripts, and resolves its dependencies to this checkout's exact catalog versions. It copies the provided Furin tarball into `.tofu-vendor` and uses relative file dependencies so the generated project can be moved. These are reviewable developer snapshots; publication needs a compatible SDK distribution.

The Furin preview compiles a fixed route graph. Native plugin page additions require host adapter generation and rebuild/restart. Source route factories are retained for that compilation; dynamically loading an arbitrary browser route after installation is not supported by this preview.

`bun test apps/scaffolder/tests` exercises the public CLI, checks safe rejection, and installs a generated project in a temporary directory. It then typechecks, builds backend/browser boundaries and the real Furin host, runs persistence/lifecycle tests, and serves a native preview over loopback HTTP.
