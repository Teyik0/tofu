import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { version } from "../package.json";

const root = join(import.meta.dir, "..");
async function command(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: { ...process.env, HUTCH_HOME: process.env.HUTCH_HOME ?? join(root, ".cache/hutch") },
    stderr: "inherit",
    stdout: "inherit",
  });
  if ((await child.exited) !== 0) {
    throw new Error(`La commande a échoué : ${args.join(" ")}`);
  }
}
const release = Bun.argv[2] === "release";
process.env.TOFU_RELEASE = release ? "1" : "0";
await command(["node_modules/@teyik0/furin/src/cli/index.ts", "build", "--target", "bun"], root);
if (Bun.argv[2] === "desktop" || release) {
  await command(["--bun", "node_modules/electrobun/bin/electrobun.cjs", "prepare"], root);
  const runtime = join(root, "runtime");
  await mkdir(runtime, { recursive: true });
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
      "node_modules/electrobun/bin/electrobun.cjs",
      "build",
      release ? "--env=stable" : "--env=dev",
    ],
    root
  );
  if (release) {
    const directory = join(root, "artifacts");
    const installers = [...new Bun.Glob(`macos-${process.arch}-*.dmg`).scanSync(directory)];
    if (installers.length !== 1 || !installers[0]) {
      throw new Error("Un unique installateur DMG est attendu dans artifacts");
    }
    await rename(
      join(directory, installers[0]),
      join(directory, `Tofu-${version}-macos-${process.arch}.dmg`)
    );
  }
}
