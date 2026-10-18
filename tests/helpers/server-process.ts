import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import type { InstanceConfig } from "../../src/types";
import { waitFor } from "./torrent";
export function launchServer(config: InstanceConfig, watchEntry?: string) {
  const command = watchEntry ? ["--watch", "--no-clear-screen", watchEntry] : ["src/server.ts"];
  const shutdownPath = join(config.dataDir, `test-shutdown-${crypto.randomUUID()}`);
  let applicationPid: number | undefined;
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
      ipc(message) {
        if (typeof message === "number") {
          applicationPid = message;
        }
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const output = (async () => {
    const parts = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return parts.join("\n");
  })();
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
          if (!watchEntry && pid !== applicationPid) {
            return null;
          }
          return (await treaty<Api>(url).api.health.get()).response?.ok ? url : null;
        },
        (url) => url !== null,
        // Watch mode also compiles Furin's development graph before opening the listener.
        watchEntry ? 30_000 : 15_000
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
            if (watchEntry) {
              await waitFor(
                () => Bun.file(join(config.dataDir, "server.json")).exists(),
                (exists) => !exists,
                8000
              );
              child.kill();
            }
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
