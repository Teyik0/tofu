import { existsSync } from "node:fs";
import { cp, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { version } from "../package.json";
import { resolveAniListClient } from "../src/api/feeds/anilist-client";
import { hostDesktopTarget, installerExtension, installerName } from "../src/platform";
import { generatePlugins, materializePluginRuntime } from "./plugin-packages";

const root = join(import.meta.dir, "..");
await generatePlugins(root);
async function command(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: { ...process.env, HUTCH_HOME: process.env.HUTCH_HOME ?? join(root, ".cache/hutch") },
    stderr: "inherit",
    stdout: "inherit",
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let status: number;
  try {
    status = await child.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
  if (status !== 0) {
    throw new Error(`Command failed : ${args.join(" ")}`);
  }
}
const release = Bun.argv[2] === "release";
const development = Bun.argv[2] === "dev-desktop";
process.env.TOFU_RELEASE = release ? "1" : "0";
if (release && process.platform === "darwin" && !process.env.ELECTROBUN_DEVELOPER_ID) {
  process.env.ELECTROBUN_DEVELOPER_ID = "-";
  console.log("Using free ad hoc macOS signing; first launch requires manual approval.");
}
if (Bun.argv[2] !== "desktop" && !release && !development) {
  await command(
    [
      join(dirname(Bun.resolveSync("@teyik0/furin", root)), "cli/index.ts"),
      "build",
      "--target",
      "bun",
    ],
    root
  );
}
if (Bun.argv[2] === "desktop" || release || development) {
  await command(
    [
      "--bun",
      join(dirname(Bun.resolveSync("electrobun/package.json", root)), "bin/electrobun.cjs"),
      "prepare",
    ],
    root
  );
  const runtime = join(root, "runtime");
  await mkdir(runtime, { recursive: true });
  await materializePluginRuntime(root, join(runtime, "plugins"));
  const helperBuild = await Bun.build({
    entrypoints: [join(root, "scripts/desktop-protocol.ts")],
    outdir: runtime,
    target: "bun",
  });
  if (!helperBuild.success) {
    throw new AggregateError(helperBuild.logs, "Protocol helper build failed");
  }
  await Bun.write(
    join(runtime, "anilist-client.json"),
    JSON.stringify(
      resolveAniListClient(release ? "release" : "dev", process.env.TOFU_ANILIST_CLIENT_ID)
    )
  );
  await Bun.write(
    join(runtime, "package.json"),
    JSON.stringify({
      dependencies: { "parse-torrent": "11.0.24", webtorrent: "3.0.21" },
      private: true,
    })
  );
  await command(["install", "--ignore-scripts"], runtime);
  await command(
    ["../prebuild-install/bin.js", "-r", "napi"],
    join(runtime, "node_modules/node-datachannel")
  );
  await command(
    [
      "--bun",
      join(dirname(Bun.resolveSync("@teyik0/furin-electrobun", root)), "cli.ts"),
      development ? "dev" : "build",
      ...(development ? [] : [release ? "--env=stable" : "--env=dev"]),
    ],
    root
  );
  if (development) {
    process.exit(0);
  }
  const generated = join(root, ".furin/electrobun");
  await cp(join(generated, "build"), join(root, "build"), { recursive: true });
  if (existsSync(join(generated, "artifacts"))) {
    await cp(join(generated, "artifacts"), join(root, "artifacts"), { recursive: true });
  }
  if (release) {
    const directory = join(root, "artifacts");
    const target = hostDesktopTarget();
    const suffix = target.platform === "macos" ? "*.dmg" : `*-Setup.${installerExtension(target)}`;
    const installers = [
      ...new Bun.Glob(`${target.platform}-${target.arch}-${suffix}`).scanSync(directory),
    ];
    if (installers.length !== 1 || !installers[0]) {
      throw new Error(
        `Expected exactly one ${target.platform}/${target.arch} installer in artifacts`
      );
    }
    await rename(join(directory, installers[0]), join(directory, installerName(version, target)));
  }
}
