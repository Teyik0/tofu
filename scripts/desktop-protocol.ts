import { dirname, join } from "node:path";
import { forwardNativeAuthorization } from "../src/server/desktop-protocol";
import { currentInstanceConfig } from "../src/server/instance";

try {
  const [, , dataDir, url] = Bun.argv;
  if (!(dataDir && url) || Bun.argv.length !== 4) {
    throw new Error("Invalid protocol invocation");
  }
  process.env.TOFU_DATA_DIR = dataDir;
  const instance = await currentInstanceConfig();
  if (!instance.desktop) {
    throw new Error("The protocol helper requires a packaged Tofu application");
  }
  if (
    !(await forwardNativeAuthorization({
      dataDir: instance.dataDir,
      profile: instance.profile,
      url,
    }))
  ) {
    const launcher = join(
      dirname(process.execPath),
      process.platform === "win32" ? "launcher.exe" : "launcher"
    );
    const child = Bun.spawn([launcher], {
      env: { ...process.env, TOFU_OPEN_URL: url },
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
    child.unref();
  }
} catch {
  // Never put callback URLs or access tokens in logs.
  console.error("Unable to finish AniList authorization. Open Tofu and connect again.");
  process.exitCode = 1;
}
