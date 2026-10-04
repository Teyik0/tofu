import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createTofuSync } from "../src/server/sync";
import { UpdatesService } from "../src/server/updates";
import { createUpdatesApi } from "../src/server/updates-api";
import { json, waitFor } from "./helpers";

test("concurrent release access changes both succeed and persist the final setting", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-access-"));
  const sync = await createTofuSync(join(folder, "sync"));
  const options = {
    apiOrigin: "http://127.0.0.1:1",
    arch: "arm64",
    dataDir: folder,
    notify: (_version: string) => undefined,
    platform: "darwin",
    version: "0.1.0",
  };
  const updates = await UpdatesService.open(options);
  let reopened: UpdatesService | undefined;
  const app = new Elysia().use(createUpdatesApi(() => updates, sync.options));
  try {
    const responses = await Promise.all([
      app.handle(new Request("http://localhost/updates/access", json({ token: "test-access" }))),
      app.handle(new Request("http://localhost/updates/access", json({ clearToken: true }))),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const [added, cleared] = await Promise.all(responses.map((response) => response.json()));
    expect(added.hasToken).toBe(true);
    expect(cleared.hasToken).toBe(false);
    expect(updates.snapshot().hasToken).toBe(false);
    reopened = await UpdatesService.open(options);
    expect(reopened.snapshot().hasToken).toBe(false);
  } finally {
    reopened?.close();
    updates.close();
    sync.close();
    await rm(folder, { force: true, recursive: true });
  }
});

test("a release check during an installer download keeps the original filename and payload", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-concurrent-"));
  const sync = await createTofuSync(join(folder, "sync"));
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
  const app = new Elysia().use(createUpdatesApi(() => updates, sync.options));
  const call = (path: string, init: RequestInit | undefined) =>
    app.handle(new Request(`http://localhost/updates${path}`, init));
  try {
    await call("/access", json({ token: "personal-access" }));
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

test("private release access is persisted without exposing the token and newer compatible releases are downloadable", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-updates-"));
  const sync = await createTofuSync(join(folder, "sync"));
  let requests = 0;
  const github = Bun.serve({
    fetch(request) {
      requests += 1;
      expect(request.headers.get("authorization")).toBe("Bearer personal-access");
      if (new URL(request.url).pathname.endsWith("/assets/17")) {
        expect(request.headers.get("accept")).toBe("application/octet-stream");
        return new Response("installer-bytes");
      }
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
  const options = {
    apiOrigin: `http://127.0.0.1:${github.port}`,
    arch: "arm64",
    dataDir: folder,
    notify: (_version: string) => undefined,
    platform: "darwin",
    version: "0.1.0",
  };
  try {
    let updates = await UpdatesService.open(options);
    const app = new Elysia().use(createUpdatesApi(() => updates, sync.options));
    const call = (path: string, init: RequestInit | undefined) =>
      app.handle(new Request(`http://localhost/updates${path}`, init));
    expect((await (await call("/check", json({}))).json()).status).toBe("auth-required");
    expect(requests).toBe(0);
    const access = await call("/access", json({ token: "personal-access" }));
    expect(await access.text()).not.toContain("personal-access");
    updates.close();
    updates = await UpdatesService.open(options);
    const checked = await call("/check", json({}));
    const state = await checked.json();
    expect(state.status).toBe("available");
    expect(state.latestVersion).toBe("0.2.0");
    expect(state.hasToken).toBe(true);
    expect(JSON.stringify(state)).not.toContain("personal-access");
    const installer = await call("/download", undefined);
    expect(installer.status).toBe(200);
    expect(await installer.text()).toBe("installer-bytes");
    expect(installer.headers.get("content-disposition")).toContain("Tofu-0.2.0-macos-arm64.dmg");
    await call("/access", json({ clearToken: true }));
    expect((await (await call("", undefined)).json()).hasToken).toBe(false);
    updates.close();
  } finally {
    github.stop(true);
    sync.close();
    await rm(folder, { force: true, recursive: true });
  }
});

test("revoked private access during download reports authentication failure and removes the stale download", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tofu-update-revoked-"));
  const sync = await createTofuSync(join(folder, "sync"));
  const github = Bun.serve({
    fetch(request) {
      return new URL(request.url).pathname.endsWith("/assets/17")
        ? new Response("private", { status: 403 })
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
  const app = new Elysia().use(createUpdatesApi(() => updates, sync.options));
  const call = (path: string, init: RequestInit | undefined) =>
    app.handle(new Request(`http://localhost/updates${path}`, init));
  try {
    await call("/access", json({ token: "personal-access" }));
    await call("/check", json({}));
    const download = await call("/download", undefined);
    expect(download.status).toBe(401);
    expect((await (await call("", undefined)).json()).status).toBe("auth-required");
    expect((await (await call("", undefined)).json()).downloadName).toBeNull();
  } finally {
    updates.close();
    sync.close();
    github.stop(true);
    await rm(folder, { force: true, recursive: true });
  }
});
