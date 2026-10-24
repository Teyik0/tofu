import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ApplicationRuntime } from "@teyik0/furin-electrobun/host";

import { lockDataDirectory } from "./instance-lock";

function within(directory: string, root: string) {
  const path = relative(root, directory);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function currentInstanceConfig(runtime?: ApplicationRuntime) {
  const desktop =
    runtime?.kind === "desktop" ||
    process.env.TOFU_MODE === "desktop" ||
    Boolean(process.env.FURIN_APP_DATA_DIR);

  const config = resolveInstanceConfig({
    appDataDir: process.env.APPDATA,
    dataDir: process.env.TOFU_DATA_DIR,
    desktop,
    downloadPath: process.env.TOFU_DOWNLOAD_DIR,
    homeDir: homedir(),
    platform: process.platform,
    profile: process.env.NODE_ENV === "production" ? "release" : "dev",
  });

  if (runtime?.kind === "desktop" && runtime.identity.identifier !== config.identifier) {
    throw new Error("The native Tofu identifier does not match NODE_ENV; rebuild the app");
  }

  if (
    (runtime?.kind === "desktop" || process.env.FURIN_APP_DATA_DIR !== undefined) &&
    process.env.FURIN_APP_DATA_DIR !== config.dataDir
  ) {
    throw new Error("The native host and Tofu must use the same data directory");
  }

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
