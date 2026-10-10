import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { furinSync } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { Elysia } from "elysia";
import { version } from "../package.json";
import { apiPlugin } from "../src/api";
import { ApplicationHost } from "../src/api/lib/application-host";
import { applicationScope } from "../src/api/lib/host";
import { resolveInstanceConfig } from "../src/api/lib/instance";
import { apiTransportPlugin } from "../src/api/lib/transport";
import { AutomationService } from "../src/api/modules/automation/service";
import type { DesktopController } from "../src/api/modules/desktop/service";
import { pluginEndpoints } from "../src/api/modules/plugins/service";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import { UpdatesService } from "../src/api/modules/updates/service";
import { sync } from "../src/sync";
import type {
  ApplicationPlatform,
  CoreApplication,
  EnginePort,
  InstanceConfig,
} from "../src/types";
import { openTestDatabase, type TestSyncOptions } from "./database";

interface DesktopServices {
  desktop: () => DesktopController;
  instance?: () => InstanceConfig;
  nativeSdk?: () => typeof import("electrobun/main");
  updates: () => UpdatesService;
}
interface OpeningServices {
  isDesktop: () => boolean;
  openExternal: (url: string) => Promise<boolean>;
}

export async function createTestApplication(
  engine: EnginePort,
  options: TestSyncOptions,
  automation?: AutomationService,
  updates?: UpdatesService
): Promise<CoreApplication> {
  const resources = new AsyncDisposableStack();
  const instance = {
    ...resolveInstanceConfig({
      dataDir: options.directory,
      desktop: engine.mode === "desktop",
      downloadPath: engine.settings.downloadPath,
      homeDir: options.directory,
      platform: process.platform,
      port: "0",
      profile: "dev",
    }),
    desktop: engine.mode === "desktop",
  };
  const feeds =
    automation ??
    (await AutomationService.open(
      {
        dataDir: options.directory,
        endpoints: pluginEndpoints,
        engine: () => engine,
        now: Date.now,
      },
      options.db
    ));
  if (!automation) {
    resources.defer(() => feeds.close());
  }
  const updater =
    updates ??
    (await UpdatesService.open({
      apiOrigin: "https://api.github.com",
      arch: process.arch,
      dataDir: options.directory,
      notify: () => undefined,
      platform: process.platform,
      version,
    }));
  if (!updates) {
    resources.defer(() => updater.close());
  }
  const application: CoreApplication = {
    automation: feeds,
    close: () => resources.disposeAsync(),
    db: feeds.db,
    engine,
    instance,
    startBackground: () => undefined,
    sync: {
      adapter: drizzleSyncAdapter({ db: feeds.db, namespace: "tofu" }),
      principal: () => "local",
    },
    updates: updater,
  };
  options.resources.defer(() => application.close());
  return application;
}

export async function mountTestApplication(core: CoreApplication, platform: ApplicationPlatform) {
  const host = new ApplicationHost();
  await host.prepare(() => Promise.resolve(core), new AbortController().signal);
  host.activate(core, platform);
  const application = await host.application;
  // This is transport configuration. Shared plugins read the parent's host and adapter.
  return new Elysia()
    .use(apiTransportPlugin)
    .wrap((next) => (request, ...rest: unknown[]) => {
      if (
        !(
          ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
          request.headers.has("idempotency-key")
        )
      ) {
        request.headers.set("idempotency-key", crypto.randomUUID());
      }
      return applicationScope.run(application, () => next(request, ...rest));
    })
    .use(apiTransportPlugin)
    .use(furinSync(sync))
    .use(apiPlugin)
    .state((store) => ({ ...store, applicationHost: host }));
}

export async function createTestApi(
  engine: () => EnginePort,
  options: TestSyncOptions,
  automation?: () => AutomationService,
  desktop?: DesktopServices
) {
  const core = await createTestApplication(engine(), options, automation?.(), desktop?.updates());
  const sdk = desktop?.nativeSdk?.();
  const platform: ApplicationPlatform =
    desktop && sdk
      ? { controller: desktop.desktop(), kind: "desktop", utils: sdk.Utils }
      : { kind: "server" };
  return mountTestApplication(
    desktop?.instance
      ? { ...core, instance: { ...desktop.instance(), desktop: platform.kind === "desktop" } }
      : core,
    platform
  );
}

export async function createTestUpdatesApi(
  service: () => UpdatesService,
  options: TestSyncOptions
) {
  const engine = await TorrentEngine.open({
    dataDir: options.directory,
    downloadPath: join(options.directory, "downloads"),
    network: { dht: false, lsd: false, natPmp: false, natUpnp: false, tracker: false, utp: false },
  });
  options.resources.defer(() => engine.close());
  const core = await createTestApplication(engine, options, undefined, service());
  return mountTestApplication(core, { kind: "server" });
}

const openingResources = new Set<AsyncDisposableStack>();
export async function closeTestOpeningApplications() {
  await Promise.all([...openingResources].map((resources) => resources.disposeAsync()));
  openingResources.clear();
}

export async function createTestAniListOpeningApi(opening: OpeningServices) {
  const resources = new AsyncDisposableStack();
  openingResources.add(resources);
  const directory = await mkdtemp(join(tmpdir(), "tofu-opening-"));
  resources.defer(() => rm(directory, { force: true, recursive: true }));
  const engine = await TorrentEngine.open({
    dataDir: directory,
    downloadPath: join(directory, "downloads"),
    network: { dht: false, lsd: false, natPmp: false, natUpnp: false, tracker: false, utp: false },
  });
  resources.defer(() => engine.close());
  engine.mode = opening.isDesktop() ? "desktop" : "server";
  const options = await openTestDatabase(directory);
  resources.defer(() => options.close());
  const core = await createTestApplication(engine, options.options);
  const snapshot = () => ({ background: true, trayVisible: false, webviews: 0, windows: 0 });
  const platform: ApplicationPlatform = opening.isDesktop()
    ? {
        controller: {
          background: () => ({ ok: true }),
          installUpdate: () => Promise.resolve(),
          open: snapshot,
          openDownload: () => ({ opened: false }),
          snapshot,
        },
        kind: "desktop",
        utils: {
          openExternal: opening.openExternal,
          openFileDialog: () => Promise.resolve([]),
          openPath: () => false,
        },
      }
    : { kind: "server" };
  return mountTestApplication(core, platform);
}
