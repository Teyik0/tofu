const excludedDirectory = /[\\/](?:node_modules|\.furin|\.cache|\.tofu-plugins)(?:[\\/]|$)/;

import { cp, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugin } from "../../scripts/plugin-packages";

/** A real relocated application with an installed plugin and isolated downloads/database. */
export async function extensionHost() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tofu-extension-host-")));
  const workspace = join(import.meta.dir, "../../../..");
  const host = join(directory, "apps/tofu");
  try {
    await cp(join(workspace, "apps/tofu"), host, {
      filter: (entry) => !excludedDirectory.test(entry),
      recursive: true,
    });
    await Promise.all([
      symlink(
        join(workspace, ".github"),
        join(directory, ".github"),
        process.platform === "win32" ? "junction" : "dir"
      ),
      symlink(
        join(workspace, "package"),
        join(directory, "package"),
        process.platform === "win32" ? "junction" : "dir"
      ),
      symlink(
        await realpath(join(workspace, "apps/tofu/node_modules")),
        join(host, "node_modules"),
        process.platform === "win32" ? "junction" : "dir"
      ),
    ]);
    const source = join(directory, "plugin");
    await Bun.write(
      join(source, "package.json"),
      JSON.stringify({
        name: "tofu-extension-fixture",
        tofuPlugin: {
          apiVersion: "0.0.0",
          client: "./client.js",
          id: "fixture",
          server: "./server.ts",
        },
        type: "module",
        version: "0.0.0",
      })
    );
    await cp(join(import.meta.dir, "extension-plugin.ts"), join(source, "server.ts"));
    await Bun.write(join(source, "client.js"), "export const ui = {};\n");
    await installPlugin({
      hostDirectory: host,
      replace: false,
      sourceDirectory: source,
      trust: true,
    });
    return {
      directory,
      host,
      [Symbol.asyncDispose]: () => rm(directory, { force: true, recursive: true }),
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}
