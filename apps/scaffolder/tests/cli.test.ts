import { expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.ts");

test("developers can discover the CLI without creating a project", async () => {
  const result = await runCLI(["--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("--sdk");
  expect(result.stdout).toContain("--furin");
});

async function runBun(args: string[], cwd: string | undefined) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stderr, stdout };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

function runCLI(args: string[]) {
  return runBun([cli, ...args], undefined);
}

test("existing directories and invalid plugin IDs are rejected without modifying user files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-scaffold-"));
  try {
    const sentinel = join(directory, "keep.txt");
    await Bun.write(sentinel, "user content");
    const existing = await runCLI([directory]);
    expect(existing.code).toBe(1);
    expect(existing.stderr).toContain("already exists");
    expect(await Bun.file(sentinel).text()).toBe("user content");
    const invalid = await runCLI([join(directory, "new-plugin"), "--name", "Invalid Name"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("lowercase");
    expect(await Bun.file(join(directory, "new-plugin", "package.json")).exists()).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("generated projects install, typecheck, build, and serve a native plugin preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-build-"));
  const project = join(directory, "example-plugin");
  try {
    const initial = join(directory, "initial-location");
    const root = join(import.meta.dir, "../../..");
    const generated = await runCLI([
      initial,
      "--name",
      "example-plugin",
      "--sdk",
      join(root, "package/plugins"),
      "--furin",
      join(root, "vendor/furin-pr163-914e82a.tgz"),
    ]);
    expect(generated.code).toBe(0);
    await rename(initial, project);
    for (const args of [
      ["install", "--ignore-scripts"],
      ["run", "tscheck"],
      ["run", "build"],
      ["test"],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: install, typecheck, build, and serve depend on each prior stage.
      const { stdout, stderr, code } = await runBun(args, project);
      expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: expect.any(String) });
    }
    const artifact = await Bun.file(join(project, "dist/client/index.js")).text();
    expect(artifact).not.toContain("@tofu/plugins/server");
    expect(artifact).not.toContain("node:fs");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 120_000);
