import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { treaty } from "@elysia/eden";
import type { Api } from "../src/api/index";
import { resolveInstanceConfig } from "../src/api/lib/instance";
import type { DashboardState, InstanceConfig } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { launchServer } from "./helpers/server-process";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

test("development does not claim an existing database whose channel is unknown", async () => {
  const context = await fixture(1024, []);
  const config = resolveInstanceConfig({
    dataDir: join(context.directory, "legacy"),
    desktop: false,
    downloadPath: undefined,
    homeDir: context.directory,
    platform: "darwin",
    port: "0",
    profile: "dev",
  });
  await Bun.write(join(config.dataDir, "tofu.sqlite"), "legacy database, preserve these bytes");
  const child = launchServer(config);
  try {
    const exit = await waitFor(
      async () => child.child.exitCode,
      (code) => code !== null
    );
    expect(exit).not.toBeNull();
    expect(exit).not.toBe(0);
    expect(await child.output).toContain("unknown profile");
    expect(await Bun.file(join(config.dataDir, "instance.json")).exists()).toBe(false);
    expect(await Bun.file(join(config.dataDir, "tofu.sqlite")).text()).toBe(
      "legacy database, preserve these bytes"
    );
  } finally {
    await child.stop();
    await context.close();
  }
}, 30_000);
test("the first protected startup refuses a running legacy instance without a lock", async () => {
  const context = await fixture(1024, []);
  const legacy = Bun.serve({
    fetch: (request) => context.api.handle(request),
    hostname: "127.0.0.1",
    port: 0,
  });
  const config = resolveInstanceConfig({
    dataDir: join(context.directory, "state"),
    desktop: false,
    downloadPath: join(context.directory, "downloads"),
    homeDir: context.directory,
    platform: "darwin",
    port: "0",
    profile: "release",
  });
  await Bun.write(
    join(config.dataDir, "server.json"),
    JSON.stringify({ pid: process.pid, url: legacy.url.href })
  );
  const child = launchServer(config);
  try {
    const exit = await waitFor(
      async () => child.child.exitCode,
      (code) => code !== null
    );
    expect(exit).not.toBeNull();
    expect(exit).not.toBe(0);
    expect(await child.output).toContain("legacy Tofu instance");
    expect((await treaty<Api>(legacy.url.toString()).api.health.get()).response.ok).toBe(true);
    expect(await Bun.file(join(config.dataDir, "instance.json")).exists()).toBe(false);
  } finally {
    await child.stop();
    legacy.stop(true);
    await context.close();
  }
}, 30_000);
// This scenario initializes Furin twice and transfers data between the two startups.
test("watch mode restarts the application and restores its profile, settings and downloaded bytes", async () => {
  const context = await fixture(65_536, []);
  const config = resolveInstanceConfig({
    dataDir: join(context.directory, "watch-dev"),
    desktop: false,
    downloadPath: join(context.directory, "watch-downloads"),
    homeDir: context.directory,
    platform: "darwin",
    port: "0",
    profile: "dev",
  }); // Bun 1.4.2 on Windows only watches files inside the project directory.
  const watchDirectory = await mkdtemp(join(import.meta.dir, "tofu-watch-"));
  const entry = join(watchDirectory, "watch-entry.ts");
  const signal = join(context.directory, "watch-ready.json");
  const source = join(import.meta.dir, "../src/server.ts");
  const serverProgram = (await Bun.file(source).text()).replaceAll(
    'from "./',
    `from "${pathToFileURL(join(import.meta.dir, "../src")).href}/`
  );
  // Publish readiness atomically so polling never reads a partially written JSON file.
  const program = (iteration: number) => `import { rename } from "node:fs/promises";
${serverProgram}
await Bun.write(${JSON.stringify(`${signal}.tmp`)}, JSON.stringify({iteration: ${iteration}, url: "http://127.0.0.1:" + apiPlugin.server?.port}));
await rename(${JSON.stringify(`${signal}.tmp`)}, ${JSON.stringify(signal)});`;
  await Bun.write(entry, program(1));
  const dev = launchServer(config, entry);
  try {
    const url = await dev.ready();
    await waitFor(
      () => Bun.file(signal).exists(),
      (exists) => exists
    );
    await waitFor(
      async () => (await Bun.file(signal).json()) as { iteration: number },
      (value) => value.iteration === 1
    );
    const settings = expectSuccess(await treaty<Api>(url).api.settings.get());
    expectSuccess(await treaty<Api>(url).api.settings.put({ ...settings, runInBackground: true }));
    const response = await treaty<Api>(url).api.torrents.post({
      paused: false,
      source: context.magnet,
    });
    const { id } = expectSuccess(response) as { id: string };
    await waitFor(
      async () => expectSuccess(await treaty<Api>(url).api.state.get()) as DashboardState,
      (state) => state.torrents[0]?.status === "seeding"
    );
    await Bun.write(entry, program(2));
    const ready = await waitFor(
      async () => (await Bun.file(signal).json()) as { iteration: number; url: string },
      (value) => value.iteration === 2
    );
    const info = expectSuccess(await treaty<Api>(ready.url).api.instance.get()) as InstanceConfig;
    expect(info.profile).toBe("dev");
    expect(info.dataDir).toBe(config.dataDir);
    expect(expectSuccess(await treaty<Api>(ready.url).api.settings.get()).runInBackground).toBe(
      true
    );
    const restartedState = expectSuccess(await treaty<Api>(ready.url).api.state.get());
    expect(restartedState.torrents[0]?.id).toBe(id);
    const bytes = torrentBytes(
      await treaty<Api>(ready.url).api.torrents({ id }).files({ index: "0" }).content.get()
    );
    expect(Bun.SHA256.hash(bytes, "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  } catch (error) {
    await dev.stop();
    throw new Error(await dev.output, { cause: error });
  } finally {
    await dev.stop();
    await Promise.all([context.close(), rm(watchDirectory, { force: true, recursive: true })]);
  }
}, 60_000);
test("parallel dev and release APIs keep settings, transfers and persisted state separate", async () => {
  const context = await fixture(65_536, []);
  const options = {
    dataDir: undefined,
    desktop: false,
    downloadPath: undefined,
    homeDir: context.directory,
    platform: "darwin" as const,
    port: "0",
  };
  const devConfig = resolveInstanceConfig({ ...options, profile: "dev" });
  const releaseConfig = resolveInstanceConfig({ ...options, profile: "release" });
  let dev = launchServer(devConfig);
  const release = launchServer(releaseConfig);
  try {
    const [devUrl, releaseUrl] = await Promise.all([dev.ready(), release.ready()]);
    expect(devUrl).not.toBe(releaseUrl);
    const read = async (url: string) =>
      expectSuccess(await treaty<Api>(url).api.state.get()) as DashboardState;
    expect(expectSuccess(await treaty<Api>(devUrl).api.instance.get())).toMatchObject({
      profile: "dev",
    });
    expect(expectSuccess(await treaty<Api>(releaseUrl).api.instance.get())).toMatchObject({
      profile: "release",
    });
    const initial = await read(devUrl);
    expect(initial.settings.downloadPath).toBe(devConfig.downloadPath);
    expect((await read(releaseUrl)).settings.downloadPath).toBe(releaseConfig.downloadPath);
    await treaty<Api>(devUrl).api.settings.put({ ...initial.settings, runInBackground: true });
    const add = await treaty<Api>(devUrl).api.torrents.post({
      paused: false,
      source: context.magnet,
    });
    expect(add.status).toBe(200);
    const { id } = expectSuccess(add) as { id: string };
    await waitFor(
      () => read(devUrl),
      (state) => state.torrents[0]?.status === "seeding"
    );
    const content = await treaty<Api>(devUrl)
      .api.torrents({ id })
      .files({ index: "0" })
      .content.get();
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    const untouched = await read(releaseUrl);
    expect(untouched.settings.runInBackground).toBe(false);
    expect(untouched.torrents).toHaveLength(0);
    await dev.stop();
    dev = launchServer(devConfig);
    const restarted = await read(await dev.ready());
    expect(restarted.settings.runInBackground).toBe(true);
    expect(restarted.torrents[0]?.id).toBe(id);
    expect((await read(releaseUrl)).torrents).toHaveLength(0);
  } finally {
    await Promise.all([dev.stop(), release.stop()]);
    await context.close();
  }
}, 30_000);
test("release claims legacy state without losing existing preferences or downloaded bytes", async () => {
  const context = await fixture(65_536, []);
  const response = await context.client.torrents.post({ paused: false, source: context.magnet });
  const { id } = expectSuccess(response) as { id: string };
  await waitFor(
    async () => expectSuccess(await context.client.torrents({ id }).get()),
    (detail) => detail.status === "seeding"
  );
  await context.client.torrents({ id }).pause.post({});
  await context.client.settings.put({ ...context.engine.settings, runInBackground: true });
  const savedPath = context.engine.settings.downloadPath;
  await context.engine.close();
  const release = launchServer(
    resolveInstanceConfig({
      dataDir: join(context.directory, "state"),
      desktop: false,
      downloadPath: join(context.directory, "new-default"),
      homeDir: context.directory,
      platform: "darwin",
      port: "0",
      profile: "release",
    })
  );
  try {
    const url = await release.ready();
    const state = expectSuccess(await treaty<Api>(url).api.state.get()) as DashboardState;
    expect(state.settings.downloadPath).toBe(savedPath);
    expect(state.settings.runInBackground).toBe(true);
    expect(state.torrents[0]?.id).toBe(id);
    expect(state.torrents[0]?.status).toBe("paused");
    const bytes = torrentBytes(
      await treaty<Api>(url).api.torrents({ id }).files({ index: "0" }).content.get()
    );
    expect(Bun.SHA256.hash(bytes, "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  } finally {
    await release.stop();
    await context.close();
  }
}, 30_000);
test("an inactive profile cannot be reused by the other channel, even through a symlink", async () => {
  const context = await fixture(1024, []);
  const config = resolveInstanceConfig({
    dataDir: join(context.directory, "private-state"),
    desktop: false,
    downloadPath: join(context.directory, "private-downloads"),
    homeDir: context.directory,
    platform: "darwin",
    port: "0",
    profile: "release",
  });
  const release = launchServer(config);
  let dev: ReturnType<typeof launchServer> | undefined;
  try {
    await release.ready();
    await release.stop();
    const before = await Bun.file(join(config.dataDir, "feeds.sqlite")).arrayBuffer();
    const alias = join(context.directory, "alias");
    await symlink(config.dataDir, alias, process.platform === "win32" ? "junction" : "dir");
    dev = launchServer({ ...config, dataDir: alias, profile: "dev" });
    const exit = await waitFor(
      async () => dev?.child.exitCode ?? null,
      (code) => code !== null
    );
    expect(exit).not.toBeNull();
    expect(exit).not.toBe(0);
    expect(await dev.output).toContain("profile release");
    expect(await Bun.file(join(config.dataDir, "feeds.sqlite")).arrayBuffer()).toEqual(before);
  } finally {
    await dev?.stop();
    await release.stop();
    await context.close();
  }
}, 30_000);
test("a second process cannot open the same data directory and a crash releases ownership", async () => {
  const context = await fixture(1024, []);
  const config = resolveInstanceConfig({
    dataDir: join(context.directory, "instance"),
    desktop: false,
    downloadPath: join(context.directory, "instance-downloads"),
    homeDir: context.directory,
    platform: "darwin",
    port: "0",
    profile: "dev",
  });
  let first = launchServer(config);
  let second: ReturnType<typeof launchServer> | undefined;
  try {
    const url = await first.ready();
    const before = await Bun.file(join(config.dataDir, "server.json")).text();
    second = launchServer(config);
    const exit = await waitFor(
      async () => second?.child.exitCode ?? null,
      (code) => code !== null
    );
    expect(exit).not.toBeNull();
    expect(exit).not.toBe(0);
    expect(await second.output).toContain("already in use");
    expect(await Bun.file(join(config.dataDir, "server.json")).text()).toBe(before);
    expect((await treaty<Api>(url).api.health.get()).response.ok).toBe(true);
    first.child.kill("SIGKILL");
    await first.child.exited;
    first = launchServer(config);
    expect((await treaty<Api>(await first.ready()).api.health.get()).response.ok).toBe(true);
    await first.stop();
    expect(await Bun.file(join(config.dataDir, "server.json")).exists()).toBe(false);
  } finally {
    await first.stop();
    await second?.stop();
    await context.close();
  }
}, 30_000);
