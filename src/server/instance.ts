import { closeSync, openSync } from "node:fs";
import { mkdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InstanceConfig, InstanceProfile } from "../types";

function within(directory: string, root: string) {
  const path = relative(root, directory);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export async function currentInstanceConfig() {
  let profile: InstanceProfile = "dev";
  let bundleIdentifier: unknown;
  const desktop =
    process.env.TOFU_MODE === "desktop" || process.execPath.includes(".app/Contents/MacOS/");
  if (process.execPath.includes(".app/Contents/MacOS/")) {
    // Packaged metadata wins over the terminal environment, independently of NODE_ENV.
    const metadata: unknown = await Bun.file(
      join(dirname(process.execPath), "../Resources/version.json")
    ).json();
    if (!metadata || typeof metadata !== "object" || !("channel" in metadata)) {
      throw new Error("Le profil du bundle Tofu est absent");
    }
    if (metadata.channel === "stable") {
      profile = "release";
    } else if (metadata.channel !== "dev") {
      throw new Error("Le profil du bundle Tofu est inconnu");
    }
    bundleIdentifier = "identifier" in metadata ? metadata.identifier : undefined;
  } else if (process.env.TOFU_PROFILE !== undefined) {
    if (process.env.TOFU_PROFILE !== "dev" && process.env.TOFU_PROFILE !== "release") {
      throw new Error("TOFU_PROFILE doit être dev ou release");
    }
    profile = process.env.TOFU_PROFILE;
  }
  const config = resolveInstanceConfig({
    dataDir: process.env.TOFU_DATA_DIR,
    desktop,
    downloadPath: process.env.TOFU_DOWNLOAD_DIR,
    homeDir: homedir(),
    platform: process.platform,
    port: process.env.TOFU_PORT,
    profile,
  });
  if (process.execPath.includes(".app/Contents/MacOS/") && bundleIdentifier !== config.identifier) {
    throw new Error(
      "L’identifiant natif Tofu ne correspond pas au profil du bundle ; reconstruisez l’application"
    );
  }
  return { ...config, desktop };
}

export function resolveInstanceConfig(options: {
  profile: InstanceProfile;
  homeDir: string;
  platform: NodeJS.Platform;
  desktop: boolean;
  dataDir: string | undefined;
  downloadPath: string | undefined;
  port: string | undefined;
}): InstanceConfig {
  const development = options.profile === "dev";
  const directoryName = development ? "Tofu-dev" : "Tofu";
  const stateRoot = join(
    options.homeDir,
    options.platform === "darwin" ? "Library/Application Support" : ".local/share"
  );
  const webPort = development ? "3030" : "3031";
  const port = Number(options.port ?? (options.desktop ? "0" : webPort));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("TOFU_PORT doit être un entier entre 0 et 65535");
  }
  const dataDir = resolve(options.dataDir ?? join(stateRoot, directoryName));
  if (development && within(dataDir, join(stateRoot, "Tofu"))) {
    throw new Error(
      "Ce dossier de données est réservé à la release ; utilisez Tofu-dev ou un dossier de test distinct"
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

// Keep the inode in place: deleting a lock file would let another process lock a different inode.
// The kernel releases flock even after SIGKILL; no stale PID guessing is required.
export async function acquireInstance(config: InstanceConfig) {
  await mkdir(config.dataDir, { recursive: true });
  if (config.profile === "dev") {
    const releaseDir = resolveInstanceConfig({
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
        "Ce dossier de données est réservé à la release, y compris via un lien symbolique"
      );
    }
  }
  const { dlopen, FFIType } = await import("bun:ffi");
  const library = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const fd = openSync(join(config.dataDir, "instance.lock"), "a+", 0o600);
  const exclusiveNonBlocking = 6; // LOCK_EX (2) + LOCK_NB (4).
  if (library.symbols.flock(fd, exclusiveNonBlocking) !== 0) {
    closeSync(fd);
    library.close();
    throw new Error(
      `Le dossier de données est déjà utilisé par une autre instance Tofu : ${config.dataDir}`
    );
  }
  try {
    await claimProfile(config);
  } catch (error) {
    closeSync(fd);
    library.close();
    throw error;
  }
  return {
    async close() {
      try {
        await removeServerInfo(config.dataDir);
      } finally {
        closeSync(fd);
        library.close();
      }
    },
  };
}

async function claimProfile(config: InstanceConfig) {
  const marker = Bun.file(join(config.dataDir, "instance.json"));
  if (await marker.exists()) {
    const metadata: unknown = await marker.json();
    if (!metadata || typeof metadata !== "object" || !("profile" in metadata)) {
      throw new Error("Le profil du dossier de données Tofu est invalide");
    }
    if (metadata.profile !== config.profile) {
      throw new Error(
        `Ce dossier de données appartient au profil ${String(metadata.profile)} ; le profil ${config.profile} ne peut pas l’ouvrir`
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
      "Ce dossier contient des données Tofu d’un profil inconnu ; utilisez un dossier de développement vide"
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
    "Une ancienne instance Tofu utilise déjà ce dossier ; quittez-la avant de démarrer cette version"
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
