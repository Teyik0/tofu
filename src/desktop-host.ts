import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopConfig } from "@teyik0/furin-electrobun";
import { runStandardDesktopHost } from "@teyik0/furin-electrobun/host";
import { currentInstanceConfig } from "./api/lib/instance";

// Resolve the canonical SDK before changing the development working directory.
const sdk = await import("electrobun/main");
process.env.TOFU_MODE = "desktop";
const development: { root: string; serverEntry: string; config: DesktopConfig } | undefined =
  process.env.FURIN_DESKTOP_DEV
    ? JSON.parse(readFileSync(process.env.FURIN_DESKTOP_DEV, "utf8"))
    : undefined;
if (development) {
  for (const name of ["TOFU_DATA_DIR", "TOFU_DOWNLOAD_DIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      process.env[name] = resolve(development.root, value);
    }
  }
}
const config: DesktopConfig =
  development?.config ??
  JSON.parse(readFileSync(join(dirname(Bun.main), "furin-host.json"), "utf8"));
const instance = currentInstanceConfig();
const testScript = process.env.TOFU_SMOKE_SCRIPT ?? process.env.FURIN_NATIVE_TEST_SCRIPT;
// Resolve options synchronously so Furin captures native events before startup yields.
const desktop = await runStandardDesktopHost(sdk, {
  config,
  dataDir: instance.dataDir,
  load: () => {
    // SDK metadata resolves from its launch directory; Furin loads it before the app.
    if (development) {
      process.chdir(development.root);
    }
    return import(
      pathToFileURL(development?.serverEntry ?? join(dirname(Bun.main), "../furin/app.js")).href
    );
  },
  mode: development ? "dev" : "build",
  openBrowser: !!development && process.env.FURIN_DEV_OPEN_BROWSER === "1",
  root: development?.root ?? dirname(Bun.main),
  testScript: testScript
    ? readFileSync(resolve(development?.root ?? process.cwd(), testScript), "utf8")
    : undefined,
});
if (desktop && !development) {
  const shutdown = () => {
    void desktop.quit().catch(console.error);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
