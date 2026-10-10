import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import { DesktopUpdateInstaller } from "../src/api/modules/updates/installer";
import { UpdatesService } from "../src/api/modules/updates/service";
import { createTestUpdatesApi } from "./api-fixture";
import { openTestDatabase } from "./database";
import { fixture, json, network, waitFor } from "./helpers";

test("an update restart saves a real peer transfer and recovers when the native handoff fails", async () => {
  const context = await fixture(256 * 1024, []);
  let reopened: TorrentEngine | null = null;
  const response = await context.request(
    "/torrents",
    json({ paused: false, source: context.magnet })
  );
  expect(response.status).toBe(200);
  const added = await response.json();
  await waitFor(
    async () => context.engine.get(added.id).detail,
    (detail) => detail.progress === 1
  );
  const destination = context.engine.get(added.id).detail.savePath;
  const source = join(destination, context.seed.name);
  let allowQuit = false;
  const installer = new DesktopUpdateInstaller({
    allowQuit: (allowed) => {
      allowQuit = allowed;
    },
    recover: async () => {
      reopened = await TorrentEngine.open({
        dataDir: join(context.directory, "state"),
        downloadPath: join(context.directory, "downloads"),
        network,
      });
    },
    shutdown: () => context.engine.close(),
    updater: {
      applyUpdate: () => {
        expect(allowQuit).toBe(true);
        return Promise.resolve();
      },
      getStatusHistory: () => [],
      updateInfo: () => ({
        error: "Unable to start update helper",
        hash: "new",
        updateAvailable: true,
        updateReady: true,
        version: "0.2.0",
      }),
    },
  });
  try {
    await expect(installer.install()).rejects.toThrow("Unable to start update helper");
    expect(allowQuit).toBe(false);
    expect(await Bun.file(source).bytes()).toEqual(context.bytes);
    const restored = reopened as TorrentEngine | null;
    expect(restored).not.toBeNull();
    await waitFor(
      async () => restored?.get(added.id).detail,
      (detail) => detail?.progress === 1
    );
  } finally {
    await (reopened as TorrentEngine | null)?.close();
    await context.close();
  }
});

test("desktop updates prepare in app and only restart after an explicit install action", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-native-"));
  const sync = await openTestDatabase(join(folder, "sync"));
  let ready = false;
  let installed = false;
  let downloads = 0;
  let finish: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const github = Bun.serve({
    fetch: () =>
      Response.json({
        assets: [{ id: 17, name: "Tofu-0.2.0-macos-arm64.dmg" }],
        draft: false,
        prerelease: false,
        tag_name: "v0.2.0",
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const updates = await UpdatesService.open({
    apiOrigin: `http://127.0.0.1:${github.port}`,
    arch: "arm64",
    dataDir: folder,
    native: {
      applyUpdate: () => {
        installed = true;
        return Promise.resolve();
      },
      checkForUpdate: async () => ({
        error: "",
        hash: "new",
        updateAvailable: true,
        updateReady: ready,
        version: "0.2.0",
      }),
      downloadUpdate: async () => {
        downloads += 1;
        await gate;
        ready = true;
      },
      onStatusChange: () => undefined,
      updateInfo: () => ({
        error: "",
        hash: "new",
        updateAvailable: true,
        updateReady: ready,
        version: "0.2.0",
      }),
    },
    notify: () => undefined,
    platform: "darwin",
    version: "0.1.0",
  });
  const app = new Elysia().use(createTestUpdatesApi(() => updates, sync.options));
  const call = (path: string) =>
    app.handle(new Request(`http://localhost/api/updates${path}`, json({})));
  try {
    expect((await call("/install")).status).toBe(409);
    const checked = await (await call("/check")).json();
    expect(checked.automatic).toBe(true);
    expect(checked.status).toBe("available");
    expect((await call("/prepare")).status).toBe(200);
    expect(updates.snapshot().status).toBe("downloading");
    expect((await call("/prepare")).status).toBe(200);
    expect(downloads).toBe(1);
    expect((await (await call("/check")).json()).status).toBe("downloading");
    expect((await call("/install")).status).toBe(409);
    expect(installed).toBe(false);
    finish();
    await waitFor(
      async () => updates.snapshot(),
      (state) => state.status === "ready"
    );
    expect((await call("/install")).status).toBe(200);
    expect(updates.snapshot().status).toBe("restarting");
    await waitFor(async () => installed, Boolean);
  } finally {
    finish();
    updates.close();
    sync.close();
    github.stop(true);
    await rm(folder, { force: true, recursive: true });
  }
});

test("failed native downloads can be retried and scheduled checks preserve the prepared version", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-retry-"));
  const sync = await openTestDatabase(join(folder, "sync"));
  let fail = true;
  let checks = 0;
  let downloads = 0;
  let progress: ((entry: import("electrobun/main").UpdateStatusEntry) => void) | null = null;
  const info = {
    error: "",
    hash: "new",
    updateAvailable: true,
    updateReady: false,
    version: "0.2.0",
  };
  const github = Bun.serve({
    fetch: () => {
      checks += 1;
      return Response.json({
        assets: [{ id: 17, name: "Tofu-0.2.0-macos-arm64.dmg" }],
        draft: false,
        prerelease: false,
        tag_name: "v0.2.0",
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const updates = await UpdatesService.open({
    apiOrigin: `http://127.0.0.1:${github.port}`,
    arch: "arm64",
    dataDir: folder,
    native: {
      applyUpdate: () => Promise.reject(new Error("Cannot start helper")),
      checkForUpdate: async () => info,
      downloadUpdate: () => {
        downloads += 1;
        progress?.({
          details: { progress: 42 },
          message: "Downloading",
          status: "download-progress",
          timestamp: Date.now(),
        });
        expect(updates.snapshot().progress).toBe(42);
        info.error = fail ? "Connection interrupted" : "";
        info.updateReady = !fail;
        return Promise.resolve();
      },
      onStatusChange: (callback) => {
        progress = callback;
      },
      updateInfo: () => info,
    },
    notify: () => undefined,
    platform: "darwin",
    version: "0.1.0",
  });
  const app = new Elysia().use(createTestUpdatesApi(() => updates, sync.options));
  const call = (path: string) =>
    app.handle(new Request(`http://localhost/api/updates${path}`, json({})));
  try {
    await call("/check");
    await call("/prepare");
    await waitFor(
      async () => updates.snapshot(),
      (state) => state.status === "available"
    );
    expect(updates.snapshot().error).toBe("Connection interrupted");
    expect(updates.snapshot().progress).toBeNull();
    fail = false;
    await call("/prepare");
    await waitFor(
      async () => updates.snapshot(),
      (state) => state.status === "ready"
    );
    await call("/check");
    expect(updates.snapshot().status).toBe("ready");
    expect(checks).toBe(1);
    expect(downloads).toBe(2);
    await call("/install");
    expect((await call("/install")).status).toBe(409);
    await waitFor(
      async () => updates.snapshot(),
      (state) => state.status === "ready"
    );
    expect(updates.snapshot().error).toBe("Cannot start helper");
  } finally {
    updates.close();
    sync.close();
    github.stop(true);
    await rm(folder, { force: true, recursive: true });
  }
});

test("update checks require no signed-in access", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-access-"));
  const sync = await openTestDatabase(join(folder, "sync"));
  const options = {
    apiOrigin: "http://127.0.0.1:1",
    arch: "arm64",
    dataDir: folder,
    notify: (_version: string) => undefined,
    platform: "darwin",
    version: "0.1.0",
  };
  const updates = await UpdatesService.open(options);
  const app = new Elysia().use(createTestUpdatesApi(() => updates, sync.options));
  try {
    // No access configuration exists: the first check runs against the public API.
    const first = await app.handle(new Request("http://localhost/api/updates/check", json({})));
    expect(first.status).toBe(200);
    const state = (await first.json()) as { status: string };
    // 127.0.0.1:1 refuses the connection, so the check reports a transient error.
    expect(state.status).toBe("error");

    // A second manual check is allowed even while schedules continue in background.
    const second = await app.handle(new Request("http://localhost/api/updates/check", json({})));
    expect(second.status).toBe(200);
  } finally {
    updates.close();
    sync.close();
    await rm(folder, { force: true, recursive: true });
  }
});

test("a release check during an installer download keeps the original filename and payload", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-concurrent-"));
  const sync = await openTestDatabase(join(folder, "sync"));
  let releaseVersion = "0.2.0";
  let started = false;
  let finish: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const github = Bun.serve({
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/assets/17")) {
        started = true;
        await gate;
        return new Response("original-installer");
      }
      return Response.json({
        assets: [{ id: 17, name: `Tofu-${releaseVersion}-macos-arm64.dmg` }],
        draft: false,
        prerelease: false,
        tag_name: `v${releaseVersion}`,
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const updates = await UpdatesService.open({
    apiOrigin: `http://127.0.0.1:${github.port}`,
    arch: "arm64",
    dataDir: folder,
    notify: (_version: string) => undefined,
    platform: "darwin",
    version: "0.1.0",
  });
  const app = new Elysia().use(createTestUpdatesApi(() => updates, sync.options));
  const call = (path: string, init: RequestInit | undefined) =>
    app.handle(new Request(`http://localhost/api/updates${path}`, init));
  try {
    await call("/check", json({}));
    const pending = call("/download", undefined);
    await waitFor(async () => started, Boolean);
    releaseVersion = "0.3.0";
    await call("/check", json({}));
    finish();
    const installer = await pending;
    expect(installer.status).toBe(200);
    expect(installer.headers.get("content-disposition")).toContain("Tofu-0.2.0-macos-arm64.dmg");
    expect(await installer.text()).toBe("original-installer");
  } finally {
    finish();
    updates.close();
    sync.close();
    github.stop(true);
    await rm(folder, { force: true, recursive: true });
  }
});

test("a refused asset download reports the failure and clears the stale download", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-refused-"));
  const sync = await openTestDatabase(join(folder, "sync"));
  const github = Bun.serve({
    fetch(request) {
      return new URL(request.url).pathname.endsWith("/assets/17")
        ? new Response("gone", { status: 403 })
        : Response.json({
            assets: [{ id: 17, name: "Tofu-0.2.0-macos-arm64.dmg" }],
            draft: false,
            prerelease: false,
            tag_name: "v0.2.0",
          });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const updates = await UpdatesService.open({
    apiOrigin: `http://127.0.0.1:${github.port}`,
    arch: "arm64",
    dataDir: folder,
    notify: (_version: string) => undefined,
    platform: "darwin",
    version: "0.1.0",
  });
  const app = new Elysia().use(createTestUpdatesApi(() => updates, sync.options));
  const call = (path: string, init: RequestInit | undefined) =>
    app.handle(new Request(`http://localhost/api/updates${path}`, init));
  try {
    await call("/check", json({}));
    const download = await call("/download", undefined);
    expect(download.status).toBe(502);
    expect((await (await call("", undefined)).json()).status).toBe("error");
    expect((await (await call("", undefined)).json()).downloadName).toBeNull();
  } finally {
    updates.close();
    sync.close();
    github.stop(true);
    await rm(folder, { force: true, recursive: true });
  }
});

test("a repository without a stable release reports no-release", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-empty-"));
  const sync = await openTestDatabase(join(folder, "sync"));
  const github = Bun.serve({
    fetch(request) {
      return new URL(request.url).pathname.endsWith("/releases/latest")
        ? new Response("not found", { status: 404 })
        : new Response("unexpected", { status: 500 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const updates = await UpdatesService.open({
    apiOrigin: `http://127.0.0.1:${github.port}`,
    arch: "arm64",
    dataDir: folder,
    notify: (_version: string) => undefined,
    platform: "darwin",
    version: "0.1.0",
  });
  const app = new Elysia().use(createTestUpdatesApi(() => updates, sync.options));
  const call = (path: string, init: RequestInit | undefined) =>
    app.handle(new Request(`http://localhost/api/updates${path}`, init));
  try {
    const checked = await call("/check", json({}));
    const state = await checked.json();
    expect(state.status).toBe("no-release");
    expect(state.checkedAt).not.toBeNull();
    expect(state.error).toBeNull();
  } finally {
    updates.close();
    sync.close();
    github.stop(true);
    await rm(folder, { force: true, recursive: true });
  }
});

test.each([
  { arch: "arm64", installer: "Tofu-0.2.0-macos-arm64.dmg", platform: "darwin" },
  { arch: "x64", installer: "Tofu-0.2.0-win-x64.zip", platform: "win32" },
  { arch: "x64", installer: "Tofu-0.2.0-linux-x64.tar.gz", platform: "linux" },
  { arch: "arm64", installer: "Tofu-0.2.0-linux-arm64.tar.gz", platform: "linux" },
])(
  "public releases notify once per version and download the compatible installer for $platform/$arch",
  async ({ platform, arch, installer: filename }) => {
    const folder = await mkdtemp(join(tmpdir(), "tofu-updates-"));
    const sync = await openTestDatabase(join(folder, "sync"));
    let requests = 0;
    let notified: string | undefined;
    const github = Bun.serve({
      fetch(request) {
        requests += 1;
        expect(request.headers.get("authorization")).toBeNull();
        if (new URL(request.url).pathname.endsWith("/assets/17")) {
          expect(request.headers.get("accept")).toBe("application/octet-stream");
          return new Response("installer-bytes");
        }
        return Response.json({
          assets: [
            { id: 16, name: "Tofu-0.2.0-linux-unsupported.tar.gz" },
            { id: 17, name: filename },
          ],
          draft: false,
          prerelease: false,
          tag_name: "v0.2.0",
        });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    const options = {
      apiOrigin: `http://127.0.0.1:${github.port}`,
      arch,
      dataDir: folder,
      notify: (version: string) => {
        notified = version;
      },
      platform,
      version: "0.1.0",
    };
    try {
      const updates = await UpdatesService.open(options);
      const app = new Elysia().use(createTestUpdatesApi(() => updates, sync.options));
      const call = (path: string, init: RequestInit | undefined) =>
        app.handle(new Request(`http://localhost/api/updates${path}`, init));
      const checked = await call("/check", json({}));
      const state = await checked.json();
      expect(state.status).toBe("available");
      expect(state.latestVersion).toBe("0.2.0");
      expect(state.downloadName).toBe(filename);
      expect(notified).toBe("0.2.0");
      const installer = await call("/download", undefined);
      expect(installer.status).toBe(200);
      expect(await installer.text()).toBe("installer-bytes");
      expect(installer.headers.get("content-disposition")).toContain(filename);
      updates.close();
      const reopened = await UpdatesService.open(options);
      await reopened.check();
      expect(requests).toBe(3);
      expect(notified).toBe("0.2.0");
      reopened.close();
    } finally {
      github.stop(true);
      sync.close();
      await rm(folder, { force: true, recursive: true });
    }
  }
);

test("an unavailable GitHub API surfaces an error state without blocking later checks", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-error-"));
  const sync = await openTestDatabase(join(folder, "sync"));
  let failing = true;
  const github = Bun.serve({
    fetch() {
      return failing
        ? new Response("too many requests", { status: 403 })
        : Response.json({
            assets: [{ id: 17, name: "Tofu-0.2.0-macos-arm64.dmg" }],
            draft: false,
            prerelease: false,
            tag_name: "v0.2.0",
          });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const updates = await UpdatesService.open({
    apiOrigin: `http://127.0.0.1:${github.port}`,
    arch: "arm64",
    dataDir: folder,
    notify: (_version: string) => undefined,
    platform: "darwin",
    version: "0.1.0",
  });
  const app = new Elysia().use(createTestUpdatesApi(() => updates, sync.options));
  const call = (path: string, init: RequestInit | undefined) =>
    app.handle(new Request(`http://localhost/api/updates${path}`, init));
  try {
    const checked = await call("/check", json({}));
    const state = await checked.json();
    expect(state.status).toBe("error");
    expect(state.error).toBe("GitHub rejected the update check (HTTP 403)");
    failing = false;
    const retried = await call("/check", json({}));
    const next = await retried.json();
    expect(next.status).toBe("available");
  } finally {
    updates.close();
    sync.close();
    github.stop(true);
    await rm(folder, { force: true, recursive: true });
  }
});
