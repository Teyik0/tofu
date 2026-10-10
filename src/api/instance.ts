import { mkdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InstanceConfig, InstanceProfile } from "../types";
import { lockDataDirectory } from "./instance-lock";

function within(directory: string, root: string) {
  const path = relative(root, directory);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export async function readBundleIdentity(executable: string) {
  const directory = dirname(executable);
  const resources = join(directory, "../Resources");
  const macBundle = executable.includes(`${sep}Contents${sep}MacOS${sep}`);
  const nativeBundle =
    basename(directory) === "bin" && (await Bun.file(join(resources, "build.json")).exists());
  if (macBundle || nativeBundle) {
    const metadata: unknown = await Bun.file(join(resources, "version.json")).json();
    if (!metadata || typeof metadata !== "object" || !("channel" in metadata)) {
      throw new Error("The Tofu bundle profile is missing");
    }
    let profile: InstanceProfile;
    if (metadata.channel === "stable") {
      profile = "release";
    } else if (metadata.channel === "dev") {
      profile = "dev";
    } else {
      throw new Error("The Tofu bundle profile is unknown");
    }
    const identifier = profile === "dev" ? "app.tofu.torrents.dev" : "app.tofu.torrents";
    if (!("identifier" in metadata) || metadata.identifier !== identifier) {
      throw new Error(
        "The native Tofu identifier does not match the bundle profile; rebuild the app"
      );
    }
    return { identifier, profile };
  }
  return null;
}

export async function currentInstanceConfig() {
  // Packaged metadata wins over the terminal environment, independently of NODE_ENV.
  const bundle = await readBundleIdentity(process.execPath);
  let profile: InstanceProfile = bundle?.profile ?? "dev";
  const desktop = process.env.TOFU_MODE === "desktop" || bundle !== null;
  if (!bundle && process.env.TOFU_PROFILE !== undefined) {
    if (process.env.TOFU_PROFILE !== "dev" && process.env.TOFU_PROFILE !== "release") {
      throw new Error("TOFU_PROFILE must be dev or release");
    }
    profile = process.env.TOFU_PROFILE;
  }
  const config = resolveInstanceConfig({
    appDataDir: process.env.APPDATA,
    dataDir: process.env.TOFU_DATA_DIR,
    desktop,
    downloadPath: process.env.TOFU_DOWNLOAD_DIR,
    homeDir: homedir(),
    platform: process.platform,
    port: process.env.TOFU_PORT,
    profile,
  });
  return { ...config, desktop };
}

export function resolveInstanceConfig(options: {
  profile: InstanceProfile;
  homeDir: string;
  appDataDir?: string;
  platform: NodeJS.Platform;
  desktop: boolean;
  dataDir: string | undefined;
  downloadPath: string | undefined;
  port: string | undefined;
}): InstanceConfig {
  const development = options.profile === "dev";
  const directoryName = development ? "Tofu-dev" : "Tofu";
  const stateRoot =
    options.platform === "win32"
      ? (options.appDataDir ?? join(options.homeDir, "AppData/Roaming"))
      : join(
          options.homeDir,
          options.platform === "darwin" ? "Library/Application Support" : ".local/share"
        );
  const webPort = development ? "3030" : "3031";
  const port = Number(options.port ?? (options.desktop ? "0" : webPort));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("TOFU_PORT must be an integer between 0 and 65535");
  }
  const dataDir = resolve(options.dataDir ?? join(stateRoot, directoryName));
  if (development && within(dataDir, join(stateRoot, "Tofu"))) {
    throw new Error(
      "This data directory is reserved for release; use Tofu-dev or a separate test directory"
    );
  }
  return {
    dataDir,
    downloadPath: resolve(
      options.downloadPath ?? join(options.homeDir, "Downloads", directoryName)
    ),
    identifier: development ? "app.tofu.torrents.dev" : "app.tofu.torrents",
    name: development ? "Tofu Dev" : "Tofu",
    port,
    profile: options.profile,
  };
}

export async function acquireInstance(config: InstanceConfig) {
  await mkdir(config.dataDir, { recursive: true });
  if (config.profile === "dev") {
    const releaseDir = resolveInstanceConfig({
      appDataDir: process.env.APPDATA,
      dataDir: undefined,
      desktop: false,
      downloadPath: undefined,
      homeDir: homedir(),
      platform: process.platform,
      port: undefined,
      profile: "release",
    }).dataDir;
    const canonicalReleaseDir = await realpath(releaseDir).catch(() => releaseDir);
    if (within(await realpath(config.dataDir), canonicalReleaseDir)) {
      throw new Error(
        "This data directory is reserved for release, including through a symbolic link"
      );
    }
  }
  const lock = await lockDataDirectory(config.dataDir);
  try {
    await claimProfile(config);
  } catch (error) {
    lock.close();
    throw error;
  }
  return {
    async close() {
      try {
        await removeServerInfo(config.dataDir);
      } finally {
        lock.close();
      }
    },
  };
}

async function claimProfile(config: InstanceConfig) {
  const marker = Bun.file(join(config.dataDir, "instance.json"));
  if (await marker.exists()) {
    const metadata: unknown = await marker.json();
    if (!metadata || typeof metadata !== "object" || !("profile" in metadata)) {
      throw new Error("The Tofu data directory profile is invalid");
    }
    if (metadata.profile !== config.profile) {
      throw new Error(
        `This data directory belongs to profile ${String(metadata.profile)} ; profile ${config.profile} cannot open it`
      );
    }
    return;
  }
  await assertLegacyStopped(config.dataDir);
  const existing = await Promise.all(
    ["tofu.sqlite", "feeds.sqlite", "sync.sqlite", "release-access.json"].map((name) =>
      Bun.file(join(config.dataDir, name)).exists()
    )
  );
  if (config.profile === "dev" && existing.some(Boolean)) {
    throw new Error(
      "This directory contains Tofu data from an unknown profile; use an empty development directory"
    );
  }
  await Bun.write(marker, JSON.stringify({ profile: config.profile }), { mode: 0o600 });
}

async function assertLegacyStopped(dataDir: string) {
  const info = Bun.file(join(dataDir, "server.json"));
  if (!(await info.exists())) {
    return;
  }
  const metadata: unknown = await info.json();
  if (
    !(
      metadata &&
      typeof metadata === "object" &&
      "pid" in metadata &&
      typeof metadata.pid === "number" &&
      Number.isInteger(metadata.pid) &&
      metadata.pid > 0 &&
      metadata.pid !== process.pid
    )
  ) {
    return;
  }
  try {
    process.kill(metadata.pid, 0);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  throw new Error(
    "A legacy Tofu instance is already using this directory; quit it before starting this version"
  );
}

async function removeServerInfo(dataDir: string) {
  const path = join(dataDir, "server.json");
  const info = Bun.file(path);
  if (await info.exists()) {
    const metadata: unknown = await info.json();
    if (
      metadata &&
      typeof metadata === "object" &&
      "pid" in metadata &&
      metadata.pid === process.pid
    ) {
      await unlink(path);
    }
  }
}
