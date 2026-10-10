import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cp, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqliteSync, sqliteSyncAdapter } from "@teyik0/furin/sync/sqlite";
import type { DashboardState, Destination } from "@tofu/plugins/domain";
import { createCore, createPluginRuntime } from "@tofu/plugins/server";
import {
  generatePlugins,
  installPlugin,
  listInstalledPlugins,
  materializePluginRuntime,
  uninstallPlugin,
} from "../scripts/plugin-packages";

test("local plugin installation requires explicit trust before any module can run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-install-"));
  try {
    const source = join(directory, "package");
    const marker = join(directory, "executed.txt");
    await Bun.write(
      join(source, "package.json"),
      JSON.stringify({
        name: "example-plugin",
        tofuPlugin: {
          apiVersion: "0.0.0",
          client: "./client.js",
          id: "example",
          server: "./server.js",
        },
        type: "module",
        version: "0.0.0",
      })
    );
    await Bun.write(
      join(source, "server.js"),
      `await Bun.write(${JSON.stringify(marker)}, "executed");`
    );
    await Bun.write(
      join(source, "client.js"),
      `await Bun.write(${JSON.stringify(marker)}, "executed"); export const ui = {};`
    );
    await expect(
      installPlugin({
        hostDirectory: join(directory, "host"),
        replace: false,
        sourceDirectory: source,
        trust: false,
      })
    ).rejects.toThrow("--trust");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

async function createPackage(source: string, pagePath: string, greeting: string): Promise<void> {
  await Bun.write(
    join(source, "package.json"),
    JSON.stringify({
      name: "example-plugin",
      scripts: { postinstall: "bun -e 'throw new Error(\"Scripts must not run\")'" },
      tofuPlugin: {
        apiVersion: "0.0.0",
        client: "./client.js",
        id: "example",
        server: "./server.js",
      },
      type: "module",
      version: "0.0.0",
    })
  );
  await Bun.write(
    join(source, "server.js"),
    `export function createPlugin(core) { return { id: "example", name: "Example", version: "0.0.0", api: core }; }`
  );
  await Bun.write(
    join(source, "client.js"),
    `export const ui = { pages: [{ id: "greeting", title: ${JSON.stringify(greeting)}, path: ${JSON.stringify(pagePath)}, pinnable: true, route: ({threadLayout}) => threadLayout }] };`
  );
}

test("trusted packages are pinned and compiled into managed native route and separate registry imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-installed-"));
  const source = join(directory, "package");
  const host = join(directory, "host");
  try {
    await createPackage(source, "greeting", "Original greeting");
    await installPlugin({
      hostDirectory: host,
      replace: false,
      sourceDirectory: source,
      trust: true,
    });
    const installed = await listInstalledPlugins(host);
    expect(installed).toHaveLength(1);
    expect(installed[0]?.id).toBe("example");
    expect(installed[0]?.integrity).toStartWith("sha256-");
    await Bun.write(
      join(source, "client.js"),
      "throw new Error('Original sources are no longer executed');"
    );
    await generatePlugins(host);
    const page = await Bun.file(
      join(host, "src/pages/(app)/(extensions)/extensions/example/greeting.tsx")
    ).text();
    expect(page).toContain("threadLayout");
    const client = await Bun.file(join(host, "src/plugin-generated/client.ts")).text();
    expect(client).toContain("/extensions/example/greeting");
    expect(client).not.toContain("server.js");
    const data = join(host, ".tofu-plugin-data/example/settings.json");
    await Bun.write(data, "preserved settings");
    await uninstallPlugin({ hostDirectory: host, id: "example" });
    expect(await listInstalledPlugins(host)).toEqual([]);
    expect(await Bun.file(data).text()).toBe("preserved settings");
    expect(
      await Bun.file(
        join(host, "src/pages/(app)/(extensions)/extensions/example/greeting.tsx")
      ).exists()
    ).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("changed installed package files are rejected before their client code executes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-integrity-"));
  const source = join(directory, "package");
  const host = join(directory, "host");
  const marker = join(directory, "executed.txt");
  try {
    await createPackage(source, "greeting", "Greeting");
    await installPlugin({
      hostDirectory: host,
      replace: false,
      sourceDirectory: source,
      trust: true,
    });
    const [installed] = await listInstalledPlugins(host);
    if (!installed) {
      throw new Error("Missing installed fixture");
    }
    await Bun.write(
      join(host, installed.path, "client.js"),
      `await Bun.write(${JSON.stringify(marker)}, "executed"); export const ui = {};`
    );
    await expect(generatePlugins(host)).rejects.toThrow("integrity");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

const thread: Destination = {
  downloadPath: "/temporary/downloads",
  icon: "folder",
  id: "fixture",
  name: "Installed fixture thread",
  pinned: true,
};
const dashboard: DashboardState = {
  destinations: [thread],
  detail: null,
  history: [],
  session: {
    active: 0,
    dhtNodes: 0,
    downloadSpeed: 0,
    engine: "Installer test fixture",
    freeSpace: null,
    mode: "server",
    peers: 0,
    port: 0,
    received: 0,
    startedAt: 0,
    uploaded: 0,
    uploadSpeed: 0,
  },
  settings: {
    downloadLimit: 0,
    downloadPath: thread.downloadPath,
    runInBackground: false,
    theme: "system",
    uploadLimit: 0,
  },
  torrents: [],
};

async function runCommand(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      throw new Error(`${args.join(" ")} failed:\n${stdout}${stderr}`);
    }
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

test("a scaffolded plugin compiles in a native host and runs from a relocated desktop cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-real-install-"));
  const project = join(directory, "plugin");
  const host = join(directory, "host");
  const workspace = join(import.meta.dir, "../../..");
  try {
    await runCommand(
      [join(workspace, "apps/scaffolder/src/cli.ts"), project, "--name", "installed-example"],
      workspace
    );
    await runCommand(["install", "--ignore-scripts"], project);
    await runCommand(["run", "build"], project);
    await Bun.write(
      join(host, "package.json"),
      JSON.stringify({ name: "tofu-plugin-host-fixture", private: true, type: "module" })
    );
    await symlink(
      join(workspace, "node_modules"),
      join(host, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await Bun.write(
      join(host, "bunfig.toml"),
      '[serve.static]\nplugins = ["@teyik0/furin/strip-plugin"]\n'
    );
    await cp(
      join(workspace, "apps/tofu/src/plugin-generated"),
      join(host, "src/plugin-generated"),
      { recursive: true }
    );
    await Bun.write(
      join(host, "src/fixture.ts"),
      `import type { ThreadLayoutContext } from "@tofu/plugins";\nexport const context: ThreadLayoutContext = ${JSON.stringify({ dashboard, settings: dashboard.settings, thread })};\n`
    );
    await Bun.write(
      join(host, "src/pages/root.tsx"),
      'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin"; export const route = defineRootRoute().config({mode:"ssr"}).layout(({children}) => <html lang="en"><head><HeadContent/></head><body>{children}<Scripts/></body></html>);'
    );
    await Bun.write(
      join(host, "src/pages/(app)/_route.tsx"),
      'import {defineRoute} from "@teyik0/furin"; import {route as root} from "../root"; import {context} from "../../fixture"; export const route = defineRoute().config({layout:root,mode:"ssr"}).loader(()=>({...context})).layout(({children})=><main><h1>Managed native host</h1>{children}</main>);'
    );
    await Bun.write(
      join(host, "src/server.ts"),
      `import {furin} from "@teyik0/furin"; import {Elysia} from "elysia"; export default new Elysia().use(await furin({pagesDir:"./src/pages"}));`
    );
    await Bun.write(
      join(host, "furin.config.ts"),
      'import {defineConfig} from "@teyik0/furin/config"; export default defineConfig({pagesDir:"./src/pages",serverEntry:"src/server.ts"});'
    );
    await installPlugin({
      hostDirectory: host,
      replace: false,
      sourceDirectory: project,
      trust: true,
    });
    await runCommand(
      [join(workspace, "node_modules/@teyik0/furin/src/cli/index.ts"), "build"],
      host
    );
    const packaged = join(directory, "packaged");
    await materializePluginRuntime(host, join(packaged, "plugins"));
    const result = await Bun.build({
      entrypoints: [join(host, "src/plugin-generated/server.ts")],
      outdir: packaged,
      target: "bun",
    });
    if (!result.success) {
      throw new AggregateError(result.logs, "Packaged plugin registry build failed");
    }
    const relocated = join(directory, "relocated");
    await rename(packaged, relocated);
    await rm(join(host, ".tofu-plugins"), { force: true, recursive: true });
    const core = createCore({
      dashboard: () => dashboard,
      thread: (id: string) => (id === thread.id ? thread : null),
    });
    const bundled = (await import(join(relocated, "server.js"))) as {
      externalPlugins: (
        capabilities: typeof core
      ) => Promise<import("@tofu/plugins").ErasedPluginDefinition[]>;
    };
    const definitions = await bundled.externalPlugins(core);
    expect(definitions.map((definition) => definition.id)).toEqual(["installed-example"]);
    const database = new Database(join(directory, "sync.sqlite"), { create: true });
    migrateSqliteSync(database);
    const runtime = createPluginRuntime({
      sync: {
        adapter: sqliteSyncAdapter({ database, namespace: "installed-fixture" }),
        principal: () => "fixture-user",
      },
    });
    try {
      const [definition] = definitions;
      if (!definition) {
        throw new Error("Missing packaged definition");
      }
      await runtime.installDefinition({ definition, directory: join(directory, "settings") });
      await runtime.enable(definition.id);
      const response = await runtime.handle(
        new Request("http://localhost/api/plugins/installed-example/status")
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        greeting: "Hello from your plugin",
        threadCount: 1,
      });
    } finally {
      await runtime.dispose();
      database.close();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 120_000);

test("additional local dependencies install without running package scripts or changing the source pin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-dependencies-"));
  const source = join(directory, "package");
  const host = join(directory, "host");
  const marker = join(directory, "scripts-ran.txt");
  try {
    await createPackage(source, "greeting", "Greeting");
    const packageFile = Bun.file(join(source, "package.json"));
    const manifest = await packageFile.json();
    await Bun.write(
      packageFile,
      JSON.stringify({
        ...manifest,
        dependencies: { "fixture-helper": "file:./dependencies/helper" },
      })
    );
    await Bun.write(
      join(source, "dependencies/helper/package.json"),
      JSON.stringify({
        exports: "./index.js",
        name: "fixture-helper",
        scripts: { postinstall: `bun -e 'await Bun.write(${JSON.stringify(marker)}, "executed")'` },
        type: "module",
        version: "0.0.0",
      })
    );
    await Bun.write(
      join(source, "dependencies/helper/index.js"),
      'export const greeting = "Installed dependency greeting";'
    );
    await Bun.write(
      join(source, "client.js"),
      'import {greeting} from "fixture-helper"; export const ui = {pages:[{id:"greeting",title:greeting,path:"greeting",pinnable:true,route:({threadLayout})=>threadLayout}]};'
    );
    await installPlugin({
      hostDirectory: host,
      replace: false,
      sourceDirectory: source,
      trust: true,
    });
    await generatePlugins(host);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await listInstalledPlugins(host)).toHaveLength(1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("upgrades require both trust and replacement while page traversal is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-upgrade-"));
  const source = join(directory, "package");
  const host = join(directory, "host");
  try {
    await createPackage(source, "greeting", "Original");
    await installPlugin({
      hostDirectory: host,
      replace: false,
      sourceDirectory: source,
      trust: true,
    });
    const [original] = await listInstalledPlugins(host);
    await createPackage(source, "greeting", "Updated");
    await expect(
      installPlugin({ hostDirectory: host, replace: true, sourceDirectory: source, trust: false })
    ).rejects.toThrow("--trust");
    await expect(
      installPlugin({ hostDirectory: host, replace: false, sourceDirectory: source, trust: true })
    ).rejects.toThrow("--replace");
    expect((await listInstalledPlugins(host))[0]?.integrity).toBe(original?.integrity);
    await installPlugin({
      hostDirectory: host,
      replace: true,
      sourceDirectory: source,
      trust: true,
    });
    const [updated] = await listInstalledPlugins(host);
    expect(updated?.integrity).not.toBe(original?.integrity);
    await createPackage(source, "../settings", "Unsafe page");
    await expect(
      installPlugin({ hostDirectory: host, replace: true, sourceDirectory: source, trust: true })
    ).rejects.toThrow("traversal");
    expect((await listInstalledPlugins(host))[0]?.integrity).toBe(updated?.integrity);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("official plugin identities are reserved before copying or executing local packages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-reserved-"));
  const source = join(directory, "package");
  const host = join(directory, "host");
  const marker = join(directory, "executed.txt");
  try {
    await createPackage(source, "greeting", "Greeting");
    const file = Bun.file(join(source, "package.json"));
    const manifest = await file.json();
    await Bun.write(
      file,
      JSON.stringify({ ...manifest, tofuPlugin: { ...manifest.tofuPlugin, id: "anilist" } })
    );
    await Bun.write(
      join(source, "client.js"),
      `await Bun.write(${JSON.stringify(marker)}, "executed"); export const ui = {};`
    );
    await expect(
      installPlugin({ hostDirectory: host, replace: false, sourceDirectory: source, trust: true })
    ).rejects.toThrow("reserved");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(join(host, ".tofu-plugins/installed.json")).exists()).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("managed plugin pages cannot overwrite developer-authored routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-route-collision-"));
  const source = join(directory, "package");
  const host = join(directory, "host");
  const page = join(host, "src/pages/(app)/(extensions)/extensions/example/greeting.tsx");
  try {
    await createPackage(source, "greeting", "Greeting");
    await Bun.write(page, "// Developer-authored route\nexport const route = null;\n");
    await expect(
      installPlugin({ hostDirectory: host, replace: false, sourceDirectory: source, trust: true })
    ).rejects.toThrow("developer-authored");
    expect(await Bun.file(page).text()).toContain("Developer-authored route");
    expect(await listInstalledPlugins(host)).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
