import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import type { InstanceConfig } from "../../src/types";
import { waitFor } from "./torrent"; // Bun 1.4.2's diagnostic from the pinned WebTorrent's optional uTP probe.
// Match the complete notice so unrelated stderr before or after it still fails.
export function launchServer(config: InstanceConfig, hotEntry?: string) {
  const command = hotEntry ? ["--hot", hotEntry] : ["src/server.ts"];
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
      },
      ipc() {
        // Enable the parent-to-child shutdown channel; the child sends no messages.
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
          if (pid !== child.pid) {
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
      if (child.exitCode === null) {
        // Windows termination cannot deliver a POSIX signal; ask the child to run its shutdown handler.
        if (process.platform === "win32") {
          child.send("shutdown");
        } else {
          child.kill("SIGTERM");
        }
      }
      await child.exited;
    },
  };
}
