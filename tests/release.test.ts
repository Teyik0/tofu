import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";

async function publish(repository: string | undefined, tag: string | undefined) {
  const directory = await mkdtemp(join(tmpdir(), "tofu-release-"));
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../scripts/release.ts"), "publish"],
      {
        cwd: directory,
        env: {
          GITHUB_REF_NAME: tag,
          GITHUB_REPOSITORY: repository,
          PATH: directory,
        },
        stderr: "pipe",
        stdout: "ignore",
      }
    );
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, error };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test.each(["Teyik0/tofu", "Teyik0/Tofu", "TEYIK0/TOFU"])(
  "release publication accepts repository %s before checking installers",
  async (repository) => {
    const result = await publish(repository, `v${version}`);
    expect(result.code).toBe(1);
    expect(result.error).toContain("Installer arm64 missing");
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
  const result = await publish(repository, tag);
  expect(result.code).toBe(1);
  expect(result.error).toContain("Incorrect publication tag or repository");
  expect(result.error).not.toContain("Installer arm64 missing");
});
