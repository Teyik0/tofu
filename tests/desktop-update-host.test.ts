import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";

test("an approved update bypasses the Furin quit veto after saving a real peer transfer", async () => {
  const context = await fixture(256 * 1024, []);
  const root = join(import.meta.dir, "..");
  const hostDir = join(context.directory, "bun");
  const serverDir = join(context.directory, "furin");
  await Promise.all([mkdir(hostDir), mkdir(serverDir)]);
  const entry = join(hostDir, "host.ts");
  await Bun.write(
    join(hostDir, "furin-host.json"),
    JSON.stringify({ app: { identifier: "tofu-test" } })
  );
  await Bun.write(
    join(serverDir, "app.js"),
    `
    import { Elysia } from ${JSON.stringify(import.meta.resolve("elysia"))};
    import { desktopApp } from ${JSON.stringify(join(root, "node_modules/@teyik0/furin-electrobun/src/server.ts"))};
    import { apiPlugin } from ${JSON.stringify(join(root, "src/api/index.ts"))};
    import { onStartup, onShutdown } from ${JSON.stringify(join(root, "src/api/lib/lifecycle.ts"))};
    export default new Elysia().use(desktopApp({ onStartup, onShutdown })).use(apiPlugin);
  `
  );
  await Bun.write(
    entry,
    `
    import { runDesktopHost } from ${JSON.stringify(join(root, "node_modules/@teyik0/furin-electrobun/src/host.ts"))};
    import { desktopHostSdk } from ${JSON.stringify(join(root, "src/api/modules/desktop/host-sdk.ts"))};
    import { DesktopController } from ${JSON.stringify(join(root, "src/api/modules/desktop/service.ts"))};
    import { applicationHost } from ${JSON.stringify(join(root, "src/api/lib/host.ts"))};
    import { onStartup, onShutdown } from ${JSON.stringify(join(root, "src/api/lib/lifecycle.ts"))};
    const handlers = [];
    let status = [];
    let nativeQuits = 0;
    const sdk = {
      default: { events: { on(name, handler) { if (name === "before-quit") handlers.push(handler); } } },
      Tray: class { visible = true; setMenu() {} on() {} remove() {} },
      Utils: { paths: { appData: process.env.TOFU_DATA_DIR }, quit() { nativeQuits++; } },
      Updater: {
        async applyUpdate() {
          const event = {};
          for (const handler of handlers) handler(event);
          status = [{ status: event.response?.allow === false ? "idle" : "launching-new-version" }];
        },
        updateInfo: () => ({ error: "", updateReady: true }),
        getStatusHistory: () => status,
      },
    };
    try {
      let backend;
      let desktop;
      await runDesktopHost(desktopHostSdk(sdk), async ({ startBackend }) => {
        ({ backend } = await startBackend({ dataDir: process.env.TOFU_DATA_DIR }));
        let core = await applicationHost.core;
        desktop = new DesktopController({
          sdk, backend, engine: () => core.engine, smokeScript: null,
          name: "Tofu test", profile: "dev", publicDir: ${JSON.stringify(join(root, "public"))},
          checkUpdates: async () => {}, shutdown: backend.stop, prepareUpdate: onShutdown,
          recover: async () => { throw new Error("The native update was vetoed by Furin"); },
        });
      });
      const call = async (path, body) => {
        const response = await fetch(backend.origin + "/api" + path, {
          headers: { cookie: backend.cookie, "content-type": "application/json" },
          ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) throw new Error(await response.text());
        return response;
      };
      const { id } = await (await call("/torrents", { source: process.env.TOFU_TEST_MAGNET, paused: false })).json();
      const deadline = Date.now() + 15000;
      while ((await (await call("/torrents/" + id)).json()).progress !== 1) {
        if (Date.now() > deadline) throw new Error("Transfer timed out");
        await Bun.sleep(30);
      }
      await desktop.installUpdate();
      if (nativeQuits !== 0) throw new Error("The host attempted an ordinary quit during update handoff");
      await onStartup(new AbortController().signal);
      const response = await call("/torrents/" + id + "/files/0/content");
      console.log(Bun.SHA256.hash(await response.arrayBuffer(), "hex"));
      await backend.stop();
    } catch (error) { console.error(error); process.exitCode = 1; }
  `
  );
  const child = Bun.spawn([process.execPath, entry], {
    cwd: root,
    env: {
      ...process.env,
      FURIN_DESKTOP_DEV: "",
      TOFU_DATA_DIR: join(context.directory, "host-state"),
      TOFU_DOWNLOAD_DIR: join(context.directory, "host-downloads"),
      TOFU_MODE: "server",
      TOFU_PROFILE: "dev",
      TOFU_TEST_MAGNET: context.magnet,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), 25_000);
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(output).toContain(Bun.SHA256.hash(context.bytes, "hex"));
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
    await context.close();
  }
}, 30_000);
