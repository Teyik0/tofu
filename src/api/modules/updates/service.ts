import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopContext } from "@teyik0/furin-electrobun/host";
import { Effect, Result } from "effect";
import type { Updater } from "electrobun/main";
import { problem } from "elysia";
import { desktopTarget, installerName } from "../../../../.github/scripts/platform";

const repository = "Teyik0/Tofu";
const versionPattern: RegExp = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionPrefix = /^v/;
interface UpdateOptions {
  apiOrigin: string;
  arch: string;
  dataDir: string;
  install?: DesktopContext["updates"]["install"];
  native?: typeof Updater;
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
  private readonly lifetime = new AbortController();
  private asset: ReleaseAsset | null = null;
  private pending: Promise<UpdateState> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private preparation: Promise<void> | null = null;
  private restart: ReturnType<typeof setTimeout> | undefined;
  private readonly snapshotState: UpdateState;

  private constructor(options: UpdateOptions, state: State) {
    this.options = options;
    this.path = join(options.dataDir, "release-access.json");
    this.state = state;
    this.snapshotState = {
      automatic: Boolean(options.native),
      checkedAt: null,
      currentVersion: options.version,
      downloadName: null,
      error: null,
      latestVersion: null,
      progress: null,
      releaseUrl: null,
      status: "idle",
    };
    this.observeNative();
  }
  private observeNative() {
    this.options.native?.onStatusChange((entry) => {
      if (this.lifetime.signal.aborted) {
        return;
      }
      if (entry.status === "download-progress" && this.snapshotState.status === "downloading") {
        this.snapshotState.progress = entry.details?.progress ?? null;
      }
      if (entry.status === "error") {
        this.snapshotState.error = entry.details?.errorMessage ?? entry.message;
      }
    });
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
  attachNative(
    native: typeof Updater,
    install: DesktopContext["updates"]["install"],
    notify: (version: string) => void
  ) {
    if (this.lifetime.signal.aborted) {
      return;
    }
    this.options.native?.onStatusChange(null);
    this.options.native = native;
    this.options.install = install;
    this.options.notify = notify;
    this.snapshotState.automatic = true;
    this.observeNative();
  }
  start() {
    if (this.lifetime.signal.aborted || this.timer) {
      return;
    }
    this.observeNative();
    void this.check();
    this.timer = setInterval(
      () => {
        void this.check();
      },
      6 * 60 * 60 * 1000
    );
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    clearTimeout(this.restart);
    this.timer = undefined;
    this.lifetime.abort();
    this.options.native?.onStatusChange(null);

    // Installation initiates shutdown itself; awaiting it here would deadlock.
    const settled = await Promise.allSettled([this.pending, this.preparation]);
    const failures = settled.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Unable to finish pending update operations"
      );
    }
  }
  private async persist() {
    const temporary = `${this.path}.tmp`;
    await Bun.write(temporary, JSON.stringify(this.state), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
  async check() {
    if (this.lifetime.signal.aborted) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    if (["downloading", "ready", "restarting"].includes(this.snapshotState.status)) {
      return this.snapshot();
    }
    this.pending ??= (async () => {
      using cleanup = new DisposableStack();
      cleanup.defer(() => {
        this.pending = null;
      });
      return await this.readLatest();
    })();
    return await this.pending;
  }
  private github(path: string, accept: string) {
    return fetch(`${this.options.apiOrigin}/repos/${repository}${path}`, {
      headers: {
        accept,
        "user-agent": `Tofu/${this.options.version}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]),
    });
  }
  private async readNativeLatest(native: typeof Updater) {
    // Electrobun checks the public manifest without using GitHub's REST API quota.
    const info = await native.checkForUpdate();
    if (this.lifetime.signal.aborted) {
      return this.snapshot();
    }
    this.snapshotState.checkedAt = Date.now();
    if (info.error) {
      this.snapshotState.status = "error";
      this.snapshotState.error = info.error;
      return this.snapshot();
    }
    const version = info.version || this.options.version;
    const available = info.updateAvailable && newer(version, this.options.version);
    const target = desktopTarget(this.options.platform, this.options.arch);
    Object.assign(this.snapshotState, {
      downloadName: available && target ? installerName(version, target) : null,
      latestVersion: version,
      releaseUrl: `https://github.com/${repository}/releases/tag/v${version}`,
      status: "current",
    });
    if (available) {
      this.snapshotState.status = info.updateReady ? "ready" : "available";
      if (this.state.notifiedVersion !== version) {
        this.options.notify(version);
        this.state.notifiedVersion = version;
        await this.persist();
      }
    }
    return this.snapshot();
  }
  private async readLatest() {
    if (this.lifetime.signal.aborted) {
      return this.snapshot();
    }
    this.asset = null;
    Object.assign(this.snapshotState, {
      downloadName: null,
      error: null,
      latestVersion: null,
      releaseUrl: null,
      status: "checking",
    });
    const service = this;
    const { native } = this.options;
    const githubCheck = Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        catch: (error) => error,
        try: () => service.github("/releases/latest", "application/vnd.github+json"),
      });
      if (service.lifetime.signal.aborted) {
        return service.snapshot();
      }
      service.snapshotState.checkedAt = Date.now();
      if ([401, 403].includes(response.status)) {
        return yield* Effect.fail(
          new Error(`GitHub rejected the update check (HTTP ${response.status})`)
        );
      }
      if (response.status === 404) {
        service.snapshotState.status = "no-release";
        return service.snapshot();
      }
      if (!response.ok) {
        return yield* Effect.fail(new Error(`GitHub is unavailable (HTTP ${response.status})`));
      }
      const body = yield* Effect.tryPromise({
        catch: (error) => error,
        try: () => response.json(),
      });
      const latest = yield* Effect.try({
        catch: (error) => error,
        try: () => release(body),
      });
      if (service.lifetime.signal.aborted) {
        return service.snapshot();
      }
      if (latest.draft || latest.prerelease) {
        return yield* Effect.fail(new Error("No stable release available"));
      }
      const version = latest.tag_name.replace(versionPrefix, "");
      yield* Effect.try({ catch: (error) => error, try: () => versionParts(version) });
      service.snapshotState.latestVersion = version;
      service.snapshotState.releaseUrl = `https://github.com/${repository}/releases/tag/v${version}`;
      if (!newer(version, service.options.version)) {
        service.snapshotState.status = "current";
        return service.snapshot();
      }
      service.asset = service.compatibleInstaller(latest, version);
      if (!service.asset) {
        return yield* Effect.fail(
          new Error("No installer compatible with this machine in the release")
        );
      }
      service.snapshotState.downloadName = service.asset.name;
      service.snapshotState.status = "available";
      if (service.state.notifiedVersion !== version) {
        service.options.notify(version);
        service.state.notifiedVersion = version;
        yield* Effect.tryPromise({ catch: (error) => error, try: () => service.persist() });
      }
      return service.snapshot();
    });
    const checked = await Effect.runPromise(
      Effect.result(
        native
          ? Effect.tryPromise({
              catch: (error) => error,
              try: () => service.readNativeLatest(native),
            })
          : githubCheck
      )
    );
    if (Result.isFailure(checked)) {
      const error = checked.failure;
      if (this.lifetime.signal.aborted) {
        return this.snapshot();
      }
      this.snapshotState.status = "error";
      this.snapshotState.error = error instanceof Error ? error.message : "Unable to verify";
    }
    return this.snapshot();
  }
  prepare() {
    if (this.lifetime.signal.aborted) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    const { native } = this.options;
    if (!native) {
      return problem(409, { detail: "In-app updates require the installed desktop app" });
    }
    if (this.snapshotState.status === "downloading" || this.snapshotState.status === "ready") {
      return this.snapshot();
    }
    if (this.pending || this.snapshotState.status !== "available") {
      return problem(409, { detail: "Check for updates before downloading an update" });
    }
    Object.assign(this.snapshotState, { error: null, progress: null, status: "downloading" });
    // The download continues after this response; its outcome is published in the snapshot.
    this.preparation = (async () => {
      using cleanup = new DisposableStack();
      cleanup.defer(() => {
        this.snapshotState.progress = null;
        this.preparation = null;
      });
      const downloaded = await Effect.runPromise(
        Effect.result(
          Effect.tryPromise({
            catch: (error) => error,
            try: async () => {
              await native.downloadUpdate();
              return native.updateInfo();
            },
          })
        )
      );
      if (Result.isSuccess(downloaded)) {
        if (this.lifetime.signal.aborted) {
          return;
        }
        const info = downloaded.success;
        if (info.error || !info.updateReady || info.version !== this.snapshotState.latestVersion) {
          this.snapshotState.status = "available";
          this.snapshotState.error = info.error || "The update could not be prepared";
        } else {
          this.snapshotState.status = "ready";
        }
      } else {
        const error = downloaded.failure;
        if (this.lifetime.signal.aborted) {
          return;
        }
        this.snapshotState.status = "available";
        this.snapshotState.error =
          error instanceof Error ? error.message : "Unable to prepare update";
      }
    })();
    return this.snapshot();
  }
  install() {
    if (this.lifetime.signal.aborted) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    const { native, install: installUpdate } = this.options;
    if (!(native && installUpdate) || this.preparation || this.snapshotState.status !== "ready") {
      return problem(409, { detail: "Download an update before restarting" });
    }
    this.snapshotState.status = "restarting";
    this.snapshotState.error = null;
    const install = async () => {
      const installed = await Effect.runPromise(
        Effect.result(Effect.tryPromise({ catch: (error) => error, try: () => installUpdate() }))
      );
      if (Result.isFailure(installed)) {
        const error = installed.failure;
        if (this.lifetime.signal.aborted) {
          return;
        }
        const info = Effect.runSync(Effect.result(Effect.try(() => native.updateInfo())));
        this.snapshotState.status =
          Result.isSuccess(info) && info.success.updateReady ? "ready" : "available";
        this.snapshotState.error =
          error instanceof Error ? error.message : "Unable to install update";
      }
    };
    // Let the HTTP response and its synchronized state reach the WebView first.
    this.restart = setTimeout(() => void install(), 250);
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
    if (this.lifetime.signal.aborted) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    if (!(this.asset && this.snapshotState.status === "available")) {
      return problem(409, { detail: "Check for updates before downloading the installer" });
    }
    const { asset } = this;
    const requested = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise(() =>
          this.github(`/releases/assets/${asset.id}`, "application/octet-stream")
        )
      )
    );
    if (Result.isFailure(requested)) {
      return problem(502, { detail: "GitHub could not be reached for this download" });
    }
    let response = requested.success;
    if ([401, 403, 404].includes(response.status)) {
      this.asset = null;
      this.snapshotState.downloadName = null;
      this.snapshotState.status = "error";
      this.snapshotState.error = "This release is no longer downloadable. Check for updates again.";
      return problem(502, { detail: this.snapshotState.error });
    }
    if (response.status === 302) {
      const location = response.headers.get("location");
      const target = location ? URL.parse(location) : null;
      if (
        target?.protocol !== "https:" ||
        !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
          target.hostname
        )
      ) {
        return problem(502, { detail: "GitHub returned an invalid download URL" });
      }
      // The signed asset URL needs no GitHub credential; never forward stale headers there.
      const downloaded = await Effect.runPromise(
        Effect.result(
          Effect.tryPromise(() =>
            fetch(target, {
              redirect: "error",
              signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120_000)]),
            })
          )
        )
      );
      if (Result.isFailure(downloaded)) {
        return problem(502, { detail: "The installer download could not be reached" });
      }
      response = downloaded.success;
    }
    if (!response.ok) {
      return problem(502, { detail: `Download unavailable (HTTP ${response.status})` });
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

export interface UpdateState {
  automatic: boolean;
  checkedAt: number | null;
  currentVersion: string;
  downloadName: string | null;
  error: string | null;
  latestVersion: string | null;
  progress: number | null;
  releaseUrl: string | null;
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "restarting"
    | "current"
    | "no-release"
    | "error";
}
