import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopContext } from "@teyik0/furin-electrobun/host";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Schedule,
  Schema,
  Scope,
  ScopedRef,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { Updater } from "electrobun/main";
import { problem } from "elysia";
import { createLogger } from "evlog";
import { desktopTarget, installerName } from "../../../../../../.github/scripts/platform";
import { version } from "../../../../package.json";
import { instance } from "../../lib/instance";

const repository = "Teyik0/Tofu";
const versionPattern: RegExp = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionPrefix = /^v/;

const releaseSchema = Schema.Struct({
  assets: Schema.Array(Schema.Unknown),
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  tag_name: Schema.String,
});

const releaseAssetsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Int.check(Schema.isGreaterThan(0)),
    name: Schema.String,
  })
);

const decodeRelease = Schema.decodeUnknownEffect(releaseSchema);
const decodeReleaseAssets = Schema.decodeUnknownEffect(releaseAssetsSchema);
const decodeVersion = Schema.decodeUnknownEffect(
  Schema.String.check(Schema.isPattern(versionPattern))
);

const decodeState = Schema.decodeUnknownEffect(
  Schema.Struct({
    notifiedVersion: Schema.NullOr(Schema.String).pipe(Schema.mutableKey),
  })
);
type State = Effect.Success<ReturnType<typeof decodeState>>;

class UpdateError extends Schema.TaggedError<UpdateError>()("UpdateError", {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

interface UpdateOptions {
  apiOrigin: string;
  arch: string;
  install?: DesktopContext["updates"]["install"];
  native?: typeof Updater;
  notify: (version: string) => void;
  platform: string;
  version: string;
}
type ReleaseAsset = (typeof releaseAssetsSchema.Type)[number];

const versionParts = Effect.fn("Updates.versionParts")(function* (currentVersion: string) {
  const validated = yield* decodeVersion(currentVersion).pipe(
    Effect.mapError(
      (cause) =>
        new UpdateError({
          cause,
          message: "Invalid release version (expected format: v1.2.3)",
        })
    )
  );
  return validated.replace(versionPrefix, "").split(".").map(Number);
});

function newer(left: readonly number[], right: readonly number[]) {
  for (const index of [0, 1, 2]) {
    if (left[index] !== right[index]) {
      return (left[index] as number) > (right[index] as number);
    }
  }
  return false;
}

const make = Effect.gen(function* () {
  yield* Effect.tryPromise(() => mkdir(instance.dataDir, { recursive: true }));

  const file = Bun.file(join(instance.dataDir, "release-access.json"));

  const state = (yield* Effect.promise(() => file.exists()))
    ? yield* Effect.tryPromise(() => file.json()).pipe(
        Effect.flatMap(decodeState),
        Effect.catchTags({
          SchemaError: () => Effect.succeed({ notifiedVersion: null }),
        })
      )
    : { notifiedVersion: null };

  if (state.notifiedVersion !== null) {
    yield* Effect.tryPromise(() => chmod(file.name as string, 0o600));
  }

  const scope = yield* Effect.scope;

  const httpScope = yield* Scope.fork(scope);
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);

  const options: UpdateOptions = {
    apiOrigin: "https://api.github.com",
    arch: process.arch,
    notify: () => undefined,
    platform: process.platform,
    version,
  };

  let servicePath: string;
  let serviceState: State;
  let serviceClosed = false;
  let serviceAsset: ReleaseAsset | null = null;
  let servicePending: Effect.Effect<UpdateState> | null = null;
  let serviceTimer: Fiber.Fiber<void> | null = null;
  let servicePreparation: Effect.Effect<void> | null = null;
  let serviceRestart: Fiber.Fiber<void> | null = null;
  let serviceSnapshotState: UpdateState;

  const nativeSubscription = yield* ScopedRef.make<void>(() => undefined);
  const serviceObserveNative = Effect.fn("Updates.observeNative")(function* (
    native: typeof Updater
  ) {
    yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) => new UpdateError({ cause, message: "Unable to observe native updates" }),
        try: () =>
          native.onStatusChange((entry) => {
            if (serviceClosed) {
              return;
            }
            if (
              entry.status === "download-progress" &&
              serviceSnapshotState.status === "downloading"
            ) {
              serviceSnapshotState.progress = entry.details?.progress ?? null;
            }
            if (entry.status === "error") {
              serviceSnapshotState.error = entry.details?.errorMessage ?? entry.message;
            }
          }),
      }),
      () => Effect.sync(() => native.onStatusChange(null))
    );
  });

  function serviceSnapshot(): UpdateState {
    return { ...serviceSnapshotState };
  }

  const serviceAttachNative = Effect.fn("Updates.attachNative")(function* (
    native: typeof Updater,
    install: DesktopContext["updates"]["install"],
    notify: (version: string) => void
  ) {
    if (serviceClosed) {
      return;
    }
    if (options.native !== native) {
      yield* ScopedRef.set(nativeSubscription, serviceObserveNative(native));
      options.native = native;
    }
    options.install = install;
    options.notify = notify;
    serviceSnapshotState.automatic = true;
  }, Effect.uninterruptible);
  const serviceStart = Effect.fn("Updates.start")(function* () {
    if (serviceClosed || serviceTimer) {
      return;
    }
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
    serviceClosed = true;
    yield* Scope.close(httpScope, Exit.void);
    if (serviceRestart) {
      yield* Fiber.interrupt(serviceRestart);
      serviceRestart = null;
    }
    yield* ScopedRef.set(nativeSubscription, Effect.void);
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
    if (serviceClosed) {
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
    return yield* http
      .get(`${options.apiOrigin}/repos/${repository}${path}`, {
        headers: {
          accept,
          "user-agent": `Tofu/${options.version}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      })
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("30 seconds")
      );
  });
  const serviceReadNativeLatest = Effect.fn("Updates.readNativeLatest")(function* (
    native: typeof Updater
  ) {
    // Electrobun checks the public manifest without using GitHub's REST API quota.
    const info = yield* Effect.tryPromise({
      catch: (cause) => new UpdateError({ cause, message: "Unable to verify" }),
      try: () => native.checkForUpdate(),
    });
    if (serviceClosed) {
      return serviceSnapshot();
    }
    serviceSnapshotState.checkedAt = yield* Clock.currentTimeMillis;
    if (info.error) {
      serviceSnapshotState.status = "error";
      serviceSnapshotState.error = info.error;
      return serviceSnapshot();
    }
    const currentVersion = info.version || options.version;
    const available =
      info.updateAvailable &&
      newer(yield* versionParts(currentVersion), yield* versionParts(options.version));
    const target = desktopTarget(options.platform, options.arch);
    Object.assign(serviceSnapshotState, {
      downloadName: available && target ? installerName(currentVersion, target) : null,
      latestVersion: currentVersion,
      releaseUrl: `https://github.com/${repository}/releases/tag/v${currentVersion}`,
      status: "current",
    });
    if (available) {
      serviceSnapshotState.status = info.updateReady ? "ready" : "available";
      if (serviceState.notifiedVersion !== currentVersion) {
        options.notify(currentVersion);
        serviceState.notifiedVersion = currentVersion;
        yield* servicePersist();
      }
    }
    return serviceSnapshot();
  }, Effect.scoped);

  const serviceReadLatest = Effect.fn("Updates.readLatest")(function* () {
    if (serviceClosed) {
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

    const { native } = options;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
    const githubCheck = Effect.gen(function* () {
      const requestScope = yield* Effect.acquireRelease(Scope.fork(httpScope), (ownedScope, exit) =>
        Scope.close(ownedScope, exit)
      );
      const response = yield* serviceGithub("/releases/latest", "application/vnd.github+json").pipe(
        Scope.provide(requestScope)
      );
      if (serviceClosed) {
        return serviceSnapshot();
      }
      serviceSnapshotState.checkedAt = yield* Clock.currentTimeMillis;
      if ([401, 403].includes(response.status)) {
        return yield* Effect.fail(
          new UpdateError({ message: `GitHub rejected the update check (HTTP ${response.status})` })
        );
      }
      if (response.status === 404) {
        serviceSnapshotState.status = "no-release";
        return serviceSnapshot();
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          new UpdateError({ message: `GitHub is unavailable (HTTP ${response.status})` })
        );
      }
      const body = yield* response.json;
      const latest = yield* decodeRelease(body).pipe(
        Effect.mapError((cause) => new UpdateError({ cause, message: "Invalid GitHub response" }))
      );
      const assets = yield* decodeReleaseAssets(latest.assets).pipe(
        Effect.mapError((cause) => new UpdateError({ cause, message: "Invalid installer list" }))
      );
      if (serviceClosed) {
        return serviceSnapshot();
      }
      if (latest.draft || latest.prerelease) {
        return yield* Effect.fail(new UpdateError({ message: "No stable release available" }));
      }
      const currentVersion = latest.tag_name.replace(versionPrefix, "");
      const candidate = yield* versionParts(currentVersion);
      const installed = yield* versionParts(options.version);
      serviceSnapshotState.latestVersion = currentVersion;
      serviceSnapshotState.releaseUrl = `https://github.com/${repository}/releases/tag/v${currentVersion}`;
      if (!newer(candidate, installed)) {
        serviceSnapshotState.status = "current";
        return serviceSnapshot();
      }
      serviceAsset = serviceCompatibleInstaller(assets, currentVersion);
      if (!serviceAsset) {
        return yield* Effect.fail(
          new UpdateError({ message: "No installer compatible with this machine in the release" })
        );
      }
      serviceSnapshotState.downloadName = serviceAsset.name;
      serviceSnapshotState.status = "available";
      if (serviceState.notifiedVersion !== currentVersion) {
        options.notify(currentVersion);
        serviceState.notifiedVersion = currentVersion;
        yield* servicePersist();
      }
      return serviceSnapshot();
    }).pipe(Effect.timeout("30 seconds"), Effect.scoped);
    const checked = yield* Effect.result(native ? serviceReadNativeLatest(native) : githubCheck);
    if (Result.isFailure(checked)) {
      const error = checked.failure;
      if (serviceClosed) {
        return serviceSnapshot();
      }
      serviceSnapshotState.status = "error";
      serviceSnapshotState.error = error.message;
    }
    return serviceSnapshot();
  });
  const servicePrepare = Effect.fn("Updates.prepare")(function* () {
    if (serviceClosed) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    const { native } = options;
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
            yield* Effect.tryPromise({
              catch: (cause) => new UpdateError({ cause, message: "Unable to prepare update" }),
              try: () => native.downloadUpdate(),
            });
            return native.updateInfo();
          })
        );
        if (serviceClosed) {
          return;
        }
        if (Result.isFailure(downloaded)) {
          const error = downloaded.failure;
          serviceSnapshotState.status = "available";
          serviceSnapshotState.error = error.message;
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
  const serviceInstall = Effect.fn("Updates.install")(function* () {
    if (serviceClosed) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    const { native, install: installUpdate } = options;
    if (
      !(native && installUpdate) ||
      servicePreparation ||
      serviceSnapshotState.status !== "ready"
    ) {
      return problem(409, { detail: "Download an update before restarting" });
    }
    serviceSnapshotState.status = "restarting";
    serviceSnapshotState.error = null;
    const install = Effect.gen(function* () {
      const installed = yield* Effect.result(
        Effect.tryPromise({
          catch: (cause) =>
            new UpdateError({
              cause,
              message: cause instanceof Error ? cause.message : "Unable to install update",
            }),
          try: () => installUpdate(),
        })
      );
      if (Result.isFailure(installed)) {
        const error = installed.failure;
        if (serviceClosed) {
          return;
        }
        const info = native.updateInfo();
        serviceSnapshotState.status = info.updateReady ? "ready" : "available";
        serviceSnapshotState.error = error.message;
      }
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) {
            return;
          }
          const log = createLogger({
            component: "updates",
            error: Cause.squash(cause),
            operation: "install",
          });
          log.setLevel("error");
          log.emit();
        })
      )
    );
    // Let the HTTP response and its synchronized state reach the WebView first.
    serviceRestart = yield* Effect.forkIn(
      Effect.gen(function* () {
        yield* Effect.sleep("250 millis");
        serviceRestart = null;
        if (serviceClosed) {
          return;
        }
        // Installation closes the host scope itself; it must not wait for its own fiber.
        yield* Effect.forkDetach(install);
      }),
      scope
    );
    return serviceSnapshot();
  });
  function serviceCompatibleInstaller(assets: readonly ReleaseAsset[], currentVersion: string) {
    const target = desktopTarget(options.platform, options.arch);
    if (!target) {
      return null;
    }
    const name = installerName(currentVersion, target);
    return assets.find((item) => item.name === name) ?? null;
  }
  const serviceDownload = Effect.fn("Updates.download")(function* () {
    if (serviceClosed) {
      return problem(409, { detail: "The update service is shutting down" });
    }
    if (!(serviceAsset && serviceSnapshotState.status === "available")) {
      return problem(409, { detail: "Check for updates before downloading the installer" });
    }
    const asset = serviceAsset;
    const requestScope = yield* Scope.fork(httpScope);
    let handedOff = false;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep ordered HTTP validation and stream ownership together.
    return yield* Effect.gen(function* () {
      let deadline = (yield* Clock.currentTimeMillis) + 30_000;
      const requested = yield* Effect.result(
        serviceGithub(`/releases/assets/${asset.id}`, "application/octet-stream").pipe(
          Scope.provide(requestScope)
        )
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
        const { location } = response.headers;
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
        deadline = (yield* Clock.currentTimeMillis) + 120_000;
        const downloaded = yield* Effect.result(
          http
            .get(target)
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
              Scope.provide(requestScope),
              Effect.timeout("2 minutes")
            )
        );
        if (Result.isFailure(downloaded)) {
          return problem(502, { detail: "The installer download could not be reached" });
        }
        response = downloaded.success;
      }
      if (response.status < 200 || response.status >= 300) {
        return problem(502, { detail: `Download unavailable (HTTP ${response.status})` });
      }
      const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
      const body = Stream.toReadableStream(
        response.stream.pipe(
          Stream.interruptWhen(
            Effect.sleep(remaining).pipe(Effect.andThen(Effect.fail(new Cause.TimeoutError())))
          ),
          Stream.ensuring(Scope.close(requestScope, Exit.void))
        )
      );
      const download = new Response(body, {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${asset.name}"`,
          "content-type": "application/octet-stream",
        },
      });
      handedOff = true;
      return download;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => (handedOff ? Effect.void : Scope.close(requestScope, Exit.void)))
      )
    );
  });
  servicePath = join(instance.dataDir, "release-access.json");
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
    ) => Effect.Effect<void, UpdateError>;
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
    readonly install: () => Effect.Effect<
      | UpdateState
      | ReturnType<typeof problem<409, { readonly detail: "The update service is shutting down" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Download an update before restarting" }>>
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
