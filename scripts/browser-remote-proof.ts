// Opt-in real browser proof. Uses isolated Tofu hosts and a local FFmpeg-generated media file.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { chromium } from "playwright";
import type { Api } from "../src/api";
import { resolveInstanceConfig } from "../src/api/lib/instance";
import { expectSuccess } from "../tests/helpers/problem";
import { remoteServerFixture } from "../tests/helpers/remote";
import { launchServer } from "../tests/helpers/server-process";

const directory = await mkdtemp(join(tmpdir(), "tofu-browser-player-"));
const output = process.env.TOFU_PROOF_OUTPUT ?? join(directory, "evidence");
await mkdir(output, { recursive: true });
const file = join(directory, "Example - 03.mkv");
const encode = Bun.spawn(
  [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "20",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-y",
    file,
  ],
  { stderr: "inherit", stdout: "ignore" }
);
if ((await encode.exited) !== 0) {
  throw new Error("FFmpeg fixture generation failed");
}
const bytes = await Bun.file(file).bytes();
await using b = await remoteServerFixture(bytes.length, "Example - 03.mkv", bytes);
const config = resolveInstanceConfig({
  dataDir: join(directory, "a"),
  desktop: false,
  downloadPath: join(directory, "downloads"),
  homeDir: directory,
  platform: process.platform,
  port: "0",
  profile: "dev",
});
const a = launchServer(config);
const browser = await chromium.launch({
  executablePath: process.env.TOFU_CHROMIUM_EXECUTABLE,
  headless: true,
});
try {
  const origin = await a.ready();
  const owner = treaty<Api>(origin).api;
  const remote = treaty<Api>(b.url).api;
  const added = expectSuccess(
    await remote.torrents.file.post({
      file: new File([new Uint8Array(b.seed.torrentFile)], "show.torrent"),
      paused: "false",
    })
  );
  expectSuccess(
    await remote
      .torrents({ id: added.id })
      .peers.post({ peer: `127.0.0.1:${b.seeder.torrentPort}` })
  );
  await b.complete(added.id);
  const invitation = expectSuccess(
    await remote.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Browser proof",
      role: "playback",
    })
  );
  expectSuccess(
    await remote.connections.put({
      enabled: true,
      proxyOrigin: "https://fixture.invalid",
      transport: "proxy",
    })
  );
  const linked = expectSuccess(
    await owner["linked-libraries"].post({
      address: b.url,
      label: "Personal Tofu",
      secret: invitation.secret,
    })
  );
  const page = await browser.newPage({ viewport: { height: 800, width: 1280 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/thread/default`, { waitUntil: "domcontentloaded" });
  // The host snapshot makes the folder path visible after hydration; this caught a callback
  // reading the selected destination before its declaration, which static checks missed.
  await page.getByText(config.downloadPath, { exact: true }).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(output, "library.png") });
  await page.goto(
    `${origin}/player/remote?${new URLSearchParams({ episode: "3", file: "0", link: linked.id, media: "10", torrent: added.id })}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForFunction(
    () => (document.querySelector<HTMLCanvasElement>("canvas")?.width ?? 0) > 0,
    {
      timeout: 60_000,
    }
  );
  await page.waitForFunction(
    () =>
      !!document.querySelector(
        '[aria-label="Play"]:not([disabled]),[aria-label="Pause"]:not([disabled])'
      ),
    undefined,
    { timeout: 60_000 }
  );
  if (await page.getByRole("button", { exact: true, name: "Play" }).count()) {
    await page.keyboard.press("k");
  }
  const seek = page.getByRole("slider", { exact: true, name: "Seek" });
  await seek.waitFor();
  await page.waitForFunction(
    () => Number(document.querySelector<HTMLInputElement>('[aria-label="Seek"]')?.max) > 0,
    { timeout: 60_000 }
  );
  await page.waitForFunction(
    () => Number(document.querySelector<HTMLInputElement>('[aria-label="Seek"]')?.value) > 1,
    { timeout: 30_000 }
  );
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () => Number(document.querySelector<HTMLInputElement>('[aria-label="Seek"]')?.value) > 9,
    { timeout: 10_000 }
  );
  await page.waitForFunction(
    () => Number(document.querySelector<HTMLInputElement>('[aria-label="Seek"]')?.value) > 12,
    undefined,
    { timeout: 10_000 }
  );
  const evidence = await page.evaluate(() => ({
    canvas: {
      height: document.querySelector("canvas")?.height,
      width: document.querySelector("canvas")?.width,
    },
    duration: Number(document.querySelector<HTMLInputElement>('[aria-label="Seek"]')?.max),
    isolated: crossOriginIsolated,
    position: Number(document.querySelector<HTMLInputElement>('[aria-label="Seek"]')?.value),
    secure: isSecureContext,
    sharedMemory: typeof SharedArrayBuffer !== "undefined",
  }));
  if (!(evidence.secure && evidence.isolated && evidence.sharedMemory && evidence.position > 9)) {
    throw new Error(JSON.stringify({ errors, evidence }));
  }
  await page.screenshot({ path: join(output, "remote-player.png") });
  await page.goto(`${origin}/options/connections`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Connect your devices" }).waitFor();
  await page.getByText("Your AniList account stays here.", { exact: false }).waitFor();
  await page.screenshot({ fullPage: true, path: join(output, "connections-desktop.png") });
  await page.setViewportSize({ height: 844, width: 390 });
  const mobile = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  if (errors.length || mobile.width > mobile.viewport) {
    throw new Error(JSON.stringify({ errors, mobile }));
  }
  await page
    .getByText("Your AniList account stays here.", { exact: false })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ fullPage: true, path: join(output, "connections-mobile.png") });
  await Bun.write(
    join(output, "browser.json"),
    JSON.stringify({ browser: await browser.version(), errors, evidence, mobile }, null, 2)
  );
  console.log(
    JSON.stringify({ browser: await browser.version(), errors, evidence, mobile, output }, null, 2)
  );
} finally {
  await browser.close();
  await a.stop();
  // Keep only nonsensitive proof output; remove paired credentials and host data.
  await Promise.all(
    ["a", "downloads"].map((folder) =>
      rm(join(directory, folder), { force: true, recursive: true })
    )
  );
}
