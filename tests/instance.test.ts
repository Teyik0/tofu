import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveInstanceConfig } from "../src/server/instance";
import type { DashboardState, InstanceConfig } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

// Bun 1.4.2's diagnostic from the pinned WebTorrent's optional uTP probe.
// Match the complete notice so unrelated stderr before or after it still fails.
const optionalUtpNotice =
  /^WebTorrent: uTP not supported warn: No native build was found for [^\r\n]+\r?\n {4}loaded from: [^\r\n]*utp-native\r?\n\r?\n(?: {6}at [^\r\n]+\r?\n)+\r?\n/m;

function launch(config: InstanceConfig, hotEntry?: string) {
  const command = hotEntry ? ["--hot", hotEntry] : ["scripts/dev.ts"];
  const child = Bun.spawn(
    [process.execPath, "--preload", join(import.meta.dir, "process-control.ts"), ...command],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        TOFU_DATA_DIR: config.dataDir,
        TOFU_DOWNLOAD_DIR: config.downloadPath,
        TOFU_MODE: "server",
        TOFU_PORT: String(config.port),
        TOFU_PROFILE: config.profile,
      },
      ipc() {
        // Enable the parent-to-child shutdown channel; the child sends no messages.
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then((parts) => parts.join("\n"));
  return {
    child,
    output,
    async ready() {
      const address = await waitFor(
        async () => {
          if (child.exitCode !== null) {
            throw new Error(await output);
          }
          const info = Bun.file(join(config.dataDir, "server.json"));
          if (!(await info.exists())) {
            return null;
          }
          const { pid, url } = (await info.json()) as { pid: number; url: string };
          if (pid !== child.pid) {
            return null;
          }
          return (await fetch(`${url}/api/health`)).ok ? url : null;
        },
        (url) => url !== null
      );
      if (!address) {
        throw new Error("The Tofu server did not start");
      }
      return address;
    },
    async stop() {
      if (child.exitCode === null) {
        // Windows termination cannot deliver a POSIX signal; ask the child to run its shutdown handler.
        if (process.platform === "win32") {
          child.send("shutdown");
        } else {
          child.kill("SIGTERM");
        }
      }
      await child.exited;
    },
  };
}

test("development and release have distinct default storage, downloads, ports and native identities", () => {
  const homeDir = join(import.meta.dir, "temporary-home");
  const options = {
    dataDir: undefined,
    desktop: false,
    downloadPath: undefined,
    homeDir,
    platform: "darwin" as const,
    port: undefined,
  };
  const dev = resolveInstanceConfig({ ...options, profile: "dev" });
  const release = resolveInstanceConfig({ ...options, profile: "release" });
  expect(dev.dataDir).toBe(join(homeDir, "Library/Application Support/Tofu-dev"));
  expect(release.dataDir).toBe(join(homeDir, "Library/Application Support/Tofu"));
  expect(dev.downloadPath).toBe(join(homeDir, "Downloads/Tofu-dev"));
  expect(release.downloadPath).toBe(join(homeDir, "Downloads/Tofu"));
  expect(dev.port).toBe(3030);
  expect(release.port).toBe(3031);
  expect(dev.identifier).toBe("app.tofu.torrents.dev");
  expect(release.identifier).toBe("app.tofu.torrents");
  expect(resolveInstanceConfig({ ...options, desktop: true, profile: "dev" }).port).toBe(0);
  expect(resolveInstanceConfig({ ...options, desktop: true, profile: "release" }).port).toBe(0);
});

test("development refuses the production data directory even before it has a profile marker", () => {
  expect(() =>
    resolveInstanceConfig({
      dataDir: "/temporary/tofu-home/Library/Application Support/Tofu",
      desktop: false,
      downloadPath: undefined,
      homeDir: "/temporary/tofu-home",
      platform: "darwin",
      port: undefined,
      profile: "dev",
    })
  ).toThrow("reserved for release");
});

test("Windows keeps development and release state in separate roaming application folders", () => {
  const homeDir = join(import.meta.dir, "temporary-home");
  const options = {
    dataDir: undefined,
    desktop: true,
    downloadPath: undefined,
    homeDir,
    platform: "win32" as const,
    port: undefined,
  };
  const dev = resolveInstanceConfig({ ...options, profile: "dev" });
  const release = resolveInstanceConfig({ ...options, profile: "release" });
  expect(dev.dataDir).toBe(join(homeDir, "AppData/Roaming/Tofu-dev"));
  expect(release.dataDir).toBe(join(homeDir, "AppData/Roaming/Tofu"));
  expect(dev.downloadPath).toBe(join(homeDir, "Downloads/Tofu-dev"));
  expect(release.downloadPath).toBe(join(homeDir, "Downloads/Tofu"));
  expect(dev.port).toBe(0);
  expect(release.port).toBe(0);
  const roaming = join(homeDir, "redirected-roaming");
  expect(
    resolveInstanceConfig({ ...options, appDataDir: roaming, profile: "release" }).dataDir
  ).toBe(join(roaming, "Tofu"));
  expect(() =>
    resolveInstanceConfig({ ...options, dataDir: release.dataDir, profile: "dev" })
  ).toThrow("reserved for release");
});

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
  const child = launch(config);
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

test.each(["platform prebuilds", "no uTP prebuild", "no uTP prebuild with colors"])(
  "importing the server with %s for build inspection does not create user databases",
  async (prebuilds) => {
    const context = await fixture(1024, []);
    const dataDir = join(context.directory, "build-inspection");
    const child = Bun.spawn(
      [process.execPath, "-e", 'await import("./src/server.ts"); process.exit(0)'],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          FORCE_COLOR: prebuilds === "no uTP prebuild with colors" ? "1" : "0",
          TOFU_DATA_DIR: dataDir,
          TOFU_MODE: "server",
          TOFU_PROFILE: "dev",
          ...(prebuilds === "platform prebuilds"
            ? {}
            : { UTP_NATIVE_PREBUILD: join(context.directory, "unavailable-utp-native") }),
        },
        stderr: "pipe",
        stdout: "ignore",
      }
    );
    const stderr = new Response(child.stderr).text();
    try {
      const output = Bun.stripANSI(await stderr).replace(optionalUtpNotice, "");
      expect({ exit: await child.exited, output }).toEqual({ exit: 0, output: "" });
      expect(
        await Promise.all(
          ["sync.sqlite", "feeds.sqlite", "tofu.sqlite", "instance.json"].map((file) =>
            Bun.file(join(dataDir, file)).exists()
          )
        )
      ).toEqual([false, false, false, false]);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
      await context.close();
    }
  },
  30_000
);

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
  const child = launch(config);
  try {
    const exit = await waitFor(
      async () => child.child.exitCode,
      (code) => code !== null
    );
    expect(exit).not.toBeNull();
    expect(exit).not.toBe(0);
    expect(await child.output).toContain("legacy Tofu instance");
    expect((await fetch(new URL("/api/health", legacy.url))).ok).toBe(true);
    expect(await Bun.file(join(config.dataDir, "instance.json")).exists()).toBe(false);
  } finally {
    await child.stop();
    legacy.stop(true);
    await context.close();
  }
}, 30_000);

test("hot reload keeps the original profile and database together until process restart", async () => {
  const context = await fixture(65_536, []);
  const config = resolveInstanceConfig({
    dataDir: join(context.directory, "hot-dev"),
    desktop: false,
    downloadPath: join(context.directory, "hot-downloads"),
    homeDir: context.directory,
    platform: "darwin",
    port: "0",
    profile: "dev",
  });
  // Bun 1.4.2 on Windows only watches files inside the project directory.
  const hotDirectory = await mkdtemp(join(import.meta.dir, "tofu-hot-"));
  const entry = join(hotDirectory, "hot-entry.ts");
  const signal = join(context.directory, "hot-ready.json");
  const source = join(import.meta.dir, "../src/server.ts");
  const nextDataDir = join(context.directory, "hot-release");
  const program = (iteration: number, dataDir: string, profile: string) =>
    `process.env.TOFU_DATA_DIR = ${JSON.stringify(dataDir)};
process.env.TOFU_PROFILE = ${JSON.stringify(profile)};
const serverModule = await import(${JSON.stringify(source)});
await serverModule.startServer();
await Bun.write(${JSON.stringify(signal)}, JSON.stringify({iteration: ${iteration}, url: "http://127.0.0.1:" + serverModule.default.server.port}));`;
  await Bun.write(entry, program(1, config.dataDir, "dev"));
  const dev = launch(config, entry);
  try {
    const url = await dev.ready();
    const response = await fetch(
      `${url}/api/torrents`,
      json({ paused: false, source: context.magnet })
    );
    const { id } = (await response.json()) as { id: string };
    await waitFor(
      async () => (await (await fetch(`${url}/api/state`)).json()) as DashboardState,
      (state) => state.torrents[0]?.status === "seeding"
    );
    await Bun.write(entry, program(2, nextDataDir, "release"));
    const ready = await waitFor(
      async () => (await Bun.file(signal).json()) as { iteration: number; url: string },
      (value) => value.iteration === 2
    );
    const info = (await (await fetch(`${ready.url}/api/instance`)).json()) as InstanceConfig;
    expect(info.profile).toBe("dev");
    expect(info.dataDir).toBe(config.dataDir);
    expect(await Bun.file(join(nextDataDir, "server.json")).exists()).toBe(false);
    const bytes = await (
      await fetch(`${ready.url}/api/torrents/${id}/files/0/content`)
    ).arrayBuffer();
    expect(Bun.SHA256.hash(bytes, "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  } finally {
    await dev.stop();
    await Promise.all([context.close(), rm(hotDirectory, { force: true, recursive: true })]);
  }
}, 30_000);

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
  let dev = launch(devConfig);
  const release = launch(releaseConfig);
  try {
    const [devUrl, releaseUrl] = await Promise.all([dev.ready(), release.ready()]);
    expect(devUrl).not.toBe(releaseUrl);
    const read = async (url: string) =>
      (await (await fetch(`${url}/api/state`)).json()) as DashboardState;
    expect(await (await fetch(`${devUrl}/api/instance`)).json()).toMatchObject({ profile: "dev" });
    expect(await (await fetch(`${releaseUrl}/api/instance`)).json()).toMatchObject({
      profile: "release",
    });
    const initial = await read(devUrl);
    expect(initial.settings.downloadPath).toBe(devConfig.downloadPath);
    expect((await read(releaseUrl)).settings.downloadPath).toBe(releaseConfig.downloadPath);
    await fetch(`${devUrl}/api/settings`, {
      ...json({ ...initial.settings, runInBackground: true }),
      method: "PUT",
    });
    const add = await fetch(
      `${devUrl}/api/torrents`,
      json({ paused: false, source: context.magnet })
    );
    expect(add.status).toBe(200);
    const { id } = (await add.json()) as { id: string };
    await waitFor(
      () => read(devUrl),
      (state) => state.torrents[0]?.status === "seeding"
    );
    const content = await fetch(`${devUrl}/api/torrents/${id}/files/0/content`);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    const untouched = await read(releaseUrl);
    expect(untouched.settings.runInBackground).toBe(false);
    expect(untouched.torrents).toHaveLength(0);
    await dev.stop();
    dev = launch(devConfig);
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
  const response = await context.request(
    "/torrents",
    json({ paused: false, source: context.magnet })
  );
  const { id } = (await response.json()) as { id: string };
  await waitFor(
    async () => context.engine.detail(id),
    (detail) => detail.status === "seeding"
  );
  await context.request(`/torrents/${id}/pause`, json({}));
  await context.request("/settings", {
    ...json({ ...context.engine.settings, runInBackground: true }),
    method: "PUT",
  });
  const savedPath = context.engine.settings.downloadPath;
  await context.engine.close();
  const release = launch(
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
    const state = (await (await fetch(`${url}/api/state`)).json()) as DashboardState;
    expect(state.settings.downloadPath).toBe(savedPath);
    expect(state.settings.runInBackground).toBe(true);
    expect(state.torrents[0]?.id).toBe(id);
    expect(state.torrents[0]?.status).toBe("paused");
    const bytes = await (await fetch(`${url}/api/torrents/${id}/files/0/content`)).arrayBuffer();
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
  const release = launch(config);
  let dev: ReturnType<typeof launch> | undefined;
  try {
    await release.ready();
    await release.stop();
    const before = await Bun.file(join(config.dataDir, "tofu.sqlite")).arrayBuffer();
    const alias = join(context.directory, "alias");
    await symlink(config.dataDir, alias, process.platform === "win32" ? "junction" : "dir");
    dev = launch({ ...config, dataDir: alias, profile: "dev" });
    const exit = await waitFor(
      async () => dev?.child.exitCode ?? null,
      (code) => code !== null
    );
    expect(exit).not.toBeNull();
    expect(exit).not.toBe(0);
    expect(await dev.output).toContain("profile release");
    expect(await Bun.file(join(config.dataDir, "tofu.sqlite")).arrayBuffer()).toEqual(before);
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
  let first = launch(config);
  let second: ReturnType<typeof launch> | undefined;
  try {
    const url = await first.ready();
    const before = await Bun.file(join(config.dataDir, "server.json")).text();
    second = launch(config);
    const exit = await waitFor(
      async () => second?.child.exitCode ?? null,
      (code) => code !== null
    );
    expect(exit).not.toBeNull();
    expect(exit).not.toBe(0);
    expect(await second.output).toContain("already in use");
    expect(await Bun.file(join(config.dataDir, "server.json")).text()).toBe(before);
    expect((await fetch(`${url}/api/health`)).ok).toBe(true);
    first.child.kill("SIGKILL");
    await first.child.exited;
    first = launch(config);
    expect((await fetch(`${await first.ready()}/api/health`)).ok).toBe(true);
    await first.stop();
    expect(await Bun.file(join(config.dataDir, "server.json")).exists()).toBe(false);
  } finally {
    await first.stop();
    await second?.stop();
    await context.close();
  }
}, 30_000);
