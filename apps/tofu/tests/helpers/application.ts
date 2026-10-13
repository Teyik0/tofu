import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { furinSync } from "@teyik0/furin/sync";
import { AniListService } from "@tofu/anilist/server/service";
import { version } from "../../package.json";
import { resolveInstanceConfig } from "../../src/api/lib/instance";
import { pluginEndpoints } from "../../src/api/modules/plugins/service";
import { TorrentEngine } from "../../src/api/modules/torrents/service";
import { UpdatesService } from "../../src/api/modules/updates/service";
import type { AniListClient, ApplicationPlatform, EnginePort } from "../../src/types";
import { openTestDatabase, type TestSyncOptions } from "./database";
import { serviceApplications } from "./service-registry";
import { openTestServices } from "./services";

const serviceReplacements = [
  [/[\\/]api[\\/]lib[\\/]runtime\.ts$/, "resources, runtime"],
  [/[\\/]api[\\/]lib[\\/]database-plugin\.ts$/, "db, instance, databasePlugin"],
  [/[\\/]api[\\/]modules[\\/]torrents[\\/]plugin\.ts$/, "engine, torrentServicePlugin"],
  [/[\\/]api[\\/]modules[\\/]plugins[\\/]plugin\.ts$/, "plugins, pluginRegistryPlugin"],
  [/[\\/]api[\\/]modules[\\/]jev[\\/]plugin\.ts$/, "jev, jevServicePlugin"],
  [/[\\/]api[\\/]modules[\\/]automation[\\/]index\.ts$/, "automation, automationPlugin"],
  [/[\\/]api[\\/]modules[\\/]discovery[\\/]plugin\.ts$/, "discovery, discoveryServicePlugin"],
  [
    /[\\/]api[\\/]modules[\\/]automation[\\/]plugin\.ts$/,
    "releaseAutomation, releaseAutomationPlugin",
  ],
  [/[\\/]api[\\/]modules[\\/]anilist[\\/]plugin\.ts$/, "anilist, anilistServicePlugin"],
  [/[\\/]api[\\/]modules[\\/]updates[\\/]plugin\.ts$/, "updates, updatesServicePlugin"],
] as const;
const serviceRegistryPattern = /(?:^|[\\/])service-registry(?:\.ts)?$/;
const packagePattern = /^(?:@[^/]+\/[^/]+|[a-zA-Z][^:]*)(?:\/.*)?$/;
const serviceModulePattern = /(?:^|[\\/])(?:worker-client|service)(?:\.ts)?$/;

interface OpeningServices {
  isDesktop: () => boolean;
  openExternal: (url: string) => boolean;
}
export async function createTestApplication(
  engine: EnginePort,
  options: TestSyncOptions,
  services?: Awaited<ReturnType<typeof openTestServices>>,
  updates?: UpdatesService,
  anilistClient?: AniListClient
) {
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
    services ??
    (await openTestServices(
      {
        dataDir: options.directory,
        endpoints: pluginEndpoints,
        engine: () => engine,
        now: Date.now,
      },
      options.db
    ));
  resources.defer(() => feeds.close());
  const anilist = new AniListService(feeds.db, {
    automation: feeds.automation,
    client: anilistClient,
    discovery: feeds.discovery,
    endpoint: feeds.options.endpoints.anilist ?? "https://graphql.anilist.co",
    engine,
    jev: feeds.jev,
    now: feeds.options.now,
    plugins: feeds.plugins,
    releaseAutomation: feeds.releaseAutomation,
    tokenEndpoint: feeds.options.endpoints.anilistToken ?? "https://anilist.co/api/v2/oauth/token",
  });
  resources.defer(async () => {
    feeds.plugins.close();
    await anilist.close();
  });
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
  const application = {
    anilist,
    automation: feeds.automation,
    close: () => resources.disposeAsync(),
    db: feeds.db,
    discovery: feeds.discovery,
    engine,
    instance,
    jev: feeds.jev,
    plugins: feeds.plugins,
    releaseAutomation: feeds.releaseAutomation,
    resources,
    updates: updater,
  };
  options.resources.defer(() => application.close());
  return application;
}
export async function mountTestApplication(
  application: Awaited<ReturnType<typeof createTestApplication>>,
  platform: ApplicationPlatform
) {
  const id = crypto.randomUUID();
  const serviceModule = join(import.meta.dir, "application-services.ts");
  const graph = await Bun.build({
    define: { TOFU_TEST_APPLICATION_ID: JSON.stringify(id) },
    entrypoints: [join(import.meta.dir, "application-routes.ts")],

    plugins: [
      {
        name: "provided-integration-services",
        setup(builder) {
          for (const [filter, names] of serviceReplacements) {
            builder.onLoad({ filter }, () => ({
              contents: `export { ${names} } from ${JSON.stringify(serviceModule)};`,
              loader: "ts",
            }));
          }
          builder.onResolve({ filter: serviceRegistryPattern }, () => ({
            external: true,
            path: join(import.meta.dir, "service-registry.ts"),
          }));
          builder.onResolve({ filter: packagePattern }, ({ path, importer }) => ({
            external: true,
            path: Bun.resolveSync(path, dirname(importer)),
          }));
          builder.onResolve({ filter: serviceModulePattern }, ({ path, importer }) => ({
            external: true,
            path: Bun.resolveSync(path, dirname(importer)),
          }));
        },
      },
    ],
    target: "bun",
  });
  if (!(graph.success && graph.outputs[0])) {
    throw new AggregateError(graph.logs, "Unable to prepare an isolated application module");
  }
  const bundlePath = join(application.instance.dataDir, `api-${crypto.randomUUID()}.mjs`);
  await Bun.write(bundlePath, graph.outputs[0]);
  serviceApplications.set(id, { application, platform });
  let loaded: typeof import("./application-routes");
  try {
    loaded = await import(bundlePath);
  } finally {
    serviceApplications.delete(id);
  }
  const { fixtureRoutes, fixtureSync: sync } = loaded;
  const api = fixtureRoutes
    .wrap((next) => (request, ...rest: unknown[]) => {
      if (
        !(
          ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
          request.headers.has("idempotency-key")
        )
      ) {
        request.headers.set("idempotency-key", crypto.randomUUID());
      }
      return next(request, ...rest);
    })
    .use(furinSync(sync));
  return Object.assign(api, { application: { ...application, platform, sync } });
}
export async function createTestApi(
  engine: () => EnginePort,
  options: TestSyncOptions,
  services?: () => Awaited<ReturnType<typeof openTestServices>>,
  anilistClient?: AniListClient
) {
  const core = await createTestApplication(
    engine(),
    options,
    services?.(),
    undefined,
    anilistClient
  );
  return mountTestApplication(core, { kind: "server" });
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
  const snapshot = () => ({
    background: true,
    phase: "ready" as const,
    trayVisible: false,
    webviews: 0,
    windows: 0,
  });
  const updateInfo = () => ({
    error: "",
    hash: "",
    updateAvailable: false,
    updateReady: false,
    version: "",
  });
  const platform: ApplicationPlatform = opening.isDesktop()
    ? {
        desktop: {
          associations: {
            read: async () => ({ status: "unsupported" }),
            requestDefault: async () => ({ status: "unsupported" }),
          },
          browser: { open: () => false },
          dialogs: { message: async () => ({ response: 0 }), selectDirectory: async () => null },
          notifications: { show: () => undefined },
          quit: async () => undefined,
          restart: async () => undefined,
          shell: {
            openExternal: opening.openExternal,
            openPath: () => false,
            showItemInFolder: () => undefined,
          },
          snapshot,
          updates: {
            check: async () => updateInfo(),
            download: async () => undefined,
            install: async () => undefined,
            snapshot: updateInfo,
            subscribe: () => () => undefined,
          },
          window: { background: async () => undefined, open: snapshot },
        },
        identity: {
          channel: "dev",
          identifier: "app.tofu.torrents.dev",
          name: "Tofu Dev",
          version,
        },
        kind: "desktop",
      }
    : { kind: "server" };
  return mountTestApplication(core, platform);
}
