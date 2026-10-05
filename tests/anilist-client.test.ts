import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAniListClient } from "../src/server/feeds/anilist-client";

test("desktop configuration reads the packaged development client and never changes the release client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-anilist-client-"));
  const executable = join(directory, "Contents/MacOS/bun");
  try {
    expect(await readAniListClient("dev", undefined, executable)).toEqual({
      clientId: "52735",
      redirectUri: "tofu-dev://oauth/anilist",
    });
    await Bun.write(
      join(directory, "Contents/Resources/app/bun/anilist-client.json"),
      JSON.stringify({ clientId: "12345", redirectUri: "tofu-dev://oauth/anilist" })
    );
    expect(await readAniListClient("dev", undefined, executable)).toEqual({
      clientId: "12345",
      redirectUri: "tofu-dev://oauth/anilist",
    });
    expect((await readAniListClient("dev", "56789", executable)).clientId).toBe("56789");
    expect(await readAniListClient("release", "52735", executable)).toEqual({
      clientId: "9037",
      redirectUri: "tofu://oauth/anilist",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
