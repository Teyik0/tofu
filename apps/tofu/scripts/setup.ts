import { dirname, join } from "node:path";

const native = Bun.spawn([process.execPath, "../prebuild-install/bin.js", "-r", "napi"], {
  cwd: dirname(Bun.resolveSync("node-datachannel/package.json", import.meta.dir)),
  stderr: "inherit",
  stdout: "inherit",
});
if ((await native.exited) !== 0) {
  throw new Error("Unable to install the native WebTorrent module");
}
const prepare = Bun.spawn(
  [
    process.execPath,
    "--bun",
    join(
      dirname(Bun.resolveSync("electrobun/package.json", import.meta.dir)),
      "bin/electrobun.cjs"
    ),
    "prepare",
  ],
  {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HUTCH_HOME: process.env.HUTCH_HOME ?? join(import.meta.dir, "../.cache/hutch"),
    },
    stderr: "inherit",
    stdout: "inherit",
  }
);
if ((await prepare.exited) !== 0) {
  throw new Error("Unable to prepare Electrobun");
}
