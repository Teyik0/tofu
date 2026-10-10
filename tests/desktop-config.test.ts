import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";

test("the Furin desktop configuration supplies the package version and release update feed", async () => {
  const root = join(import.meta.dir, "..");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const { default: config } = await import("./furin.config.ts"); console.log(JSON.stringify(config.desktop));',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HUTCH_HOME: process.env.HUTCH_HOME ?? join(root, ".cache/hutch"),
        TOFU_RELEASE: "1",
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  const config = JSON.parse(output.trim().split("\n").at(-1) ?? "");
  expect(config.app.version).toBe(version);
  expect(config.app.identifier).toBe("app.tofu.torrents");
  expect(config.sdk.release.baseUrl).toBe(
    "https://github.com/Teyik0/Tofu/releases/latest/download"
  );
  expect(config.sdk.build.linux.icon).toBe("public/tofu-icon.png");
  expect(config.sdk.build.mac.icons).toBe("public/tofu.iconset");
  expect(config.sdk.build.win.icon).toBe("public/tofu.iconset/icon_256x256.png");
  const iconsExist = await Promise.all(
    [
      config.sdk.build.linux.icon,
      `${config.sdk.build.mac.icons}/icon_512x512@2x.png`,
      config.sdk.build.win.icon,
    ].map((icon) => Bun.file(join(root, icon)).exists())
  );
  expect(iconsExist).toEqual([true, true, true]);
}, 30_000);

test.skipIf(process.platform !== "darwin")(
  "native smoke tests reject installers before launching them or creating application state",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "tofu-installer-guard-"));
    const installer = join(directory, "Tofu.app");
    try {
      await Bun.write(join(installer, "Contents/Resources/metadata.json"), "{}");
      const child = Bun.spawn([process.execPath, "scripts/native-smoke.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          TOFU_DATA_DIR: join(directory, "state"),
          TOFU_NATIVE_LAUNCHER: join(installer, "Contents/MacOS/launcher"),
          TOFU_NATIVE_PROFILE: "release",
        },
        stderr: "pipe",
        stdout: "ignore",
      });
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(error).toContain("not a self-extracting installer");
      expect(await readdir(directory)).toEqual(["Tofu.app"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
  30_000
);

test("the native host bundles its parser instead of requiring backend-only packages", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { default: config } = await import("./furin.config.ts");
const build = await Bun.build({
  entrypoints: [config.desktop.hostEntry],
  external: [...config.desktop.sdk.build.bun.external, "electrobun/main"],
  target: "bun",
});
if (!build.success) throw new AggregateError(build.logs, "Native host build failed");
const scanner = new Bun.Transpiler({ loader: "js", target: "bun" });
console.log(JSON.stringify(scanner.scanImports(await build.outputs[0].text()).map(item => item.path)));`,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TOFU_RELEASE: "1" },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  const imports: string[] = JSON.parse(output.trim().split("\n").at(-1) ?? "");
  expect(imports).toContain("electrobun/main");
  expect(imports).not.toContain("parse-torrent");
}, 30_000);
