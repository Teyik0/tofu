import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import type { InstanceConfig } from "../../src/types";
import { waitFor } from "./torrent";
export function launchServer(config: InstanceConfig, watchEntry?: string) {
  const command = watchEntry ? ["--watch", "--no-clear-screen", watchEntry] : ["src/server.ts"];
  const shutdownPath = join(config.dataDir, `test-shutdown-${crypto.randomUUID()}`);
  const child = Bun.spawn(
    [process.execPath, "--preload", join(import.meta.dir, "process-control.ts"), ...command],
    {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        TOFU_DATA_DIR: config.dataDir,
        TOFU_DOWNLOAD_DIR: config.downloadPath,
        TOFU_MODE: "server",
        TOFU_PORT: String(config.port),
        TOFU_PROFILE: config.profile,
        TOFU_TEST_SHUTDOWN: process.platform === "win32" ? shutdownPath : undefined,
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then((parts) => parts.join("\n"));
  return {
    child,
    output,
    async ready() {
      const address = await waitFor(
        async () => {
          if (child.exitCode !== null) {
            throw new Error(await output);
          }
          const info = Bun.file(join(config.dataDir, "server.json"));
          if (!(await info.exists())) {
            return null;
          }
          const { pid, url } = (await info.json()) as { pid: number; url: string };
          if (!watchEntry && pid !== child.pid) {
            return null;
          }
          return (await treaty<Api>(url).api.health.get()).response.ok ? url : null;
        },
        (url) => url !== null
      );
      if (!address) {
        throw new Error("The Tofu server did not start");
      }
      return address;
    },
    async stop() {
      let forced = false;
      const deadline = setTimeout(() => {
        forced = true;
        child.kill();
      }, 10_000);
      try {
        if (child.exitCode === null) {
          // Windows cannot deliver SIGTERM; the preload asks the application to shut down.
          if (process.platform === "win32") {
            await Bun.write(shutdownPath, "shutdown");
          } else {
            child.kill("SIGTERM");
          }
        }
        await child.exited;
        if (forced) {
          throw new Error(`The test server did not shut down within 10 seconds.\n${await output}`);
        }
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
