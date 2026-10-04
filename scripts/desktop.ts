import { join } from "node:path";

const root = join(import.meta.dir, "..");
const launcher = join(root, `build/dev-macos-${process.arch}/Tofu-dev.app/Contents/MacOS/launcher`);
if (!(await Bun.file(launcher).exists())) {
  const build = Bun.spawn([process.execPath, "scripts/build.ts", "desktop"], {
    cwd: root,
    stderr: "inherit",
    stdout: "inherit",
  });
  if ((await build.exited) !== 0) {
    throw new Error("La construction de Tofu a échoué");
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
