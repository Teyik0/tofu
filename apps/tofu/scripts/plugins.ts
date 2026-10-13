#!/usr/bin/env bun
import { resolve } from "node:path";
import { inspectPluginPackage } from "@tofu/plugins/server";
import {
  generatePlugins,
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
} from "./plugin-packages";

const usage = `Manage experimental trusted local Tofu plugins.

bun scripts/plugins.ts install <built-package-directory> --trust [--replace]
bun scripts/plugins.ts generate
bun scripts/plugins.ts uninstall <plugin-id>
bun scripts/plugins.ts list
bun scripts/plugins.ts inspect <built-package-directory>

--host <directory> overrides the Tofu application directory for development/testing.
Installation copies and pins inspected package files, skips install scripts, and compiles native routes.
--trust explicitly permits the package's client compiler and server code to execute.
--replace explicitly approves replacing an installed plugin pin. Restart/rebuild Tofu after changes.
Uninstall removes contributions and retains cached code, settings, credentials, and downloads.
`;

function extractHostDirectory(args: string[]): string {
  let hostDirectory = resolve(import.meta.dir, "..");
  const hostIndex = args.indexOf("--host");
  if (hostIndex !== -1) {
    const value = args[hostIndex + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--host requires a directory");
    }
    hostDirectory = resolve(value);
    args.splice(hostIndex, 2);
  }
  return hostDirectory;
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes("--help")) {
    console.log(usage);
    return;
  }
  const hostDirectory = extractHostDirectory(args);
  const command = args.shift();
  if (command === "generate" && args.length === 0) {
    await generatePlugins(hostDirectory);
    console.log("Generated native plugin contributions");
  } else if (command === "list" && args.length === 0) {
    console.log(JSON.stringify(await listInstalledPlugins(hostDirectory), null, 2));
  } else if (command === "inspect" && args.length === 1 && args[0]) {
    console.log(JSON.stringify(await inspectPluginPackage(resolve(args[0])), null, 2));
  } else if (command === "uninstall" && args.length === 1 && args[0]) {
    await uninstallPlugin({ hostDirectory, id: args[0] });
    console.log(`Uninstalled ${args[0]}; plugin data remains on disk`);
  } else if (command === "install") {
    const source = args.shift();
    if (!source || source.startsWith("--")) {
      throw new Error("install requires a built local package directory");
    }
    if (args.some((arg) => arg !== "--trust" && arg !== "--replace")) {
      throw new Error("Unknown install option");
    }
    await installPlugin({
      hostDirectory,
      replace: args.includes("--replace"),
      sourceDirectory: resolve(source),
      trust: args.includes("--trust"),
    });
    console.log(
      "Installed and compiled the trusted local plugin; rebuild/restart Tofu to activate it"
    );
  } else {
    throw new Error("Unknown plugin command. Use --help for usage.");
  }
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Plugin operation failed");
    process.exitCode = 1;
  }
}
