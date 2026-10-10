import { expect, test } from "bun:test";
import { join } from "node:path";
import { readTorrentDefaults, setDefaultTorrentApp } from "../src/api/modules/desktop/associations";

test("development cannot change the user's default torrent application", async () => {
  await expect(setDefaultTorrentApp("dev")).rejects.toThrow(
    "Use the installed release of Tofu to change default applications"
  );
});

test("only release bundles advertise torrent files and magnet links to macOS", async () => {
  await Promise.all(
    [false, true].map(async (release) => {
      const configPath = join(import.meta.dir, "../furin.config.ts");
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const {default: config} = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify({...config.desktop.app, ...config.desktop.sdk.app}));`,
        ],
        {
          env: { ...process.env, TOFU_RELEASE: release ? "1" : "0" },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) {
        throw new Error(error);
      }
      const metadata: {
        identifier: string;
        urlSchemes: string[];
        fileAssociations: { ext: string[]; role: string }[];
      } = JSON.parse(output);
      expect(metadata.identifier).toBe(release ? "app.tofu.torrents" : "app.tofu.torrents.dev");
      expect(metadata.urlSchemes).toEqual(release ? ["magnet", "tofu"] : ["tofu-dev"]);
      expect(metadata.fileAssociations.map(({ ext, role }) => ({ ext, role }))).toEqual(
        release ? [{ ext: ["torrent"], role: "Viewer" }] : []
      );
    })
  );
});

test.skipIf(process.platform !== "darwin")(
  "macOS default torrent handlers can be inspected without changing preferences",
  async () => {
    const defaults = await readTorrentDefaults();
    expect(defaults.magnet === null || typeof defaults.magnet === "string").toBe(true);
    expect(defaults.torrent === null || typeof defaults.torrent === "string").toBe(true);
  }
);
