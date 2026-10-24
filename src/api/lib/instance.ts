import { existsSync, readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ApplicationRuntime, DesktopIdentity } from "@teyik0/furin-electrobun/host";

import { lockDataDirectory } from "./instance-lock";

function within(directory: string, root: string) {
  const path = relative(root, directory);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function readBundleIdentity(executable: string) {
  const directory = dirname(executable);
  const resources = join(directory, "../Resources");
  const macBundle = executable.includes(`${sep}Contents${sep}MacOS${sep}`);
  const nativeBundle = basename(directory) === "bin" && existsSync(join(resources, "build.json"));
  if (macBundle || nativeBundle) {
    const metadata: unknown = JSON.parse(readFileSync(join(resources, "version.json"), "utf8"));
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

export function desktopInstanceConfig(identity: DesktopIdentity) {
  const profile = identity.channel === "stable" ? "release" : "dev";
  if (!["stable", "dev"].includes(identity.channel)) {
    throw new Error("The Tofu bundle profile is unknown");
  }
  const config = resolveInstanceConfig({
    appDataDir: process.env.APPDATA,
    dataDir: process.env.TOFU_DATA_DIR,
    desktop: true,
    downloadPath: process.env.TOFU_DOWNLOAD_DIR,
    homeDir: homedir(),
    platform: process.platform,
    profile,
  });
  if (identity.identifier !== config.identifier) {
    throw new Error(
      "The native Tofu identifier does not match the bundle profile; rebuild the app"
    );
  }
  return { ...config, desktop: true };
}

export function currentInstanceConfig(runtime?: ApplicationRuntime) {
  if (runtime?.kind === "desktop") {
    const config = desktopInstanceConfig(runtime.identity);
    if (process.env.FURIN_APP_DATA_DIR !== config.dataDir) {
      throw new Error("The native host and Tofu must use the same data directory");
    }
    return config;
  }
  // Packaged metadata wins over the terminal environment, independently of NODE_ENV.
  const bundle = readBundleIdentity(process.execPath);
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
      profile: "release",
    }).dataDir;
    let canonicalReleaseDir = releaseDir;
    try {
      canonicalReleaseDir = await realpath(releaseDir);
    } catch {
      // A release directory that does not exist yet cannot be a symbolic link target.
    }
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
  return { close: lock.close };
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

export interface InstanceConfig {
  dataDir: string;
  downloadPath: string;
  identifier: string;
  name: string;
  profile: InstanceProfile;
}

export type InstanceProfile = "dev" | "release";
