// biome-ignore-all lint/performance/noAwaitInLoops: Read a spawned host's readiness stream sequentially.
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test.each(["desktop", "web"])(
  "the %s host rejects startup when the torrent engine cannot open its download directory",
  async (mode) => {
    const context = await fixture(4096, []);
    const downloadPath = join(context.directory, "blocked-downloads");
    await Bun.write(downloadPath, "This is a file, not a download directory.");
    const command =
      mode === "web"
        ? [process.execPath, "src/server.ts"]
        : [
            process.execPath,
            "--eval",
            `
        import { startDesktopBackend } from "@teyik0/furin-electrobun/host";
        try {
          const backend = await startDesktopBackend(() => import("./src/server.ts"), process.env.TOFU_DATA_DIR, "dev");
          console.log("Listening before the engine was ready");
          await backend.stop();
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
        }
      `,
          ];
    const child = Bun.spawn(command, {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        TOFU_DATA_DIR: join(context.directory, "failed-startup-state"),
        TOFU_DOWNLOAD_DIR: downloadPath,
        TOFU_MODE: "server",
        TOFU_PORT: "0",
        TOFU_PROFILE: "dev",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const deadline = setTimeout(() => child.kill("SIGTERM"), 20_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).not.toContain("Listening before the engine was ready");
      expect(stdout).not.toContain("is ready");
      expect(stderr).toContain(downloadPath);
      expect(
        await Bun.file(join(context.directory, "failed-startup-state/server.json")).exists()
      ).toBe(false);
      expect(await Bun.file(downloadPath).text()).toBe("This is a file, not a download directory.");
    } finally {
      clearTimeout(deadline);
      child.kill("SIGTERM");
      await child.exited;
      await context.close();
    }
  },
  30_000
);

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
            page: (path: string) =>
              fetch(`${url}${path}`, { headers: { cookie }, redirect: "manual" }),
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
    const page = await host.page("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>All torrents</h1>");
    const destination = await host.request(
      "/destinations",
      json({ downloadPath: join(context.directory, "thread-downloads"), name: "Peer transfers" })
    );
    expect(destination.status).toBe(200);
    const { id: destinationId } = (await destination.json()) as { id: string };
    const added = await host.request(
      "/torrents",
      json({ destinationId, paused: false, source: context.magnet })
    );
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
    const home = await host.page("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('<strong title="source.bin">');
    const thread = await host.page(`/thread/${destinationId}`);
    expect(thread.status).toBe(200);
    const threadHtml = await thread.text();
    expect(threadHtml).toContain("<h1>Peer transfers</h1>");
    expect(threadHtml).toContain('<strong title="source.bin">');
    const defaultThread = await host.page("/thread/default");
    expect(defaultThread.status).toBe(200);
    expect(await defaultThread.text()).not.toContain('<strong title="source.bin">');
    expect((await host.page("/thread/missing-thread")).status).toBe(404);
    const options = await host.page("/options");
    expect(options.status).toBe(200);
    const optionsHtml = await options.text();
    expect(optionsHtml).toContain("Changes apply automatically.");
    expect(optionsHtml).not.toContain('id="settings-form"');
    expect(optionsHtml).toContain('aria-label="Settings sections"');
    expect(optionsHtml).toContain('href="/options/appearance"');
    expect(optionsHtml).not.toContain('id="appearance-theme"');
    expect(optionsHtml).not.toContain('id="destination-path"');
    const appearance = await host.page("/options/appearance");
    expect(appearance.status).toBe(200);
    const appearanceHtml = await appearance.text();
    expect(appearanceHtml).toContain('id="appearance-theme"');
    expect(appearanceHtml).not.toContain('id="destination-path"');
    expect(appearanceHtml).not.toContain('data-slot="sidebar-container"');
    const downloads = await host.page("/options/downloads");
    expect(downloads.status).toBe(200);
    const downloadsHtml = await downloads.text();
    expect(downloadsHtml).toContain('id="destination-path"');
    expect(downloadsHtml).toContain('id="limit-download"');
    expect(downloadsHtml).not.toContain('id="appearance-theme"');
    const updates = await host.page("/options/updates");
    expect(updates.status).toBe(200);
    const updatesHtml = await updates.text();
    expect(updatesHtml).toContain('class="settings-updates"');
    expect(updatesHtml).not.toContain('id="destination-path"');
    const plugins = await host.page("/plugins");
    expect(plugins.status).toBe(200);
    const pluginsHtml = await plugins.text();
    expect(pluginsHtml).toContain('aria-label="Plugin sections"');
    expect(pluginsHtml).toContain('href="/plugins/sources"');
    const sources = await host.page("/plugins/sources");
    expect(sources.status).toBe(200);
    const sourcesHtml = await sources.text();
    expect(sourcesHtml).toContain('id="plugin-nyaa"');
    expect(sourcesHtml).not.toContain('id="plugin-jev"');
    expect(sourcesHtml).not.toContain('id="plugin-anilist"');
    expect(sourcesHtml).not.toContain('data-slot="sidebar-container"');
    const intelligence = await host.page("/plugins/intelligence");
    expect(intelligence.status).toBe(200);
    const intelligenceHtml = await intelligence.text();
    expect(intelligenceHtml).toContain('id="key-jev"');
    expect(intelligenceHtml).not.toContain('id="plugin-nyaa"');
    const integrations = await host.page("/plugins/integrations");
    expect(integrations.status).toBe(200);
    const integrationsHtml = await integrations.text();
    expect(integrationsHtml).toContain('id="plugin-anilist"');
    expect(integrationsHtml).not.toContain('id="plugin-jev"');
    const navigation = await host.page("/_furin/data?path=/plugins/sources");
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).not.toContain("__furinError");
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
