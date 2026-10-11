import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.resolve("node-datachannel/package.json")));
const native = Bun.spawn([process.execPath, "../prebuild-install/bin.js", "-r", "napi"], {
  cwd: directory,
  stderr: "inherit",
  stdout: "inherit",
});
if ((await native.exited) !== 0) {
  throw new Error("Unable to install the native WebTorrent module");
}
