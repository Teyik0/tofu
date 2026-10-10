// biome-ignore-all lint/performance/noAwaitInLoops: Read a spawned host's readiness stream sequentially.
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("the Furin desktop host initializes Tofu, guards requests and preserves real transfers across restart", async () => {
  const context = await fixture(512 * 1024, []);
  const dataDir = join(context.directory, "desktop-state");
  const entry = `
    import { startDesktopBackend } from "@teyik0/furin-electrobun/host";
    const backend = await startDesktopBackend(() => import("./src/server.ts"), process.env.TOFU_DATA_DIR, "dev");
    process.on("SIGTERM", async () => { await backend.stop(); process.exit(0); });
    console.log(JSON.stringify({ cookie: backend.cookie, url: backend.origin }));
  `;
  const launch = async () => {
    const child = Bun.spawn([process.execPath, "--eval", entry], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        TOFU_DATA_DIR: dataDir,
        TOFU_DOWNLOAD_DIR: join(context.directory, "desktop-downloads"),
        TOFU_MODE: "server",
        TOFU_PROFILE: "dev",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const deadline = setTimeout(() => child.kill("SIGTERM"), 20_000);
    const reader = child.stdout.getReader();
    let output = "";
    try {
      while (child.exitCode === null) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error(await stderr);
        }
        output += new TextDecoder().decode(value);
        const line = output.split("\n").find((item) => item.startsWith('{"cookie":'));
        if (line) {
          const { cookie, url } = JSON.parse(line) as { cookie: string; url: string };
          return {
            page: () => fetch(`${url}/library`, { headers: { cookie } }),
            request(path: string, init: RequestInit | undefined) {
              const headers = new Headers(init?.headers);
              headers.set("cookie", cookie);
              return fetch(`${url}/api${path}`, { ...init, headers });
            },
            async stop() {
              child.kill("SIGTERM");
              await child.exited;
            },
            url,
          };
        }
      }
      throw new Error(await stderr);
    } catch (error) {
      child.kill("SIGTERM");
      await child.exited;
      throw error;
    } finally {
      clearTimeout(deadline);
      reader.releaseLock();
    }
  };
  let host: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    host = await launch();
    expect((await fetch(`${host.url}/api/state`)).status).toBe(403);
    expect((await host.request("/state", undefined)).status).toBe(200);
    const page = await host.page();
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Tofu");
    const added = await host.request("/torrents", json({ paused: false, source: context.magnet }));
    expect(added.status).toBe(200);
    const { id } = (await added.json()) as { id: string };
    const state = async () => {
      if (!host) {
        throw new Error("The desktop host is unavailable");
      }
      return (await (
        await host.request(`/state?selected=${id}`, undefined)
      ).json()) as DashboardState;
    };
    await waitFor(state, (value) => value.detail?.status === "seeding");
    const bytes = await (
      await host.request(`/torrents/${id}/files/0/content`, undefined)
    ).arrayBuffer();
    expect(Bun.SHA256.hash(bytes, "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
    await host.request(`/torrents/${id}/pause`, json({}));
    await host.stop();
    host = await launch();
    const restored = await waitFor(state, (value) => value.detail?.status === "paused");
    expect(restored.detail?.id).toBe(id);
    expect((await fetch(`${host.url}/api/state`)).status).toBe(403);
  } finally {
    await host?.stop();
    await context.close();
  }
}, 30_000);
