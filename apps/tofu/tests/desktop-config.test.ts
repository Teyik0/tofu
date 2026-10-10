import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { version } from "../package.json";

test("Hutch embeds the package version and update feed in release metadata", async () => {
  const root = join(import.meta.dir, "..");
  const child = Bun.spawn(
    [
      process.execPath,
      "--bun",
      join(dirname(Bun.resolveSync("electrobun/package.json", root)), "bin/electrobun.cjs"),
      "config",
      "--env=stable",
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
  expect(config.release.baseUrl).toBe("https://github.com/Teyik0/Tofu/releases/latest/download");
}, 30_000);
