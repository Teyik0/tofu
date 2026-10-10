import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import desktopConfig from "../electrobun.config";
import { readBundleIdentity } from "../src/api/instance";

test("the Windows PNG icon fits the dimensions supported by ICO", async () => {
  const path = join(import.meta.dir, "..", desktopConfig.build.win.icon);
  const png = Buffer.from(await Bun.file(path).arrayBuffer());
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  expect(width).toBeLessThanOrEqual(256);
  expect(height).toBeLessThanOrEqual(256);
});

test.each([
  {
    channel: "stable",
    identifier: "app.tofu.torrents",
    path: "Tofu.app/Contents/MacOS/bun",
    profile: "release",
  },
  {
    channel: "dev",
    identifier: "app.tofu.torrents.dev",
    path: "Tofu-dev/bin/bun.exe",
    profile: "dev",
  },
  { channel: "stable", identifier: "app.tofu.torrents", path: "Tofu/bin/bun", profile: "release" },
])(
  "native bundle $path reads its profile from packaged metadata",
  async ({ path, channel, profile, identifier }) => {
    const directory = await mkdtemp(join(tmpdir(), "tofu-bundle-"));
    const executable = join(directory, path);
    const resources = join(dirname(executable), "../Resources");
    try {
      await Bun.write(join(resources, "build.json"), "{}");
      await Bun.write(join(resources, "version.json"), JSON.stringify({ channel, identifier }));
      expect(await readBundleIdentity(executable)).toEqual({ identifier, profile });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);

test("a source executable outside a native bundle has no packaged identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-source-"));
  try {
    expect(await readBundleIdentity(join(directory, "bin/bun"))).toBeNull();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test.each([
  { channel: "stable", identifier: "app.tofu.torrents.dev", message: "does not match" },
  { channel: "canary", identifier: "app.tofu.torrents", message: "profile is unknown" },
  { channel: undefined, identifier: "app.tofu.torrents", message: "profile is missing" },
])(
  "a native bundle rejects inconsistent identity $channel/$identifier",
  async ({ channel, identifier, message }) => {
    const directory = await mkdtemp(join(tmpdir(), "tofu-bundle-"));
    const resources = join(directory, "Tofu/Resources");
    try {
      await Bun.write(join(resources, "build.json"), "{}");
      await Bun.write(join(resources, "version.json"), JSON.stringify({ channel, identifier }));
      await expect(readBundleIdentity(join(directory, "Tofu/bin/bun"))).rejects.toThrow(message);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);
