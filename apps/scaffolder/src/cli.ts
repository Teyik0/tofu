#!/usr/bin/env bun
import { scaffold } from "./scaffold";

const usage = `Create a Tofu plugin with Bun.

Usage: bun run apps/scaffolder/src/cli.ts <directory> [--name <plugin-id>] [--sdk <local-sdk-directory>] [--furin <local-furin-tarball>]

--name   Lowercase plugin ID (defaults to the destination directory name)
--sdk    Local @tofu/plugins package; defaults to this checkout's SDK
--furin  Local Furin preview tarball; defaults to this checkout's pinned preview
--help   Print this help

The SDK is experimental and unpublished. Generated projects use explicit local dependencies.
`;

async function main(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  const destination = args.shift();
  if (!destination || destination.startsWith("--")) {
    throw new Error("A project directory is required. Use --help for usage.");
  }
  let name: string | undefined;
  let sdk: string | undefined;
  let furin: string | undefined;
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value || value.startsWith("--")) {
      throw new Error(`A value is required for ${flag}`);
    }
    if (flag === "--name") {
      name = value;
    } else if (flag === "--sdk") {
      sdk = value;
    } else if (flag === "--furin") {
      furin = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  const result = await scaffold({ destination, furin, name, sdk });
  console.log(`Created ${result.name} in ${result.directory}`);
  console.log(
    `Next: cd ${JSON.stringify(result.directory)}, then bun install, bun run tscheck, bun run build, and bun run dev.`
  );
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Scaffolding failed");
  process.exitCode = 1;
}
