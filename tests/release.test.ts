import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { hostDesktopTarget, installerExtension, installerName } from "../src/platform";

const artifacts = ".furin/electrobun/artifacts";

test("release processing renames only the installer in the Furin output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-release-artifacts-"));
  const target = hostDesktopTarget();
  const prefix = `${target.platform}-${target.arch}`;
  const original = `${prefix}-Tofu${target.platform === "macos" ? "" : "-Setup"}.${installerExtension(target)}`;
  const archive = `stable-${prefix}-Tofu.tar.zst`;
  try {
    await Bun.write(join(directory, artifacts, original), "installer bytes");
    await Bun.write(join(directory, artifacts, archive), "update bytes");
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../scripts/release.ts"), "artifacts"],
      {
        cwd: directory,
        stderr: "pipe",
        stdout: "ignore",
      }
    );
    const error = await new Response(child.stderr).text();
    expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" });
    expect(await Bun.file(join(directory, artifacts, installerName(version, target))).text()).toBe(
      "installer bytes"
    );
    expect(await Bun.file(join(directory, artifacts, original)).exists()).toBe(false);
    expect(await Bun.file(join(directory, artifacts, archive)).text()).toBe("update bytes");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

const updateMetadataPattern: RegExp = /^stable-(macos|win|linux)-(arm64|x64)-update\.json$/;

async function publish(
  repository: string | undefined,
  tag: string | undefined,
  installers: string[],
  releaseExists?: boolean,
  releaseTag?: string
) {
  const directory = await mkdtemp(join(tmpdir(), "tofu-release-"));
  try {
    await Promise.all(
      installers.map((name) => {
        const target: RegExpExecArray | null = updateMetadataPattern.exec(name);
        const content = target
          ? JSON.stringify({
              arch: target[2],
              artifact: {
                file: `stable-${target[1]}-${target[2]}-Tofu${target[1] === "macos" ? ".app" : ""}.tar.zst`,
              },
              channel: "stable",
              identifier: "app.tofu.torrents",
              platform: target[1],
              schemaVersion: 1,
              version,
            })
          : "installer content";
        return Bun.write(join(directory, artifacts, name), content);
      })
    );
    const commandsPath = join(directory, "github-commands.json");
    if (releaseExists !== undefined) {
      const entry = join(directory, "github.ts");
      await Bun.write(
        entry,
        `const path = ${JSON.stringify(commandsPath)};
const file = Bun.file(path);
const commands = await file.exists() ? await file.json() : [];
const args = Bun.argv.slice(2);
commands.push(args);
await Bun.write(path, JSON.stringify(commands));
const exists = ${releaseExists};
if (args[0] !== "release") process.exit(1);
if (args[1] === "view") process.exit(exists ? 0 : 1);
if (args[1] === "create") process.exit(exists ? 1 : 0);
if (args[1] === "upload") process.exit(exists ? 0 : 1);
process.exit(1);`
      );
      const build = await Bun.build({
        compile: { outfile: join(directory, process.platform === "win32" ? "gh.exe" : "gh") },
        entrypoints: [entry],
      });
      if (!build.success) {
        throw new AggregateError(build.logs, "GitHub CLI fixture build failed");
      }
    }
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../scripts/release.ts"), "publish"],
      {
        cwd: directory,
        env: {
          GITHUB_REF_NAME: tag,
          GITHUB_REPOSITORY: repository,
          PATH: directory,
          RELEASE_TAG: releaseTag,
        },
        stderr: "pipe",
        stdout: "ignore",
      }
    );
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    const commands: string[][] = (await Bun.file(commandsPath).exists())
      ? await Bun.file(commandsPath).json()
      : [];
    const checksums = Bun.file(join(directory, artifacts, "SHA256SUMS"));
    return {
      checksums: (await checksums.exists()) ? await checksums.text() : null,
      code,
      commands,
      error,
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test.each(["Teyik0/tofu", "Teyik0/Tofu", "TEYIK0/TOFU"])(
  "release publication accepts repository %s before checking installers",
  async (repository) => {
    const result = await publish(repository, `v${version}`, []);
    expect(result.code).toBe(1);
    expect(result.error).toContain(`Installer Tofu-${version}-macos-arm64.dmg missing`);
    expect(result.error).not.toContain("Incorrect publication tag or repository");
  }
);

test.each([
  { repository: "Teyik0/other", tag: `v${version}` },
  { repository: "other/tofu", tag: `v${version}` },
  { repository: undefined, tag: `v${version}` },
  { repository: "Teyik0/tofu", tag: "v999.0.0" },
  { repository: "Teyik0/tofu", tag: undefined },
])("release publication rejects invalid repository or tag %j", async ({ repository, tag }) => {
  const result = await publish(repository, tag, []);
  expect(result.code).toBe(1);
  expect(result.error).toContain("Incorrect publication tag or repository");
  expect(result.error).not.toContain("Installer");
});

const expectedInstallers = [
  `Tofu-${version}-macos-arm64.dmg`,
  `Tofu-${version}-win-x64.zip`,
  `Tofu-${version}-linux-x64.tar.gz`,
  `Tofu-${version}-linux-arm64.tar.gz`,
];

test("publication requires native update metadata before contacting GitHub", async () => {
  const result = await publish("Teyik0/Tofu", `v${version}`, expectedInstallers);
  expect(result.code).toBe(1);
  expect(result.error).toContain("Update metadata stable-macos-arm64-update.json missing");
});

const expectedUpdates = ["macos-arm64", "win-x64", "linux-x64", "linux-arm64"].flatMap((target) => [
  `stable-${target}-update.json`,
  `stable-${target}-Tofu${target.startsWith("macos") ? ".app" : ""}.tar.zst`,
]);

test("publication attaches installers and checksums to an existing release without recreating it", async () => {
  const result = await publish(
    "Teyik0/tofu",
    "main",
    [...expectedInstallers, ...expectedUpdates],
    true,
    `v${version}`
  );
  expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: "" });
  expect(result.commands.map((args) => args.slice(0, 2))).toEqual([
    ["release", "view"],
    ["release", "upload"],
  ]);
  expect(result.commands[1]).toContain("--clobber");
  expect(result.commands[1]?.[2]).toBe(`v${version}`);
  for (const name of expectedInstallers) {
    expect(result.commands[1]).toContain(join(artifacts, name));
    expect(result.checksums).toContain(`${Bun.SHA256.hash("installer content", "hex")}  ${name}\n`);
  }
  expect(result.commands[1]).toContain(join(artifacts, "SHA256SUMS"));
});

test("publication creates a release when the validated tag has no release yet", async () => {
  const result = await publish(
    "Teyik0/tofu",
    `v${version}`,
    [...expectedInstallers, ...expectedUpdates],
    false
  );
  expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: "" });
  expect(result.commands.map((args) => args.slice(0, 2))).toEqual([
    ["release", "view"],
    ["release", "create"],
  ]);
  expect(result.commands[1]).toContain("--verify-tag");
  expect(result.commands[1]).toContain(`Tofu ${version}`);
  expect(result.commands[1]).toContain("--generate-notes");
});

test.each(expectedInstallers)(
  "publication requires %s before contacting GitHub",
  async (missing) => {
    const result = await publish(
      "Teyik0/Tofu",
      `v${version}`,
      expectedInstallers.filter((name) => name !== missing)
    );
    expect(result.code).toBe(1);
    expect(result.error).toContain(`Installer ${missing} missing`);
  }
);
