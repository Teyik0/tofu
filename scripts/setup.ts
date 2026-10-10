import { existsSync } from "node:fs";
import { join } from "node:path";

const directory = join(import.meta.dir, "../node_modules/node-datachannel");
if (existsSync(join(directory, "build/Release/node_datachannel.node"))) {
  process.exit(0);
}
const native = Bun.spawn([process.execPath, "../prebuild-install/bin.js", "-r", "napi"], {
  cwd: directory,
  stderr: "inherit",
  stdout: "inherit",
});
if ((await native.exited) !== 0) {
  throw new Error("Unable to install the native WebTorrent module");
}
