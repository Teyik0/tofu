import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import config from "../furin.config";
import { readBundleIdentity } from "../src/api/lib/instance";
import { desktopLauncher } from "../src/platform";

test("desktop launchers use the Furin Electrobun output directly", () => {
  expect(desktopLauncher("/project", { arch: "arm64", platform: "macos" }, "dev")).toBe(
    join("/project", ".furin/electrobun/build/dev-macos-arm64/Tofu-dev.app/Contents/MacOS/launcher")
  );
  expect(desktopLauncher("/project", { arch: "x64", platform: "win" }, "release")).toBe(
    join("/project", ".furin/electrobun/build/stable-win-x64/Tofu/bin/launcher.exe")
  );
});

test("the Windows PNG icon fits the dimensions supported by ICO", async () => {
  const icon = config.desktop?.sdk?.build?.win?.icon;
  if (!icon) {
    throw new Error("The Windows icon is missing from the desktop configuration");
  }
  const path = join(import.meta.dir, "..", icon);
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
