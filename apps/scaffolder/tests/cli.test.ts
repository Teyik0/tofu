import { expect, test } from "bun:test";
import { mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBun } from "./helpers/process";

const cli = join(import.meta.dir, "../src/cli.ts");

test("developers can discover the CLI without creating a project", async () => {
  const result = await runBun([cli, "--help"], undefined);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("--sdk");
  expect(result.stdout).toContain("--furin");
});

test("existing directories and invalid plugin IDs are rejected without modifying user files", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tofu-scaffold-")));
  try {
    const sentinel = join(directory, "keep.txt");
    await Bun.write(sentinel, "user content");
    const existing = await runBun([cli, directory], undefined);
    expect(existing.code).toBe(1);
    expect(existing.stderr).toContain("already exists");
    expect(await Bun.file(sentinel).text()).toBe("user content");
    const invalid = await runBun(
      [cli, join(directory, "new-plugin"), "--name", "Invalid Name"],
      undefined
    );
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("lowercase");
    expect(await Bun.file(join(directory, "new-plugin", "package.json")).exists()).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("generated projects install, typecheck, build, and serve a native plugin preview", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tofu-plugin-build-")));
  const project = join(directory, "example-plugin");
  try {
    const initial = join(directory, "initial-location");
    const root = join(import.meta.dir, "../../..");
    const generated = await runBun([cli, initial, "--name", "example-plugin"], undefined);
    expect(generated.code).toBe(0);
    const overridden = await runBun(
      [
        cli,
        join(directory, "explicit-local-dependencies"),
        "--sdk",
        join(root, "package/plugins"),
        "--furin",
        join(root, "vendor/furin-pr163-118d85f.tgz"),
      ],
      undefined
    );
    expect(overridden.code).toBe(0);
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
      if (args[1] === "build") {
        expect(stdout + stderr).toContain("Elysia AOT skipped because the app uses .mount()");
      }
    }
    const artifact = await Bun.file(join(project, "dist/client/index.js")).text();
    expect(artifact).not.toContain("@tofu/plugins/server");
    expect(artifact).not.toContain("node:fs");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 120_000);
