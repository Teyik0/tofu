import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { desktopTarget, installerName } from "../platform";
import type { UpdateState } from "../types";
import { UserError } from "./engine";

const repository = "Teyik0/Tofu";
const versionPattern: RegExp = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionPrefix = /^v/;
interface UpdateOptions {
  apiOrigin: string;
  arch: string;
  dataDir: string;
  notify: (version: string) => void;
  platform: string;
  version: string;
}
interface State {
  notifiedVersion: string | null;
}
interface ReleaseAsset {
  id: number;
  name: string;
}
interface Release {
  assets: ReleaseAsset[];
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
}

function release(value: unknown): Release {
  if (
    !value ||
    typeof value !== "object" ||
    !("tag_name" in value) ||
    typeof value.tag_name !== "string" ||
    !("draft" in value) ||
    typeof value.draft !== "boolean" ||
    !("prerelease" in value) ||
    typeof value.prerelease !== "boolean" ||
    !("assets" in value) ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("Invalid GitHub response");
  }
  const assets = value.assets.map((asset: unknown): ReleaseAsset => {
    if (
      !asset ||
      typeof asset !== "object" ||
      !("id" in asset) ||
      typeof asset.id !== "number" ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      !("name" in asset) ||
      typeof asset.name !== "string"
    ) {
      throw new Error("Invalid installer list");
    }
    return { id: asset.id, name: asset.name };
  });
  return { assets, draft: value.draft, prerelease: value.prerelease, tag_name: value.tag_name };
}

function versionParts(version: string) {
  const match: RegExpExecArray | null = versionPattern.exec(version);
  if (match === null) {
    throw new Error("Invalid release version (expected format: v1.2.3)");
  }
  return match.slice(1).map(Number);
}
function newer(candidate: string, installed: string) {
  const left = versionParts(candidate);
  const right = versionParts(installed);
  for (const index of [0, 1, 2]) {
    if (left[index] !== right[index]) {
      return (left[index] as number) > (right[index] as number);
    }
  }
  return false;
}

export class UpdatesService {
  private readonly options: UpdateOptions;
  private readonly path: string;
  private readonly state: State;
  private asset: ReleaseAsset | null = null;
  private pending: Promise<UpdateState> | null = null;
  private mutations: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private initial: ReturnType<typeof setTimeout> | undefined;
  private readonly snapshotState: UpdateState;

  private constructor(options: UpdateOptions, state: State) {
    this.options = options;
    this.path = join(options.dataDir, "release-access.json");
    this.state = state;
    this.snapshotState = {
      checkedAt: null,
      currentVersion: options.version,
      downloadName: null,
      error: null,
      latestVersion: null,
      releaseUrl: null,
      status: "idle",
    };
  }
  static async open(options: UpdateOptions) {
    await mkdir(options.dataDir, { recursive: true });
    const file = Bun.file(join(options.dataDir, "release-access.json"));
    const saved: unknown = (await file.exists()) ? await file.json() : null;
    const state: State = { notifiedVersion: null };
    if (
      saved &&
      typeof saved === "object" &&
      "notifiedVersion" in saved &&
      typeof saved.notifiedVersion === "string"
    ) {
      state.notifiedVersion = saved.notifiedVersion;
      await chmod(file.name as string, 0o600);
    }
    return new UpdatesService(options, state);
  }
  snapshot(): UpdateState {
    return { ...this.snapshotState };
  }
  start() {
    if (this.timer) {
      return;
    }
    this.initial = setTimeout(() => {
      void this.check();
    }, 10_000);
    this.initial.unref();
    this.timer = setInterval(
      () => {
        void this.check();
      },
      6 * 60 * 60 * 1000
    );
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    clearTimeout(this.initial);
    this.timer = undefined;
  }
  private async persist() {
    const temporary = `${this.path}.tmp`;
    await Bun.write(temporary, JSON.stringify(this.state), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(action);
    this.mutations = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
  check(): Promise<UpdateState> {
    this.pending ??= this.serial(() => this.readLatest()).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private github(path: string, accept: string) {
    return fetch(`${this.options.apiOrigin}/repos/${repository}${path}`, {
      headers: {
        accept,
        "user-agent": `Tofu/${this.options.version}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  }
  private async readLatest() {
    this.asset = null;
    Object.assign(this.snapshotState, {
      downloadName: null,
      error: null,
      latestVersion: null,
      releaseUrl: null,
      status: "checking",
    });
    try {
      const response = await this.github("/releases/latest", "application/vnd.github+json");
      this.snapshotState.checkedAt = Date.now();
      if (response.status === 401 || response.status === 403) {
        throw new Error(`GitHub rejected the update check (HTTP ${response.status})`);
      }
      if (response.status === 404) {
        this.snapshotState.status = "no-release";
        return this.snapshot();
      }
      if (!response.ok) {
        throw new Error(`GitHub is unavailable (HTTP ${response.status})`);
      }
      const latest = release(await response.json());
      if (latest.draft || latest.prerelease) {
        throw new Error("No stable release available");
      }
      const version = latest.tag_name.replace(versionPrefix, "");
      versionParts(version);
      this.snapshotState.latestVersion = version;
      this.snapshotState.releaseUrl = `https://github.com/${repository}/releases/tag/v${version}`;
      if (!newer(version, this.options.version)) {
        this.snapshotState.status = "current";
        return this.snapshot();
      }
      this.asset = this.compatibleInstaller(latest, version);
      if (!this.asset) {
        throw new Error("No installer compatible with this machine in the release");
      }
      this.snapshotState.downloadName = this.asset.name;
      this.snapshotState.status = "available";
      if (this.state.notifiedVersion !== version) {
        this.options.notify(version);
        this.state.notifiedVersion = version;
        await this.persist();
      }
    } catch (error) {
      this.snapshotState.status = "error";
      this.snapshotState.error = error instanceof Error ? error.message : "Unable to verify";
    }
    return this.snapshot();
  }
  private compatibleInstaller(latest: Release, version: string) {
    const target = desktopTarget(this.options.platform, this.options.arch);
    if (!target) {
      return null;
    }
    const name = installerName(version, target);
    return latest.assets.find((item) => item.name === name) ?? null;
  }
  async download() {
    if (!(this.asset && this.snapshotState.status === "available")) {
      throw new UserError("Check for updates before downloading the installer", {
        status: 409,
      });
    }
    const { asset } = this;
    let response = await this.github(`/releases/assets/${asset.id}`, "application/octet-stream");
    if ([401, 403, 404].includes(response.status)) {
      this.asset = null;
      this.snapshotState.downloadName = null;
      this.snapshotState.status = "error";
      this.snapshotState.error = "This release is no longer downloadable. Check for updates again.";
      throw new UserError(this.snapshotState.error, { status: 502 });
    }
    if (response.status === 302) {
      const location = response.headers.get("location");
      const target = location ? new URL(location) : null;
      if (
        target?.protocol !== "https:" ||
        !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
          target.hostname
        )
      ) {
        throw new UserError("GitHub returned an invalid download URL", {
          status: 502,
        });
      }
      // The signed asset URL needs no GitHub credential; never forward stale headers there.
      response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(120_000) });
    }
    if (!response.ok) {
      throw new UserError(`Download unavailable (HTTP ${response.status})`, { status: 502 });
    }
    return new Response(response.body, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${asset.name}"`,
        "content-type": "application/octet-stream",
      },
    });
  }
}
