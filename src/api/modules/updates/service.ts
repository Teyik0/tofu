import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopContext } from "@teyik0/furin-electrobun/host";
import { Cause, Context, Effect, Exit, Fiber, Layer, Result, Schedule } from "effect";
import type { Updater } from "electrobun/main";
import { problem } from "elysia";
import { createLogger } from "evlog";
import { desktopTarget, installerName } from "../../../../.github/scripts/platform";
import { version } from "../../../../package.json";
import { instance } from "../../lib/instance";

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

function versionParts(currentVersion: string) {
  const match: RegExpExecArray | null = versionPattern.exec(currentVersion);
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

const make = Effect.gen(function* () {
  const options: UpdateOptions = {
    apiOrigin: "https://api.github.com",
    arch: process.arch,
    dataDir: instance.dataDir,
    notify: () => undefined,
    platform: process.platform,
    version,
  };
  yield* Effect.tryPromise(() => mkdir(options.dataDir, { recursive: true }));
  const file = Bun.file(join(options.dataDir, "release-access.json"));
  const saved: unknown = (yield* Effect.tryPromise(() => file.exists()))
    ? yield* Effect.tryPromise(() => file.json())
    : null;
  const state: State = { notifiedVersion: null };
  if (
    saved &&
    typeof saved === "object" &&
    "notifiedVersion" in saved &&
    typeof saved.notifiedVersion === "string"
  ) {
    state.notifiedVersion = saved.notifiedVersion;
    yield* Effect.tryPromise(() => chmod(file.name as string, 0o600));
  }

  const serviceOptions = options;
  const scope = yield* Effect.scope;

  let servicePath: string;
  let serviceState: State;
  const serviceLifetime = new AbortController();
  let serviceAsset: ReleaseAsset | null = null;
  let servicePending: Effect.Effect<UpdateState> | null = null;
  let serviceTimer: Fiber.Fiber<void> | null = null;
  let servicePreparation: Effect.Effect<void> | null = null;
  let serviceRestart: ReturnType<typeof setTimeout> | undefined;
  let serviceSnapshotState: UpdateState;
  function serviceObserveNative() {
    serviceOptions.native?.onStatusChange((entry) => {
      if (serviceLifetime.signal.aborted) {
        return;
      }
      if (entry.status === "download-progress" && serviceSnapshotState.status === "downloading") {
        serviceSnapshotState.progress = entry.details?.progress ?? null;
      }
      if (entry.status === "error") {
        serviceSnapshotState.error = entry.details?.errorMessage ?? entry.message;
      }
    });
  }
  function serviceSnapshot(): UpdateState {
    return { ...serviceSnapshotState };
  }
  function serviceAttachNative(
    native: typeof Updater,
    install: DesktopContext["updates"]["install"],
    notify: (version: string) => void
  ) {
    if (serviceLifetime.signal.aborted) {
      return;
    }
    serviceOptions.native?.onStatusChange(null);
    serviceOptions.native = native;
    serviceOptions.install = install;
    serviceOptions.notify = notify;
    serviceSnapshotState.automatic = true;
    serviceObserveNative();
  }
  const serviceStart = Effect.fn("Updates.start")(function* () {
    if (serviceLifetime.signal.aborted || serviceTimer) {
      return;
    }
    serviceObserveNative();
    serviceTimer = yield* Effect.forkIn(
      serviceCheck().pipe(
        Effect.asVoid,
        Effect.repeat(Schedule.spaced("6 hours")),
        Effect.asVoid,
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            if (Cause.hasInterruptsOnly(cause)) {
              return;
            }
            const log = createLogger({
              component: "updates",
              error: Cause.squash(cause),
              operation: "check",
            });
            log.setLevel("error");
            log.emit();
          })
        )
      ),
      scope
    );
  });
  const serviceClose = Effect.fn("Updates.close")(function* () {
    serviceLifetime.abort();
    clearTimeout(serviceRestart);
    serviceOptions.native?.onStatusChange(null);
    if (serviceTimer) {
      yield* Fiber.interrupt(serviceTimer);
      serviceTimer = null;
    }
    // Installation initiates shutdown itself; it cannot belong to this drain.
    const settled = yield* Effect.all(
      [Effect.exit(servicePending ?? Effect.void), Effect.exit(servicePreparation ?? Effect.void)],
      { concurrency: "unbounded" }
    );
    const failures = settled.filter(
      (exit) => Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
    );
    if (failures.length) {
      return yield* Effect.die(
        new AggregateError(
          failures.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
          "Unable to finish pending update operations"
        )
      );
    }
  });
  const servicePersist = Effect.fn("Updates.persist")(function* () {
    const temporary = `${servicePath}.tmp`;
    yield* Effect.tryPromise(() =>
      Bun.write(temporary, JSON.stringify(serviceState), { mode: 0o600 })
    );
    yield* Effect.tryPromise(() => chmod(temporary, 0o600));
    yield* Effect.tryPromise(() => rename(temporary, servicePath));
  });
  const serviceCheck = Effect.fn("Updates.check")(function* () {
    if (serviceLifetime.signal.aborted) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    if (["downloading", "ready", "restarting"].includes(serviceSnapshotState.status)) {
      return serviceSnapshot();
    }
    if (servicePending) {
      return yield* servicePending;
    }
    const pending = yield* Effect.cached(
      serviceReadLatest().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (servicePending === pending) {
              servicePending = null;
            }
          })
        )
      )
    );
    // cached is synchronous: publish the shared operation before its first I/O.
    servicePending = pending;
    return yield* pending;
  });
  const serviceGithub = Effect.fn("Updates.github")(function* (path: string, accept: string) {
    return yield* Effect.tryPromise((signal) =>
      fetch(`${serviceOptions.apiOrigin}/repos/${repository}${path}`, {
        headers: {
          accept,
          "user-agent": `Tofu/${serviceOptions.version}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "manual",
        signal: AbortSignal.any([signal, serviceLifetime.signal, AbortSignal.timeout(30_000)]),
      })
    );
  });
  const serviceReadNativeLatest = Effect.fn("Updates.readNativeLatest")(function* (
    native: typeof Updater
  ) {
    // Electrobun checks the public manifest without using GitHub's REST API quota.
    const info = yield* Effect.tryPromise(() => native.checkForUpdate());
    if (serviceLifetime.signal.aborted) {
      return serviceSnapshot();
    }
    serviceSnapshotState.checkedAt = Date.now();
    if (info.error) {
      serviceSnapshotState.status = "error";
      serviceSnapshotState.error = info.error;
      return serviceSnapshot();
    }
    const currentVersion = info.version || serviceOptions.version;
    const available =
      info.updateAvailable &&
      (yield* Effect.try(() => newer(currentVersion, serviceOptions.version)));
    const target = desktopTarget(serviceOptions.platform, serviceOptions.arch);
    Object.assign(serviceSnapshotState, {
      downloadName: available && target ? installerName(currentVersion, target) : null,
      latestVersion: currentVersion,
      releaseUrl: `https://github.com/${repository}/releases/tag/v${currentVersion}`,
      status: "current",
    });
    if (available) {
      serviceSnapshotState.status = info.updateReady ? "ready" : "available";
      if (serviceState.notifiedVersion !== currentVersion) {
        serviceOptions.notify(currentVersion);
        serviceState.notifiedVersion = currentVersion;
        yield* servicePersist();
      }
    }
    return serviceSnapshot();
  }, Effect.scoped);
  const serviceReadLatest = Effect.fn("Updates.readLatest")(function* () {
    if (serviceLifetime.signal.aborted) {
      return serviceSnapshot();
    }
    serviceAsset = null;
    Object.assign(serviceSnapshotState, {
      downloadName: null,
      error: null,
      latestVersion: null,
      releaseUrl: null,
      status: "checking",
    });

    const { native } = serviceOptions;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
    const githubCheck = Effect.gen(function* () {
      const response = yield* serviceGithub("/releases/latest", "application/vnd.github+json");
      if (serviceLifetime.signal.aborted) {
        return serviceSnapshot();
      }
      serviceSnapshotState.checkedAt = Date.now();
      if ([401, 403].includes(response.status)) {
        return yield* Effect.fail(
          new Error(`GitHub rejected the update check (HTTP ${response.status})`)
        );
      }
      if (response.status === 404) {
        serviceSnapshotState.status = "no-release";
        return serviceSnapshot();
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
      if (serviceLifetime.signal.aborted) {
        return serviceSnapshot();
      }
      if (latest.draft || latest.prerelease) {
        return yield* Effect.fail(new Error("No stable release available"));
      }
      const currentVersion = latest.tag_name.replace(versionPrefix, "");
      yield* Effect.try({ catch: (error) => error, try: () => versionParts(currentVersion) });
      serviceSnapshotState.latestVersion = currentVersion;
      serviceSnapshotState.releaseUrl = `https://github.com/${repository}/releases/tag/v${currentVersion}`;
      if (!newer(currentVersion, serviceOptions.version)) {
        serviceSnapshotState.status = "current";
        return serviceSnapshot();
      }
      serviceAsset = serviceCompatibleInstaller(latest, currentVersion);
      if (!serviceAsset) {
        return yield* Effect.fail(
          new Error("No installer compatible with this machine in the release")
        );
      }
      serviceSnapshotState.downloadName = serviceAsset.name;
      serviceSnapshotState.status = "available";
      if (serviceState.notifiedVersion !== currentVersion) {
        serviceOptions.notify(currentVersion);
        serviceState.notifiedVersion = currentVersion;
        yield* servicePersist();
      }
      return serviceSnapshot();
    });
    const checked = yield* Effect.result(native ? serviceReadNativeLatest(native) : githubCheck);
    if (Result.isFailure(checked)) {
      const error = checked.failure;
      if (serviceLifetime.signal.aborted) {
        return serviceSnapshot();
      }
      serviceSnapshotState.status = "error";
      serviceSnapshotState.error = error instanceof Error ? error.message : "Unable to verify";
    }
    return serviceSnapshot();
  });
  const servicePrepare = Effect.fn("Updates.prepare")(function* () {
    if (serviceLifetime.signal.aborted) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    const { native } = serviceOptions;
    if (!native) {
      return problem(409, { detail: "In-app updates require the installed desktop app" });
    }
    if (serviceSnapshotState.status === "downloading" || serviceSnapshotState.status === "ready") {
      return serviceSnapshot();
    }
    if (servicePending || serviceSnapshotState.status !== "available") {
      return problem(409, { detail: "Check for updates before downloading an update" });
    }
    Object.assign(serviceSnapshotState, { error: null, progress: null, status: "downloading" });
    const preparation = yield* Effect.cached(
      Effect.gen(function* () {
        const downloaded = yield* Effect.result(
          Effect.gen(function* () {
            // The native SDK cannot cancel this download. Drain it before releasing the host.
            yield* Effect.tryPromise(() => native.downloadUpdate());
            return yield* Effect.try(() => native.updateInfo());
          })
        );
        if (serviceLifetime.signal.aborted) {
          return;
        }
        if (Result.isFailure(downloaded)) {
          const error = downloaded.failure;
          serviceSnapshotState.status = "available";
          serviceSnapshotState.error =
            error instanceof Error ? error.message : "Unable to prepare update";
          return;
        }
        const info = downloaded.success;
        if (
          info.error ||
          !info.updateReady ||
          info.version !== serviceSnapshotState.latestVersion
        ) {
          serviceSnapshotState.status = "available";
          serviceSnapshotState.error = info.error || "The update could not be prepared";
        } else {
          serviceSnapshotState.status = "ready";
        }
      }).pipe(
        Effect.uninterruptible,
        Effect.ensuring(
          Effect.sync(() => {
            serviceSnapshotState.progress = null;
            if (servicePreparation === preparation) {
              servicePreparation = null;
            }
          })
        ),
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            if (Cause.hasInterruptsOnly(cause)) {
              return;
            }
            const log = createLogger({
              component: "updates",
              error: Cause.squash(cause),
              operation: "prepare",
            });
            log.setLevel("error");
            log.emit();
          })
        )
      )
    );
    servicePreparation = preparation;
    yield* Effect.forkIn(preparation, scope);
    return serviceSnapshot();
  });
  function serviceInstall() {
    if (serviceLifetime.signal.aborted) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    const { native, install: installUpdate } = serviceOptions;
    if (
      !(native && installUpdate) ||
      servicePreparation ||
      serviceSnapshotState.status !== "ready"
    ) {
      return problem(409, { detail: "Download an update before restarting" });
    }
    serviceSnapshotState.status = "restarting";
    serviceSnapshotState.error = null;
    const install = async () => {
      const installed = await Effect.runPromise(
        Effect.result(Effect.tryPromise({ catch: (error) => error, try: () => installUpdate() }))
      );
      if (Result.isFailure(installed)) {
        const error = installed.failure;
        if (serviceLifetime.signal.aborted) {
          return;
        }
        const info = Effect.runSync(Effect.result(Effect.try(() => native.updateInfo())));
        serviceSnapshotState.status =
          Result.isSuccess(info) && info.success.updateReady ? "ready" : "available";
        serviceSnapshotState.error =
          error instanceof Error ? error.message : "Unable to install update";
      }
    };
    // Let the HTTP response and its synchronized state reach the WebView first.
    serviceRestart = setTimeout(() => void install(), 250);
    return serviceSnapshot();
  }
  function serviceCompatibleInstaller(latest: Release, currentVersion: string) {
    const target = desktopTarget(serviceOptions.platform, serviceOptions.arch);
    if (!target) {
      return null;
    }
    const name = installerName(currentVersion, target);
    return latest.assets.find((item) => item.name === name) ?? null;
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceDownload = Effect.fn("Updates.download")(function* () {
    if (serviceLifetime.signal.aborted) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    if (!(serviceAsset && serviceSnapshotState.status === "available")) {
      return problem(409, { detail: "Check for updates before downloading the installer" });
    }
    const asset = serviceAsset;
    const requested = yield* Effect.result(
      serviceGithub(`/releases/assets/${asset.id}`, "application/octet-stream")
    );
    if (Result.isFailure(requested)) {
      return problem(502, { detail: "GitHub could not be reached for this download" });
    }
    let response = requested.success;
    if ([401, 403, 404].includes(response.status)) {
      serviceAsset = null;
      serviceSnapshotState.downloadName = null;
      serviceSnapshotState.status = "error";
      serviceSnapshotState.error =
        "This release is no longer downloadable. Check for updates again.";
      return problem(502, { detail: serviceSnapshotState.error });
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
      const downloaded = yield* Effect.result(
        Effect.tryPromise(() =>
          fetch(target, {
            redirect: "error",
            signal: AbortSignal.any([serviceLifetime.signal, AbortSignal.timeout(120_000)]),
          })
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
  });
  servicePath = join(options.dataDir, "release-access.json");
  serviceState = state;
  serviceSnapshotState = {
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
  yield* Effect.addFinalizer(() => serviceClose());
  serviceObserveNative();
  return {
    attachNative: serviceAttachNative,
    check: serviceCheck,
    close: serviceClose,
    download: serviceDownload,
    install: serviceInstall,
    prepare: servicePrepare,
    snapshot: serviceSnapshot,
    start: serviceStart,
  };
});

export type UpdatesService = Updates["Service"];
export class Updates extends Context.Service<
  Updates,
  {
    readonly snapshot: () => UpdateState;
    readonly attachNative: (
      native: typeof Updater,
      install: DesktopContext["updates"]["install"],
      notify: (version: string) => void
    ) => void;
    readonly start: () => Effect.Effect<void>;
    readonly close: () => Effect.Effect<void>;
    readonly check: () => Effect.Effect<
      | UpdateState
      | ReturnType<typeof problem<409, { readonly detail: "The update service is shutting down" }>>
    >;
    readonly prepare: () => Effect.Effect<
      | UpdateState
      | ReturnType<typeof problem<409, { readonly detail: "The update service is shutting down" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "In-app updates require the installed desktop app" }
          >
        >
      | ReturnType<
          typeof problem<409, { readonly detail: "Check for updates before downloading an update" }>
        >
    >;
    readonly install: () =>
      | UpdateState
      | ReturnType<typeof problem<409, { readonly detail: "The update service is shutting down" }>>
      | ReturnType<
          typeof problem<409, { readonly detail: "Download an update before restarting" }>
        >;
    readonly download: () => Effect.Effect<
      | Response
      | ReturnType<typeof problem<409, { readonly detail: "The update service is shutting down" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "Check for updates before downloading the installer" }
          >
        >
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
  }
>()("tofu/updates") {}
export const updatesLayer = Layer.effect(Updates, make);

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
