import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPluginPackage } from "../src/server";

test("local package inspection pins metadata and owned files without executing code or lifecycle scripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-package-"));
  try {
    await mkdir(join(directory, "dist"));
    await Bun.write(
      join(directory, "package.json"),
      JSON.stringify({
        name: "test-plugin-package",
        scripts: { install: "touch executed" },
        tofuPlugin: {
          apiVersion: "0.0.0",
          client: "./dist/client.js",
          id: "test-plugin",
          server: "./dist/server.js",
        },
        type: "module",
        version: "0.0.0",
      })
    );
    await Bun.write(
      join(directory, "dist/server.js"),
      'throw new Error("This module must not execute during inspection")'
    );
    await Bun.write(join(directory, "dist/client.js"), "export const ui = {}");
    const first = await inspectPluginPackage(directory);
    expect(first.id).toBe("test-plugin");
    expect(first.integrity.startsWith("sha256-")).toBe(true);
    expect(await Bun.file(join(directory, "executed")).exists()).toBe(false);
    expect(await inspectPluginPackage(directory, { integrity: first.integrity })).toEqual(first);
    await Bun.write(join(directory, "dist/client.js"), "export const ui = { changed: true }");
    await expect(inspectPluginPackage(directory, { integrity: first.integrity })).rejects.toThrow(
      "integrity"
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("package inspection rejects unsupported API versions and entry points outside the package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-compatibility-"));
  try {
    await Bun.write(join(directory, "server.js"), "export const createPlugin = () => null");
    await Bun.write(join(directory, "client.js"), "export const ui = {}");
    const metadata = {
      apiVersion: "1.0.0",
      client: "./client.js",
      id: "compatibility-plugin",
      server: "./server.js",
    };
    const writeManifest = () =>
      Bun.write(
        join(directory, "package.json"),
        JSON.stringify({
          name: "compatibility-plugin",
          tofuPlugin: metadata,
          type: "module",
          version: "0.0.0",
        })
      );
    await writeManifest();
    await expect(inspectPluginPackage(directory)).rejects.toThrow("incompatible");
    metadata.apiVersion = "0.0.0";
    metadata.server = "../outside.js";
    await writeManifest();
    await expect(inspectPluginPackage(directory)).rejects.toThrow("inside the package");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test.each([
  ["node_modules", "server"],
  [".git", "client"],
] as const)(
  "package inspection rejects %s %s entry points excluded from integrity hashing",
  async (ignoredDirectory, entry) => {
    const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-ignored-entry-"));
    try {
      await mkdir(join(directory, ignoredDirectory));
      await mkdir(join(directory, "dist"));
      await Bun.write(join(directory, ignoredDirectory, "entry.js"), "export const plugin = {}");
      await Bun.write(join(directory, "server.js"), "export const createPlugin = () => null");
      await Bun.write(join(directory, "client.js"), "export const ui = {}");
      const metadata = {
        apiVersion: "0.0.0",
        client: "./client.js",
        id: "ignored-entry-plugin",
        server: "./server.js",
      };
      metadata[entry] = `./dist/../${ignoredDirectory}/entry.js`;
      await Bun.write(
        join(directory, "package.json"),
        JSON.stringify({
          name: "ignored-entry-plugin",
          tofuPlugin: metadata,
          type: "module",
          version: "0.0.0",
        })
      );
      await expect(inspectPluginPackage(directory)).rejects.toThrow(
        "excluded from integrity hashing"
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  }
);
