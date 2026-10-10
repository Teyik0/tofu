import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveInstanceConfig } from "../src/api/instance";
import { desktopLauncher, hostDesktopTarget } from "../src/platform";
import type { DashboardState, DesktopState, InstanceConfig, ServerInfo } from "../src/types";
import { fixture, json, waitFor } from "../tests/helpers";
import { nativeRequest } from "./native-request";

const root = join(import.meta.dir, "..");
const context = await fixture(65_536, []);
const instances: ReturnType<typeof launch>[] = [];
const checks: string[] = [];
const servers = new Map<string, ServerInfo>();

function request(url: string, init?: RequestInit) {
  const server = servers.get(new URL(url).origin);
  if (!server) {
    throw new Error("The native instance is unavailable");
  }
  return nativeRequest(server, url, init);
}

function launch(config: InstanceConfig, bundleRoot: string) {
  const launcher = desktopLauncher(bundleRoot, hostDesktopTarget(), config.profile);
  const environment = {
    ...process.env,
    TOFU_DATA_DIR: config.dataDir,
    TOFU_DOWNLOAD_DIR: config.downloadPath,
    TOFU_MODE: "desktop",
    TOFU_PORT: "0",
    // A terminal variable must never change the identity of an installed bundle.
    TOFU_PROFILE: config.profile === "dev" ? "release" : "dev",
    TOFU_SMOKE_SCRIPT: undefined,
  };
  const child = Bun.spawn([launcher], {
    cwd: root,
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { child, config, output };
}

async function ready(instance: ReturnType<typeof launch>) {
  const result = await waitFor(
    async () => {
      if (instance.child.exitCode !== null) {
        throw new Error((await instance.output).join("\n"));
      }
      const file = Bun.file(join(instance.config.dataDir, "server.json"));
      if (!(await file.exists())) {
        return null;
      }
      const server = (await file.json()) as ServerInfo;
      const { url } = server;
      servers.set(url, server);
      const response = await request(`${url}/api/desktop`);
      if (!response.ok) {
        return null;
      }
      const desktop = (await response.json()) as DesktopState;
      return desktop.windows === 1 && desktop.webviews === 1 ? url : null;
    },
    (value) => value !== null
  );
  if (!result) {
    throw new Error("The native Tofu window did not start");
  }
  return result;
}

try {
  // Stable build launchers are installers. Run only the archive's flat app in a temporary tree.
  const target = hostDesktopTarget();
  const metadata: { artifact: { file: string } } = await Bun.file(
    join(root, `artifacts/stable-${target.platform}-${target.arch}-update.json`)
  ).json();
  const releaseRoot = join(context.directory, "native-bundles");
  const compressed = await Bun.file(join(root, "artifacts", metadata.artifact.file)).arrayBuffer();
  const archive = new Bun.Archive(await Bun.zstdDecompress(compressed));
  await archive.extract(join(releaseRoot, `build/stable-${target.platform}-${target.arch}`));
  const options = {
    dataDir: undefined,
    desktop: true,
    downloadPath: undefined,
    homeDir: context.directory,
    platform: process.platform,
    port: "0",
  };
  const dev = launch(resolveInstanceConfig({ ...options, profile: "dev" }), root);
  instances.push(dev);
  const release = launch(resolveInstanceConfig({ ...options, profile: "release" }), releaseRoot);
  instances.push(release);
  const [devUrl, releaseUrl] = await Promise.all([ready(dev), ready(release)]);
  const [devInfo, releaseInfo] = await Promise.all(
    [devUrl, releaseUrl].map(
      async (url) => (await (await request(`${url}/api/instance`)).json()) as InstanceConfig
    )
  );
  if (
    devInfo?.profile !== "dev" ||
    releaseInfo?.profile !== "release" ||
    devInfo.identifier === releaseInfo.identifier ||
    devUrl === releaseUrl
  ) {
    throw new Error("Native bundles do not have distinct profiles, identities, and ports");
  }
  checks.push(
    "Two real native bundles open together, using bundle profiles despite conflicting environment variables"
  );
  const read = async (url: string) =>
    (await (await request(`${url}/api/state`)).json()) as DashboardState;
  const before = await read(devUrl);
  await request(`${devUrl}/api/settings`, {
    ...json({ ...before.settings, runInBackground: true }),
    method: "PUT",
  });
  const added = await request(
    `${devUrl}/api/torrents`,
    json({ paused: false, source: context.magnet })
  );
  if (!added.ok) {
    throw new Error(await added.text());
  }
  const { id } = (await added.json()) as { id: string };
  await waitFor(
    () => read(devUrl),
    (state) => state.torrents[0]?.status === "seeding"
  );
  const bytes = await (await request(`${devUrl}/api/torrents/${id}/files/0/content`)).arrayBuffer();
  const stable = await read(releaseUrl);
  if (
    Bun.SHA256.hash(bytes, "hex") !== Bun.SHA256.hash(context.bytes, "hex") ||
    stable.torrents.length !== 0 ||
    stable.settings.runInBackground
  ) {
    throw new Error("Real downloads or preferences are mixed between profiles");
  }
  checks.push("Real transfer with exact SHA-256 and isolated preferences, release intact");
  dev.child.kill("SIGTERM");
  await dev.child.exited;
  if (!(await request(`${releaseUrl}/api/health`)).ok) {
    throw new Error("Quitting development affects release");
  }
  checks.push("Quitting the development bundle leaves release available");
  await mkdir(join(root, ".cache"), { recursive: true });
  await Bun.write(
    join(root, ".cache/native-coexist-smoke.json"),
    JSON.stringify({ checks, passed: true }, null, 2)
  );
  console.log(checks.join("\n"));
} catch (error) {
  await mkdir(join(root, ".cache"), { recursive: true });
  await Bun.write(
    join(root, ".cache/native-coexist-smoke.json"),
    JSON.stringify({ checks, error: String(error), passed: false }, null, 2)
  );
  throw error;
} finally {
  await Promise.all(
    instances.map(async ({ child }) => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await child.exited;
    })
  );
  await Bun.write(
    join(root, ".cache/native-coexist-smoke.log"),
    (await Promise.all(instances.map(({ output }) => output))).flat().join("\n")
  );
  await context.close();
}
