import { join } from "node:path";
import { desktopLauncher, hostDesktopTarget } from "../src/platform";

const root = join(import.meta.dir, "..");
const launcher = desktopLauncher(root, hostDesktopTarget(), "dev");
if (!(await Bun.file(launcher).exists())) {
  const build = Bun.spawn([process.execPath, "run", "build:desktop"], {
    cwd: root,
    stderr: "inherit",
    stdout: "inherit",
  });
  if ((await build.exited) !== 0) {
    throw new Error("Tofu build failed");
  }
}
const app = Bun.spawn([launcher], {
  cwd: root,
  env: { ...process.env, TOFU_MODE: "desktop" },
  stderr: "inherit",
  stdout: "inherit",
});
process.on("SIGINT", () => app.kill("SIGINT"));
await app.exited;
