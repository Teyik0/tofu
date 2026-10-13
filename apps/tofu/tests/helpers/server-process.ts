import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api/index";
import type { InstanceConfig, ServerInfo } from "../../src/types";
import { waitFor } from "./torrent";
export function launchServer(config: InstanceConfig, watchEntry?: string) {
  const command = watchEntry ? ["--watch", "--no-clear-screen", watchEntry] : ["src/server.ts"];
  const shutdownPath = join(config.dataDir, `test-shutdown-${crypto.randomUUID()}`);
  const identityPath = join(tmpdir(), `tofu-test-process-${crypto.randomUUID()}`);
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
        TOFU_TEST_PID: identityPath,
        TOFU_TEST_SHUTDOWN: process.platform === "win32" ? shutdownPath : undefined,
      },
      ipc() {
        // Watch-mode subprocesses use the channel without depending on readiness messages.
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
      let descriptorPid: number | undefined;
      let expectedPid: number | undefined;
      let healthStatus: number | undefined;
      try {
        const address = await waitFor(
          async () => {
            if (child.exitCode !== null) {
              throw new Error(await output);
            }
            const info = Bun.file(join(config.dataDir, "server.json"));
            if (!(await info.exists())) {
              return null;
            }
            const { pid, url } = (await info.json()) as ServerInfo;
            descriptorPid = pid;
            const identity = Bun.file(identityPath);
            expectedPid = (await identity.exists()) ? Number(await identity.text()) : undefined;
            if (!watchEntry && pid !== expectedPid) {
              return null;
            }
            const health = await treaty<Api>(url).api.health.get();
            healthStatus = health.status;
            return health.response?.ok ? url : null;
          },
          (url) => url !== null
        );
        if (!address) {
          throw new Error("The Tofu server did not start");
        }
        return address;
      } catch (cause) {
        throw new Error(
          `The test server did not become ready: child=${child.pid}, expected=${expectedPid}, descriptor=${descriptorPid}, health=${healthStatus}`,
          { cause }
        );
      }
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
        await rm(identityPath, { force: true });
      }
    },
  };
}
