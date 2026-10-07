import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";

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
      installers.map((name) => Bun.write(join(directory, "artifacts", name), "installer content"))
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
    const checksums = Bun.file(join(directory, "artifacts/SHA256SUMS"));
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

test("publication attaches installers and checksums to an existing release without recreating it", async () => {
  const result = await publish("Teyik0/tofu", "main", expectedInstallers, true, `v${version}`);
  expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: "" });
  expect(result.commands.map((args) => args.slice(0, 2))).toEqual([
    ["release", "view"],
    ["release", "upload"],
  ]);
  expect(result.commands[1]).toContain("--clobber");
  expect(result.commands[1]?.[2]).toBe(`v${version}`);
  for (const name of expectedInstallers) {
    expect(result.commands[1]).toContain(join("artifacts", name));
    expect(result.checksums).toContain(`${Bun.SHA256.hash("installer content", "hex")}  ${name}\n`);
  }
  expect(result.commands[1]).toContain("artifacts/SHA256SUMS");
});

test("publication creates a release when the validated tag has no release yet", async () => {
  const result = await publish("Teyik0/tofu", `v${version}`, expectedInstallers, false);
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
