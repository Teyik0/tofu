import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import { UpdatesService } from "../src/api/modules/updates/service";
import { createTestUpdatesApi } from "./helpers/application";
import { openTestDatabase } from "./helpers/database";
import { expectSuccess } from "./helpers/problem";
import { torrentBytes, waitFor } from "./helpers/torrent";

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
      check: async () => ({
        error: "",
        hash: "new",
        updateAvailable: true,
        updateReady: ready,
        version: "0.2.0",
      }),
      download: async () => {
        downloads += 1;
        await gate;
        ready = true;
      },
      install: () => {
        installed = true;
        return Promise.resolve();
      },
      snapshot: () => ({
        error: "",
        hash: "new",
        updateAvailable: true,
        updateReady: ready,
        version: "0.2.0",
      }),
      subscribe: () => () => undefined,
    },
    notify: () => undefined,
    platform: "darwin",
    version: "0.1.0",
  });
  const app = new Elysia().use(await createTestUpdatesApi(() => updates, sync.options));
  const client = treaty(app).api;
  try {
    expect((await client.updates.install.post({})).status).toBe(409);
    const checked = expectSuccess(await client.updates.check.post({}));
    expect(checked.automatic).toBe(true);
    expect(checked.status).toBe("available");
    expect((await client.updates.prepare.post({})).status).toBe(200);
    expect(expectSuccess(await client.updates.get()).status).toBe("downloading");
    expect((await client.updates.prepare.post({})).status).toBe(200);
    expect(downloads).toBe(1);
    expect(expectSuccess(await client.updates.check.post({})).status).toBe("downloading");
    expect((await client.updates.install.post({})).status).toBe(409);
    expect(installed).toBe(false);
    finish();
    await waitFor(
      async () => expectSuccess(await client.updates.get()),
      (state) => state.status === "ready"
    );
    expect((await client.updates.install.post({})).status).toBe(200);
    expect(expectSuccess(await client.updates.get()).status).toBe("restarting");
    await waitFor(async () => installed, Boolean);
  } finally {
    finish();
    updates.close();
    await sync.close();
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
  let progress:
    | Parameters<
        import("@teyik0/furin-electrobun/host").DesktopCapabilities["updates"]["subscribe"]
      >[0]
    | null = null;
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
      check: async () => info,
      download: async () => {
        downloads += 1;
        progress?.({
          details: { progress: 42 },
          message: "Downloading",
          status: "download-progress",
          timestamp: Date.now(),
        });
        expect(expectSuccess(await client.updates.get()).progress).toBe(42);
        info.error = fail ? "Connection interrupted" : "";
        info.updateReady = !fail;
        return Promise.resolve();
      },
      install: () => Promise.reject(new Error("Cannot start helper")),
      snapshot: () => info,
      subscribe: (callback) => {
        progress = callback;
        return () => {
          progress = null;
        };
      },
    },
    notify: () => undefined,
    platform: "darwin",
    version: "0.1.0",
  });
  const app = new Elysia().use(await createTestUpdatesApi(() => updates, sync.options));
  const client = treaty(app).api;
  try {
    await client.updates.check.post({});
    await client.updates.prepare.post({});
    await waitFor(
      async () => expectSuccess(await client.updates.get()),
      (state) => state.status === "available"
    );
    expect(expectSuccess(await client.updates.get()).error).toBe("Connection interrupted");
    expect(expectSuccess(await client.updates.get()).progress).toBeNull();
    fail = false;
    await client.updates.prepare.post({});
    await waitFor(
      async () => expectSuccess(await client.updates.get()),
      (state) => state.status === "ready"
    );
    await client.updates.check.post({});
    expect(expectSuccess(await client.updates.get()).status).toBe("ready");
    expect(checks).toBe(1);
    expect(downloads).toBe(2);
    await client.updates.install.post({});
    expect((await client.updates.install.post({})).status).toBe(409);
    await waitFor(
      async () => expectSuccess(await client.updates.get()),
      (state) => state.status === "ready"
    );
    expect(expectSuccess(await client.updates.get()).error).toBe("Cannot start helper");
  } finally {
    updates.close();
    await sync.close();
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
  const app = new Elysia().use(await createTestUpdatesApi(() => updates, sync.options));
  const client = treaty(app).api;
  try {
    // No access configuration exists: the first check runs against the public API.
    const first = await client.updates.check.post({});
    expect(first.status).toBe(200);
    const state = expectSuccess(first) as { status: string }; // 127.0.0.1:1 refuses the connection, so the check reports a transient error.
    expect(state.status).toBe("error"); // A second manual check is allowed even while schedules continue in background.
    const second = await client.updates.check.post({});
    expect(second.status).toBe(200);
  } finally {
    updates.close();
    await sync.close();
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
  const app = new Elysia().use(await createTestUpdatesApi(() => updates, sync.options));
  const client = treaty(app).api;
  try {
    await client.updates.check.post({});
    const pending = client.updates.download.get();
    await waitFor(async () => started, Boolean);
    releaseVersion = "0.3.0";
    await client.updates.check.post({});
    finish();
    const installer = await pending;
    expect(installer.status).toBe(200);
    expect(installer.response.headers.get("content-disposition")).toContain(
      "Tofu-0.2.0-macos-arm64.dmg"
    );
    expect(new TextDecoder().decode(torrentBytes(installer))).toBe("original-installer");
  } finally {
    finish();
    updates.close();
    await sync.close();
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
  const app = new Elysia().use(await createTestUpdatesApi(() => updates, sync.options));
  const client = treaty(app).api;
  try {
    await client.updates.check.post({});
    const download = await client.updates.download.get();
    expect(download.status).toBe(502);
    expect(expectSuccess(await client.updates.get()).status).toBe("error");
    expect(expectSuccess(await client.updates.get()).downloadName).toBeNull();
  } finally {
    updates.close();
    await sync.close();
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
  const app = new Elysia().use(await createTestUpdatesApi(() => updates, sync.options));
  const client = treaty(app).api;
  try {
    const checked = await client.updates.check.post({});
    const state = expectSuccess(checked);
    expect(state.status).toBe("no-release");
    expect(state.checkedAt).not.toBeNull();
    expect(state.error).toBeNull();
  } finally {
    updates.close();
    await sync.close();
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
      const app = new Elysia().use(await createTestUpdatesApi(() => updates, sync.options));
      const client = treaty(app).api;
      const checked = await client.updates.check.post({});
      const state = expectSuccess(checked);
      expect(state.status).toBe("available");
      expect(state.latestVersion).toBe("0.2.0");
      expect(state.downloadName).toBe(filename);
      expect(notified).toBe("0.2.0");
      const installer = await client.updates.download.get();
      expect(installer.status).toBe(200);
      expect(new TextDecoder().decode(torrentBytes(installer))).toBe("installer-bytes");
      expect(installer.response.headers.get("content-disposition")).toContain(filename);
      updates.close();
      const reopened = await UpdatesService.open(options);
      const reopenedClient = treaty(await createTestUpdatesApi(() => reopened, sync.options)).api;
      expectSuccess(await reopenedClient.updates.check.post({}));
      expect(requests).toBe(3);
      expect(notified).toBe("0.2.0");
      reopened.close();
    } finally {
      github.stop(true);
      await sync.close();
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
  const app = new Elysia().use(await createTestUpdatesApi(() => updates, sync.options));
  const client = treaty(app).api;
  try {
    const checked = await client.updates.check.post({});
    const state = expectSuccess(checked);
    expect(state.status).toBe("error");
    expect(state.error).toBe("GitHub rejected the update check (HTTP 403)");
    failing = false;
    const retried = await client.updates.check.post({});
    const next = expectSuccess(retried);
    expect(next.status).toBe("available");
  } finally {
    updates.close();
    await sync.close();
    github.stop(true);
    await rm(folder, { force: true, recursive: true });
  }
});
