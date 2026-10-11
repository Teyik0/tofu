import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../src/api";
import type { DashboardState, ServerInfo } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

test.each(["success", "reported", "throw", "cancelled"] as const)(
  "the standard desktop host preserves real transfers during update handoff: %s",
  async (handoff) => {
    const context = await fixture(256 * 1024, []);
    const root = join(import.meta.dir, "..");
    const dataDir = join(context.directory, "native-state");
    const downloadPath = join(context.directory, "native-downloads");
    let result: { error: string | null; vetoed: boolean } | null = null;
    let nativeError: { detail: string; message: string } | null = null;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        import { runStandardDesktopHost } from "@teyik0/furin-electrobun/host";
        const events = new Map();
        let vetoed = false;
        let closed;
        const info = { error: "", hash: "next", version: "0.3.0", updateReady: true, updateAvailable: true };
        const sdk = {
          default: { events: {
            on(name, callback) { const list = events.get(name) ?? []; list.push(callback); events.set(name, list); },
            off(name, callback) { events.set(name, (events.get(name) ?? []).filter(item => item !== callback)); },
          } },
          BrowserWindow: class {
            webviewId = 1;
            webview = { on() {}, executeJavascript() {}, setNavigationRules() {} };
            on(name, callback) { if (name === "close") closed = callback; }
            show() {} activate() {} close() { closed?.(); } requestClose() { this.close(); }
          },
          BrowserView: { getAll: () => [] },
          Tray: class { visible = true; setMenu() {} on() {} remove() { this.visible = false; } },
          ApplicationMenu: { setApplicationMenu() {}, on() {} },
          Utils: {
            paths: { appData: process.env.TOFU_DATA_DIR },
            openExternal: () => true, openPath: () => true, showItemInFolder() {},
            openFileDialog: async () => [],
            showMessageBox: async (message) => {
              process.send({ kind: "native-error", ...message });
              return { response: 0 };
            },
            showNotification() {}, quit() {},
          },
          Updater: {
            getLocalInfo: async () => {
              for (const url of ["https://example.com/invalid", process.env.TEST_NATIVE_MAGNET]) {
                for (const callback of events.get("open-url") ?? []) callback({ data: { url } });
              }
              return { name: "Tofu Dev", identifier: "app.tofu.torrents.dev", channel: "dev", version: "0.2.4" };
            },
            checkForUpdate: async () => info, downloadUpdate: async () => {}, updateInfo: () => info,
            onStatusChange() {},
            getStatusHistory: () => process.env.TEST_HANDOFF === "cancelled" ? [] : [{ status: "launching-new-version" }],
            async applyUpdate() {
              const event = {};
              for (const callback of events.get("before-quit") ?? []) callback(event);
              vetoed = event.response?.allow === false;
              if (process.env.TEST_HANDOFF === "reported") info.error = "Update helper failed";
              if (process.env.TEST_HANDOFF === "throw") throw new Error("Update helper failed");
            },
          },
        };
        const desktop = await runStandardDesktopHost(sdk, {
          config: {
            app: { name: "Tofu Dev", identifier: "app.tofu.torrents.dev" },
            window: { width: 1400, height: 940 },
            tray: { mac: { image: "public/tray-template.png" }, win: { image: "public/icon.png" }, linux: { image: "public/icon.png" } },
          },
          root: process.cwd(), dataDir: process.env.TOFU_DATA_DIR, mode: "dev",
          load: () => import("./src/server.ts"),
        });
        process.on("message", async (message) => {
          if (message === "install") {
            let error = null;
            try { await desktop.updates.install(); } catch (failure) { error = failure.message; }
            process.send({ error, vetoed });
          } else if (message === "stop") {
            await desktop.quit(); process.exit(0);
          }
        });
      `,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          TEST_HANDOFF: handoff,
          TEST_NATIVE_MAGNET: context.magnet,
          TOFU_DATA_DIR: dataDir,
          TOFU_DOWNLOAD_DIR: downloadPath,
          TOFU_MODE: "desktop",
          TOFU_PROFILE: "dev",
        },
        ipc(
          message:
            | { error: string | null; vetoed: boolean }
            | { kind: "native-error"; detail: string; message: string }
        ) {
          if ("kind" in message) {
            nativeError = message;
          } else {
            result = message;
          }
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const deadline = setTimeout(() => child.kill(), 25_000);
    try {
      const server = await waitFor(
        async () => {
          if (child.exitCode !== null) {
            throw new Error((await output).join("\n"));
          }
          const file = Bun.file(join(dataDir, "server.json"));
          return (await file.exists()) ? ((await file.json()) as ServerInfo) : null;
        },
        (value) => value !== null
      );
      if (!server) {
        throw new Error("The native host did not start");
      }
      const client = treaty<Api>(server.url, { headers: { cookie: server.cookie ?? "" } }).api;
      expect((await treaty<Api>(server.url).api.state.get()).status).toBe(403);
      expect(expectSuccess(await client.instance.get())).toMatchObject({
        dataDir,
        desktop: true,
        profile: "dev",
      });
      const shown = await waitFor(
        () => Promise.resolve(nativeError),
        (value) => value !== null,
        2000
      );
      expect(shown).toMatchObject({
        detail: "Only magnet links and .torrent files can be opened",
        message: "Unable to open link",
      });
      const id = context.seed.infoHash;
      const state = async () => expectSuccess(await client.state.get()) as DashboardState;
      await waitFor(state, (value) =>
        value.torrents.some((torrent) => torrent.id === id && torrent.status === "seeding")
      );
      await client.settings.put({ ...(await state()).settings, runInBackground: true });
      expect((await client.desktop.background.post({})).status).toBe(200);
      await waitFor(
        async () => expectSuccess(await client.desktop.get()),
        (value) => value.background
      );
      expect((await client.desktop.open.post({})).status).toBe(200);
      await client.torrents({ id }).pause.post({});
      child.send("install");
      const installed = await waitFor(
        () => Promise.resolve(result),
        (value) => value !== null
      );
      expect(installed?.vetoed).toBe(false);
      if (handoff === "success") {
        expect(installed?.error).toBeNull();
        expect((await client.state.get()).status).toBe(503);
      } else {
        expect(installed?.error).toContain(
          handoff === "cancelled" ? "cancelled" : "Update helper failed"
        );
        expect((await client.health.get()).status).toBe(200);
        expect((await state()).torrents.find((torrent) => torrent.id === id)?.status).toBe(
          "paused"
        );
        const bytes = torrentBytes(
          await client.torrents({ id }).files({ index: "0" }).content.get()
        );
        expect(Bun.SHA256.hash(bytes, "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
        expect((await client.desktop.background.post({})).status).toBe(200);
      }
      expect(await Bun.file(join(downloadPath, context.seed.name)).bytes()).toEqual(context.bytes);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) {
        child.send("stop");
      }
      const timer = setTimeout(() => child.kill(), 5000);
      await child.exited;
      clearTimeout(timer);
      await context.close();
    }
  },
  30_000
);
