import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import type { SavedServer } from "../../src/native/catalog";
import { waitFor } from "./poll";

export interface RemoteServerFixture {
  server: SavedServer;
  token: string;
}

function availablePort() {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data: () => undefined,
    },
  });
  const { port } = listener;
  listener.stop();
  return port;
}

export async function application(options?: {
  entry?: string;
  provider?: string;
  remoteServers?: RemoteServerFixture[];
}) {
  const directory = await mkdtemp(join(tmpdir(), "tofu-integration-"));
  const dataDir = join(directory, "state");
  const downloadPath = join(directory, "downloads");
  const resources = new AsyncDisposableStack();
  resources.defer(() => rm(directory, { force: true, recursive: true }));

  return {
    directory,
    downloadPath,
    async start(listen?: { port?: number; onMessage?: (message: unknown) => void }) {
      const shutdownPath = join(directory, `shutdown-${crypto.randomUUID()}`);
      const port = listen?.port ?? availablePort();
      const origin = `http://127.0.0.1:${port}`;
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          join(import.meta.dir, "preload.ts"),
          options?.entry ?? "src/server.ts",
          String(port),
        ],
        {
          cwd: join(import.meta.dir, "../.."),
          env: {
            ...process.env,
            FURIN_APP_DATA_DIR: undefined,
            NODE_ENV: "development",
            TOFU_DATA_DIR: dataDir,
            TOFU_DISCOVERY: "0",
            TOFU_DOWNLOAD_DIR: downloadPath,
            TOFU_MODE: "server",
            TOFU_TAILSCALE_CLI: join(directory, "tailscale-not-installed"),
            TOFU_TEST_PROVIDER: options?.provider,
            TOFU_TEST_REMOTE_SERVERS: options?.remoteServers
              ? JSON.stringify(options.remoteServers)
              : undefined,
            TOFU_TEST_SHUTDOWN: process.platform === "win32" ? shutdownPath : undefined,
          },
          ipc: listen?.onMessage,
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const output = (async () => {
        const streams = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return streams.join("\n");
      })();
      let stopped = false;
      async function stop() {
        if (stopped) {
          return;
        }
        stopped = true;
        let forced = false;
        const deadline = setTimeout(() => {
          forced = true;
          child.kill("SIGKILL");
        }, 8000);
        try {
          if (child.exitCode === null) {
            if (process.platform === "win32") {
              await Bun.write(shutdownPath, "shutdown");
            } else {
              child.kill("SIGTERM");
            }
          }
          const code = await child.exited;
          if (forced || code !== 0) {
            throw new Error(`Application shutdown failed (${code}).\n${await output}`);
          }
        } finally {
          clearTimeout(deadline);
        }
      }
      try {
        const url = await waitFor(
          async () => {
            if (child.exitCode !== null) {
              throw new Error(`Application startup failed.\n${await output}`);
            }
            try {
              const response = await fetch(`${origin}/.well-known/tofu`);
              return response.ok ? origin : null;
            } catch {
              return null;
            }
          },
          (value) => value !== null,
          20_000
        );
        if (!url) {
          throw new Error("Application did not publish its address");
        }
        resources.defer(stop);
        const client = treaty<Api>(url, {
          async onResponse(response) {
            if (response.headers.has("content-disposition")) {
              return await response.arrayBuffer();
            }
          },
        }).api;
        return { child, client, stop, url };
      } catch (error) {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
        throw new Error(`${String(error)}\n${await output}`, { cause: error });
      }
    },
    [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
  };
}
