// biome-ignore-all lint/style/noNonNullAssertion: missing DOM targets must fail this end-to-end test immediately.
// biome-ignore-all lint/performance/noAwaitInLoops: wait for real native UI and network events.
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { Server as Tracker } from "bittorrent-tracker";
import { fromCrossJSON, toCrossJSONAsync } from "seroval";
import WebTorrent, { type Torrent } from "webtorrent";
import { openDatabase } from "../src/api/lib/db";
import { acquireInstance, resolveInstanceConfig } from "../src/api/lib/instance";
import { AniListService } from "../src/api/modules/anilist/service";
import { ReleaseAutomationService } from "../src/api/modules/automation/integration";
import { AutomationService } from "../src/api/modules/automation/service";
import { DiscoveryService } from "../src/api/modules/discovery/service";
import { JevService } from "../src/api/modules/jev/service";
import { PluginsService, pluginEndpoints } from "../src/api/modules/plugins/service";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import { desktopLauncher, hostDesktopTarget } from "../src/platform";
import type { InstanceProfile } from "../src/types";

interface AniListLoaderFixture {
  __furinQueries?: { url: string; data: unknown; local?: boolean; identity?: unknown }[];
  initialAniList: import("../src/types").AniListState;
}

const root = join(import.meta.dir, "..");
const desktopTarget = hostDesktopTarget();
const nativeProfile: InstanceProfile =
  process.env.TOFU_NATIVE_PROFILE === "release" ? "release" : "dev";
const launcher =
  process.env.TOFU_NATIVE_LAUNCHER ?? desktopLauncher(root, desktopTarget, nativeProfile);
const bundle =
  desktopTarget.platform === "macos"
    ? dirname(dirname(dirname(launcher)))
    : dirname(dirname(launcher));
if (
  process.env.TOFU_NATIVE_LAUNCHER &&
  desktopTarget.platform === "macos" &&
  !(await Bun.file(join(bundle, "Contents/Resources/app/bun/index.js")).exists())
) {
  throw new Error(
    "Native tests require an extracted application bundle, not a self-extracting installer."
  );
}
const workflowBundle = await Bun.build({
  entrypoints: [join(root, "scripts/native-browser-entry.ts")],
  format: "iife",
  target: "browser",
});
if (!(workflowBundle.success && workflowBundle.outputs[0])) {
  throw new Error(`Unable to bundle native workflow: ${workflowBundle.logs.join("\n")}`);
}
const folder = await mkdtemp(join(tmpdir(), "tofu-native-"));
const isolatedBundle = join(folder, basename(bundle));
// Installed bundles must not resolve missing dependencies from the repository.
try {
  if (nativeProfile === "release" && !process.env.TOFU_NATIVE_LAUNCHER) {
    const archive = join(
      root,
      ".furin/electrobun/artifacts",
      `stable-${desktopTarget.platform}-${desktopTarget.arch}-Tofu${desktopTarget.platform === "macos" ? ".app" : ""}.tar.zst`
    );
    const tarPath = join(folder, "application.tar");
    await Bun.write(tarPath, Bun.zstdDecompressSync(await Bun.file(archive).bytes()));
    const extraction = Bun.spawn(["tar", "-xf", tarPath, "-C", folder], {
      stderr: "pipe",
      stdout: "ignore",
    });
    const error = await new Response(extraction.stderr).text();
    if ((await extraction.exited) !== 0) {
      throw new Error(`Unable to extract the release application: ${error}`);
    }
    await rm(tarPath);
  } else {
    await cp(bundle, isolatedBundle, { dereference: true, recursive: true });
  }
} catch (error) {
  await rm(folder, { force: true, recursive: true });
  throw error;
}
if (["anilist", "anilist-catalog"].includes(process.env.TOFU_NATIVE_WORKFLOW ?? "")) {
  try {
    await seedAniListCatalog(folder);
  } catch (error) {
    await rm(folder, { force: true, recursive: true });
    throw error;
  }
}
const source = join(folder, "Real Tofu test.bin");
const payload = randomBytes(256 * 1024);
await Bun.write(source, payload);
const trackers = [
  new Tracker({ http: true, stats: false, udp: false, ws: false }),
  new Tracker({ http: true, stats: false, udp: false, ws: false }),
];
for (const tracker of trackers) {
  await new Promise<void>((resolve) => tracker.listen(0, "127.0.0.1", resolve));
}
const urls = trackers.map((tracker) => {
  const address = tracker.http.address();
  if (!address || typeof address === "string") {
    throw new Error("Tracker not started");
  }
  return `http://127.0.0.1:${address.port}/announce`;
});
const seedClient = new WebTorrent({
  dht: false,
  lsd: false,
  natPmp: false,
  natUpnp: false,
  utp: false,
});
const seed = await new Promise<Torrent>((resolve) =>
  seedClient.seed(source, { announce: urls }, resolve)
);
const secondarySource = join(folder, "Second torrent Tofu.bin");
await Bun.write(secondarySource, payload);
const secondarySeed = await new Promise<Torrent>((resolve) =>
  seedClient.seed(secondarySource, { announce: [] }, resolve)
);
const magnet = `${seed.magnetURI}&x.pe=${encodeURIComponent(`127.0.0.1:${seedClient.torrentPort}`)}`;
let resolveReport: (value: string) => void = () => undefined;
const reportPromise = new Promise<string>((resolve) => {
  resolveReport = resolve;
});
const collector = Bun.serve({
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-origin": "*",
        },
      });
    }
    if (new URL(request.url).pathname === "/anilist-loader") {
      const fixture = (await request.json()) as {
        payload:
          | Awaited<ReturnType<typeof toCrossJSONAsync>>
          | ["__furin_json_v1__", AniListLoaderFixture];
        anilist: import("../src/types").AniListState;
      };
      const data = Array.isArray(fixture.payload)
        ? fixture.payload[1]
        : fromCrossJSON<AniListLoaderFixture>(fixture.payload, {});
      data.initialAniList = fixture.anilist;
      // Furin's query bindings must use the same fixture as the rendered loader snapshot.
      for (const query of data.__furinQueries ?? []) {
        if (new URL(query.url).pathname === "/api/anilist") {
          query.data = fixture.anilist;
          query.local = false;
          query.identity = undefined;
        }
      }
      return Response.json(
        Array.isArray(fixture.payload) ? ["__furin_json_v1__", data] : await toCrossJSONAsync(data),
        {
          headers: { "access-control-allow-origin": "*" },
        }
      );
    }
    if (new URL(request.url).pathname === "/search-feed") {
      const searchMagnet = `${secondarySeed.magnetURI}&x.pe=127.0.0.1:${seedClient.torrentPort}`;
      return new Response(
        `<rss><channel><item><guid>native-search-release</guid><title>Second torrent Tofu.bin</title><link>${searchMagnet.replaceAll("&", "&amp;")}</link><nyaa:infoHash>${secondarySeed.infoHash}</nyaa:infoHash></item></channel></rss>`
      );
    }
    const body = await request.text();
    if (new URL(request.url).pathname === "/progress") {
      console.log(body);
    } else if (new URL(request.url).pathname === "/" && request.method === "POST") {
      const report: { passed?: boolean } = JSON.parse(body);
      if (typeof report.passed !== "boolean") {
        return new Response("Invalid native report", { status: 400 });
      }
      resolveReport(body);
    }
    return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
  },
  hostname: "127.0.0.1",
  port: 0,
});
const searchReleases =
  process.env.TOFU_NATIVE_WORKFLOW === "global-search"
    ? await seedSearchReleases(
        folder,
        `http://127.0.0.1:${collector.port}/search-feed`,
        nativeProfile
      )
    : [];
const workflowName = process.env.TOFU_NATIVE_WORKFLOW ?? "main";
const reportName = workflowName === "main" ? "native-smoke" : `native-${workflowName}-smoke`;
const browserConfig = {
  expectedHash: createHash("sha256").update(payload).digest("hex"),
  magnet,
  reportUrl: `http://127.0.0.1:${collector.port}`,
  searchReleases,
  secondaryTorrentBytes: Array.from(secondarySeed.torrentFile),
  torrentBytes: Array.from(seed.torrentFile),
  urls,
};
const browserScript = `globalThis.tofuNativeWorkflow = ${JSON.stringify({ config: browserConfig, name: workflowName })};\n${await workflowBundle.outputs[0].text()}`;
const scriptPath = join(folder, "workflow.js");
await Bun.write(scriptPath, browserScript);
const native = Bun.spawn([join(isolatedBundle, relative(bundle, launcher))], {
  cwd: folder,
  env: {
    ...process.env,
    FURIN_NATIVE_TEST_SCRIPT: scriptPath,
    TOFU_DATA_DIR: join(folder, "state"),
    TOFU_DOWNLOAD_DIR: join(folder, "downloads"),
    TOFU_MODE: "desktop",
    TOFU_PROFILE: nativeProfile,
  },
  stderr: "pipe",
  stdout: "pipe",
});
const nativeStdout = new Response(native.stdout).text();
const nativeStderr = new Response(native.stderr).text();
void native.exited.then(async (code) => {
  resolveReport(
    JSON.stringify({
      error: `The native host exited with code ${code}: ${await nativeStderr}`,
      passed: false,
    })
  );
});
const timeout = setTimeout(
  () =>
    resolveReport(
      JSON.stringify({
        error: "The WebView did not complete the flow within 90 seconds",
        passed: false,
      })
    ),
  90_000
);
try {
  const report = await reportPromise;
  clearTimeout(timeout);
  await mkdir(join(root, ".cache"), { recursive: true });
  await Bun.write(join(root, `.cache/${reportName}.json`), report);
  console.log(report);
  const result = JSON.parse(report) as { passed: boolean };
  process.exitCode = result.passed ? 0 : 1;
} finally {
  native.kill("SIGTERM");
  await native.exited;
  await Bun.write(
    join(root, `.cache/${reportName}.log`),
    `${await nativeStdout}\n${await nativeStderr}`
  );
  collector.stop(true);
  await new Promise<void>((resolve) => seedClient.destroy(() => resolve()));
  for (const tracker of trackers) {
    await new Promise<void>((resolve) => tracker.close(resolve));
  }
  await rm(folder, { force: true, recursive: true });
}

async function seedAniListCatalog(directory: string) {
  const resources = new AsyncDisposableStack();
  const nativeFetch = globalThis.fetch;
  try {
    const lease = await acquireInstance(
      resolveInstanceConfig({
        dataDir: join(directory, "state"),
        desktop: true,
        downloadPath: join(directory, "downloads"),
        homeDir: directory,
        platform: process.platform,
        port: "0",
        profile: nativeProfile,
      })
    );
    resources.defer(() => lease.close());
    const engine = await TorrentEngine.open({
      dataDir: join(directory, "state"),
      downloadPath: join(directory, "downloads"),
      network: {
        dht: false,
        lsd: false,
        natPmp: false,
        natUpnp: false,
        tracker: false,
        utp: false,
      },
    });
    resources.defer(() => engine.close());
    const db = await openDatabase(join(directory, "state"));
    resources.defer(() => db.$client.close(true));
    const plugins = new PluginsService(db, { endpoints: pluginEndpoints, now: Date.now });
    resources.defer(() => plugins.close());
    const jev = new JevService(db, { endpoint: pluginEndpoints.jev, now: Date.now, plugins });
    resources.defer(async () => {
      plugins.close();
      await jev.close();
    });
    const discovery = new DiscoveryService(db, {
      endpoints: pluginEndpoints,
      engine,
      jev,
      plugins,
    });
    resources.defer(() => discovery.close());
    const automation = new AutomationService(db, { jev, now: Date.now });
    const releaseAutomation = new ReleaseAutomationService({
      automation,
      discovery,
      engine,
      now: Date.now,
      plugins,
    });
    resources.defer(() => releaseAutomation.close());
    // Retain the packaged provider's cache identity while seeding through its public service.
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== "https://graphql.anilist.co") {
        return nativeFetch(input, init);
      }
      const body = (await request.json()) as { query: string };
      return Response.json({
        data: body.query.includes("Viewer")
          ? { Viewer: { id: 42, name: "NativeUser" } }
          : {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [
                  {
                    entries: [
                      {
                        media: {
                          episodes: process.env.TOFU_NATIVE_WORKFLOW === "anilist" ? 3 : 12,
                          genres:
                            process.env.TOFU_NATIVE_WORKFLOW === "anilist"
                              ? ["Action", "Comedy"]
                              : ["Drama"],
                          id: 10,
                          status: "RELEASING",
                          studios: { nodes: [{ name: "Native Studio" }] },
                          synonyms: [],
                          title: {
                            romaji:
                              process.env.TOFU_NATIVE_WORKFLOW === "anilist"
                                ? "Native Example"
                                : "Native Library",
                          },
                        },
                        progress: process.env.TOFU_NATIVE_WORKFLOW === "anilist" ? 0 : 3,
                        status: "CURRENT",
                      },
                    ],
                  },
                ],
              },
            },
      });
    }, nativeFetch);
    plugins.configure("anilist", { apiKey: "native-catalog-token", enabled: true });
    const anilist = new AniListService(db, {
      automation,
      discovery,
      endpoint: "https://graphql.anilist.co",
      engine,
      jev,
      now: Date.now,
      plugins,
      releaseAutomation,
      tokenEndpoint: "https://anilist.co/api/v2/oauth/token",
    });
    resources.defer(() => anilist.close());
    await anilist.list();
  } finally {
    globalThis.fetch = nativeFetch;
    await resources.disposeAsync();
  }
}

async function seedSearchReleases(directory: string, sourceUrl: string, profile: InstanceProfile) {
  await using resources = new AsyncDisposableStack();
  const lease = await acquireInstance(
    resolveInstanceConfig({
      dataDir: join(directory, "state"),
      desktop: true,
      downloadPath: join(directory, "downloads"),
      homeDir: directory,
      platform: process.platform,
      port: "0",
      profile,
    })
  );
  resources.defer(() => lease.close());
  const engine = await TorrentEngine.open({
    dataDir: join(directory, "state"),
    downloadPath: join(directory, "downloads"),
    network: { dht: false, lsd: false, natPmp: false, natUpnp: false, tracker: false, utp: false },
  });
  resources.defer(() => engine.close());
  const db = await openDatabase(join(directory, "state"));
  resources.defer(() => db.$client.close(true));
  const endpoints = { ...pluginEndpoints, nyaa: sourceUrl };
  const plugins = new PluginsService(db, { endpoints, now: Date.now });
  resources.defer(() => plugins.close());
  const jev = new JevService(db, { endpoint: endpoints.jev, now: Date.now, plugins });
  resources.defer(async () => {
    plugins.close();
    await jev.close();
  });
  const discovery = new DiscoveryService(db, { endpoints, engine, jev, plugins });
  resources.defer(() => discovery.close());
  plugins.configure("nyaa", { enabled: true });
  plugins.configure("tsundere", { enabled: true });
  return (await discovery.discover("Second", ["nyaa"])).releases;
}
