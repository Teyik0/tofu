import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServerInfo } from "../../src/types";
import { waitFor } from "./torrent";

export async function launchNativeUpdateHost(options: {
  directory: string;
  dataDir: string;
  downloadPath: string;
  handoff: "success" | "reported" | "throw" | "cancelled";
  magnet: string;
  directorySelectionFile?: string;
}) {
  const root = join(import.meta.dir, "../..");
  const bundle = join(options.directory, "native-bundle");
  const runtime = join(bundle, "Resources/app/bun");
  const launchDirectory = join(bundle, process.platform === "darwin" ? "MacOS" : "bin");
  await mkdir(runtime, { recursive: true });
  await mkdir(launchDirectory, { recursive: true });
  await symlink(join(root, "node_modules"), join(bundle, "node_modules"), "junction");
  const entry = join(runtime, "index.ts");
  await Bun.write(
    entry,
    `
        import { runStandardDesktopHost } from ${JSON.stringify(Bun.resolveSync("@teyik0/furin-electrobun/host", import.meta.dir))};
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
            openExternal: () => true, openPath: () => true,
            showItemInFolder(path) {
              if (process.env.TEST_NATIVE_DIRECTORY_SELECTION) {
                return Bun.write(process.env.TEST_NATIVE_DIRECTORY_SELECTION + ".revealed", path);
              }
            },
            openFileDialog: async () => process.env.TEST_NATIVE_DIRECTORY_SELECTION
              ? await Bun.file(process.env.TEST_NATIVE_DIRECTORY_SELECTION).json()
              : [],
            showMessageBox: async (message) => {
              await Bun.write(process.env.TEST_NATIVE_ERROR, JSON.stringify(message));
              return { response: 0 };
            },
            showNotification() {}, quit(code) { process.exit(code); },
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
              await Bun.write(process.env.TEST_QUIT_APPROVAL, JSON.stringify({ vetoed }));
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
          load: () => import(${JSON.stringify(join(root, "src/server.ts"))}),
        });
        process.on("message", async (message) => {
          if (message === "install") {
            let error = null;
            try { await desktop.updates.install(); } catch (failure) { error = failure.message; }
            await Bun.write(process.env.TEST_INSTALL_RESULT, JSON.stringify({ error, vetoed }));
          } else if (message === "stop") {
            await desktop.quit(); process.exit(0);
          }
        });
        process.send("ready");
  `
  );
  // Bundle the package's actual restart resource, as the desktop build does.
  const resource = await Bun.build({
    entrypoints: [
      join(
        dirname(Bun.resolveSync("@teyik0/furin-electrobun/host", import.meta.dir)),
        "native-restart.ts"
      ),
    ],
    target: "bun",
  });
  if (!(resource.success && resource.outputs[0])) {
    throw new AggregateError(resource.logs, "Unable to prepare the native restart resource");
  }
  await Bun.write(join(runtime, "native-restart.js"), resource.outputs[0]);
  const events = join(options.directory, "launcher-events");
  const launcherSource = join(options.directory, "launcher.ts");
  await Bun.write(
    launcherSource,
    `
    import { appendFileSync } from "node:fs";
    const trace = ${JSON.stringify(events)};
    appendFileSync(trace, JSON.stringify({ type: "start", pid: process.pid }) + "\\n");
    const child = Bun.spawn([${JSON.stringify(process.execPath)}, ${JSON.stringify(entry)}], {
      cwd: ${JSON.stringify(root)},
      env: { ...process.env, ELECTROBUN_LAUNCHER_PID: String(process.pid) },
      stdout: "inherit", stderr: "inherit",
      ipc(message) { process.send?.(message); },
    });
    process.on("message", message => child.send(message));
    const code = await child.exited;
    appendFileSync(trace, JSON.stringify({ type: "exit", pid: process.pid }) + "\\n");
    process.exit(code);
  `
  );
  const launcher = join(
    launchDirectory,
    process.platform === "win32" ? "launcher.exe" : "launcher"
  );
  const compilation = await Bun.build({
    compile: { autoloadBunfig: false, outfile: launcher },
    entrypoints: [launcherSource],
  });
  if (!compilation.success) {
    throw new AggregateError(compilation.logs, "Unable to prepare the native launcher");
  }
  const ready = Promise.withResolvers<void>();
  const child = Bun.spawn([launcher], {
    cwd: root,
    env: {
      ...process.env,
      FURIN_DESKTOP_DEV: undefined,
      TEST_HANDOFF: options.handoff,
      TEST_INSTALL_RESULT: join(options.directory, "install-result.json"),
      TEST_NATIVE_DIRECTORY_SELECTION: options.directorySelectionFile,
      TEST_NATIVE_ERROR: join(options.directory, "native-error.json"),
      TEST_NATIVE_MAGNET: options.magnet,
      TEST_QUIT_APPROVAL: join(options.directory, "quit-approval.json"),
      TOFU_DATA_DIR: options.dataDir,
      TOFU_DOWNLOAD_DIR: options.downloadPath,
      TOFU_MODE: "desktop",
      TOFU_PORT: "0",
      TOFU_PROFILE: "dev",
    },
    ipc(message) {
      if (message === "ready") {
        ready.resolve();
      }
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  void (async () => {
    const code = await child.exited;
    ready.reject(new Error(`The native launcher exited before readiness (code ${code})`));
  })();
  return {
    child,
    events,
    output,
    ready: ready.promise,
    async stop() {
      const descriptor = Bun.file(join(options.dataDir, "server.json"));
      if (await descriptor.exists()) {
        const { pid } = (await descriptor.json()) as ServerInfo;
        if (pid !== process.pid) {
          try {
            process.kill(pid, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
          // The native shutdown deadline can leave a descriptor after the process exits.
          await waitFor(
            () => {
              try {
                process.kill(pid, 0);
                return true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                  throw error;
                }
                return false;
              }
            },
            (alive) => !alive
          );
        }
      }
      if (child.exitCode === null) {
        child.send("stop");
      }
      const deadline = setTimeout(() => child.kill(), 5000);
      await child.exited;
      clearTimeout(deadline);
    },
  };
}
