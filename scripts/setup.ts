import { join } from "node:path";

const directory = join(import.meta.dir, "../node_modules/node-datachannel");
const native = Bun.spawn([process.execPath, "../prebuild-install/bin.js", "-r", "napi"], {
  cwd: directory,
  stderr: "inherit",
  stdout: "inherit",
});
if ((await native.exited) !== 0) {
  throw new Error("Unable to install the native WebTorrent module");
}
