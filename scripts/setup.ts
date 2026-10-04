import { join } from "node:path";

const native = Bun.spawn([process.execPath, "../prebuild-install/bin.js", "-r", "napi"], {
  cwd: join(import.meta.dir, "../node_modules/node-datachannel"),
  stderr: "inherit",
  stdout: "inherit",
});
if ((await native.exited) !== 0) {
  throw new Error("Installation du module natif WebTorrent impossible");
}
const prepare = Bun.spawn(
  [process.execPath, "--bun", "node_modules/electrobun/bin/electrobun.cjs", "prepare"],
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
  throw new Error("Préparation Electrobun impossible");
}
