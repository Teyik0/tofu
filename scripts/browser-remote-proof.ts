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

declare global {
  interface Window {
    tofuFullscreenProof: {
      deniedWarmups: number;
      entries: number;
      exits: number;
      gestureRetries: number;
      picture?: {
        brightness: number;
        difference: number;
        colorDifference: number;
        nativeBrightness: number;
        nativePixels: number[];
        pixels: number[];
      };
    };
    tofuPausedPicture?: {
      brightness: number;
      difference: number;
      colorDifference: number;
      nativeBrightness: number;
    };
  }
}

const directory = await mkdtemp(join(tmpdir(), "tofu-browser-player-"));
const output = process.env.TOFU_PROOF_OUTPUT ?? join(directory, "evidence");
await mkdir(output, { recursive: true });
const file = join(directory, "Example - 03.mkv");
const subtitles = join(directory, "subtitles.srt");
await Bun.write(subtitles, "1\n00:00:00,000 --> 00:01:00,000\nBrowser playback proof\n");
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
    "-i",
    subtitles,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-map",
    "1:a",
    "-map",
    "2:s",
    "-metadata:s:a:0",
    "title=Japanese original audio with a long track name",
    "-metadata:s:a:1",
    "title=English alternate audio with a long track name",
    "-metadata:s:s:0",
    "title=French subtitles with a long track name",
    "-c:s",
    "srt",
    "-t",
    "60",
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
const page = await browser.newPage({ hasTouch: true, viewport: { height: 800, width: 1280 } });
page.setDefaultTimeout(20_000);
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
  // Observe the real engine's output samples, rather than treating moving video as audio proof.
  await page.addInitScript(() => {
    const NativeAudioWorkletNode = window.AudioWorkletNode;
    Object.assign(window, { tofuAudioProof: { frames: 0, peak: 0 } });
    window.AudioWorkletNode = class extends NativeAudioWorkletNode {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...args);
        this.port.addEventListener("message", ({ data }) => {
          if (data?.type === "level") {
            const proof = (
              window as typeof window & {
                tofuAudioProof: { frames: number; peak: number };
              }
            ).tofuAudioProof;
            proof.frames = Math.max(proof.frames, data.frames);
            proof.peak = Math.max(proof.peak, data.peak);
          }
        });
      }
    };
  });
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
  await page.waitForFunction(() => {
    const { tofuAudioProof } = window as typeof window & {
      tofuAudioProof: { frames: number; peak: number };
    };
    return tofuAudioProof.frames > 4800 && tofuAudioProof.peak > 0.01;
  });
  const evidence = await page.evaluate(() => ({
    audio: (window as typeof window & { tofuAudioProof: { frames: number; peak: number } })
      .tofuAudioProof,
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
  // Both track selectors, time, transport and external playback must fit on a narrow phone.
  const playerLayouts: { viewport: number; overflow: (string | null)[] }[] = [];
  for (const viewport of [
    { height: 700, width: 390 },
    { height: 568, width: 320 },
    { height: 390, width: 844 },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each viewport changes the same live player sequentially.
    await page.setViewportSize(viewport);
    await page.locator(".media-player").dispatchEvent("pointermove", { pointerType: "mouse" });
    await page.waitForFunction(() => {
      const controls = document.querySelector(".player-controls");
      return controls && getComputedStyle(controls).opacity === "1";
    });
    const layout = await page.evaluate(() => ({
      overflow: [
        ...document.querySelectorAll<HTMLElement>(
          ".player-controls input,.player-controls button,.player-time"
        ),
      ]
        .filter((element) => getComputedStyle(element).display !== "none")
        .map((element) => ({
          label: element.getAttribute("aria-label") ?? element.textContent,
          rect: element.getBoundingClientRect(),
        }))
        .filter(
          ({ rect }) =>
            rect.width > 0 &&
            (rect.left < 0 || rect.right > innerWidth || rect.bottom > innerHeight)
        )
        .map(({ label }) => label),
      viewport: innerWidth,
    }));
    if (layout.overflow.length) {
      throw new Error(JSON.stringify(layout));
    }
    playerLayouts.push(layout);
    await page.screenshot({ path: join(output, `player-${viewport.width}.png`) });
  }
  await page.setViewportSize({ height: 844, width: 390 });
  await seek.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  if (await page.getByRole("button", { exact: true, name: "Play" }).count()) {
    await page.keyboard.press("k");
  }
  await page.waitForFunction(() => !!document.querySelector('[aria-label="Pause"]'));
  // Real touch events must only hide/reveal controls, including taps over a hidden pause button.
  await page.touchscreen.tap(180, 200);
  await page.waitForFunction(
    () => document.querySelector(".media-player")?.getAttribute("data-idle") === "true"
  );
  const pauseBounds = await page
    .getByRole("button", { includeHidden: true, name: "Pause" })
    .boundingBox();
  if (!pauseBounds) {
    throw new Error("The pause control is missing");
  }
  await page.touchscreen.tap(
    pauseBounds.x + pauseBounds.width / 2,
    pauseBounds.y + pauseBounds.height / 2
  );
  await page.waitForFunction(
    () => document.querySelector(".media-player")?.getAttribute("data-idle") === "false"
  );
  if (!(await page.getByRole("button", { exact: true, name: "Pause" }).count())) {
    throw new Error("Touching the picture paused playback");
  }
  await page.screenshot({ path: join(output, "player-touch.png") });
  await page.waitForFunction(
    () => Number(document.querySelector<HTMLInputElement>('[aria-label="Seek"]')?.value) > 0.5
  );
  await page.getByRole("button", { exact: true, name: "Pause" }).tap();
  await page.getByRole("button", { exact: true, name: "Play" }).waitFor();
  await page.touchscreen.tap(180, 200);
  await page.getByRole("button", { exact: true, name: "Play" }).waitFor();
  await page.getByRole("button", { exact: true, name: "Full screen" }).tap();
  await page.waitForFunction(() => document.fullscreenElement !== null);
  await page.getByRole("button", { exact: true, name: "Exit full screen" }).tap();
  await page.waitForFunction(() => document.fullscreenElement === null);
  // Exercise the iPhone bridge with real VLC frames and audio. Chromium cannot
  // display Safari's native UI, so only the WebKit entry/exit boundary is simulated.
  await page.addInitScript(() => {
    window.tofuFullscreenProof = { deniedWarmups: 0, entries: 0, exits: 0, gestureRetries: 0 };
    const nativePlay = HTMLVideoElement.prototype.play;
    const nativePause = HTMLVideoElement.prototype.pause;
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
    Object.defineProperty(HTMLElement.prototype, "webkitRequestFullscreen", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperties(HTMLVideoElement.prototype, {
      pause: {
        configurable: true,
        value(this: HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }) {
          nativePause.call(this);
          const source = document.querySelector("canvas");
          if (!(source && this.webkitDisplayingFullscreen && this.readyState >= 2)) {
            return;
          }
          // Chromium retains the paused stream's visible surface but later drawImage(video)
          // reads black. Sample the real paused video at this boundary, then assert settled state.
          const expected = document.createElement("canvas");
          const actual = document.createElement("canvas");
          expected.width = this.videoWidth;
          actual.width = 32;
          expected.height = this.videoHeight;
          actual.height = 18;
          const expectedDrawing = expected.getContext("2d", { alpha: false });
          const actualDrawing = actual.getContext("2d", { willReadFrequently: true });
          if (!(expectedDrawing && actualDrawing)) {
            throw new Error("Unable to inspect the native video picture");
          }
          const width = Math.min(source.width, (source.height * 16) / 9);
          const height = (width * 9) / 16;
          expectedDrawing.drawImage(
            source,
            (source.width - width) / 2,
            (source.height - height) / 2,
            width,
            height,
            0,
            0,
            expected.width,
            expected.height
          );
          // Match the bridge's rounded capture size before sampling the image.
          actualDrawing.drawImage(expected, 0, 0, 32, 18);
          const pixels = [...actualDrawing.getImageData(0, 0, 32, 18).data];
          actualDrawing.drawImage(this, 0, 0, 32, 18);
          const native = actualDrawing.getImageData(0, 0, 32, 18).data;
          let difference = 0;
          let colorDifference = 0;
          let brightness = 0;
          let nativeBrightness = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            const nativeRed = native[index] ?? 0;
            const nativeGreen = native[index + 1] ?? 0;
            const nativeBlue = native[index + 2] ?? 0;
            colorDifference +=
              Math.abs(red - nativeRed) +
              Math.abs(green - nativeGreen) +
              Math.abs(blue - nativeBlue);
            brightness += red + green + blue;
            nativeBrightness += nativeRed + nativeGreen + nativeBlue;
            // Capture can subsample chroma; compare picture structure using luminance.
            const expectedLuma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
            const actualLuma = 0.2126 * nativeRed + 0.7152 * nativeGreen + 0.0722 * nativeBlue;
            difference += Math.abs(expectedLuma - actualLuma);
          }
          const samples = (pixels.length * 3) / 4;
          difference /= pixels.length / 4;
          colorDifference /= samples;
          brightness /= samples;
          nativeBrightness /= samples;
          window.tofuPausedPicture = { brightness, colorDifference, difference, nativeBrightness };
          window.tofuFullscreenProof.picture = {
            brightness,
            colorDifference,
            difference,
            nativeBrightness,
            nativePixels: [...native],
            pixels,
          };
        },
      },
      play: {
        configurable: true,
        async value(this: HTMLVideoElement) {
          if (this.srcObject instanceof MediaStream && this.muted) {
            if (window.tofuFullscreenProof.deniedWarmups === 0) {
              window.tofuFullscreenProof.deniedWarmups += 1;
              throw new DOMException(
                "Fullscreen warmup requires a user gesture",
                "NotAllowedError"
              );
            }
            if (navigator.userActivation.isActive) {
              window.tofuFullscreenProof.gestureRetries += 1;
            }
          }
          await nativePlay.call(this);
        },
      },
      webkitEnterFullscreen: {
        configurable: true,
        value(this: HTMLVideoElement & { webkitDisplayingFullscreen: boolean }) {
          if (!navigator.userActivation.isActive) {
            throw new Error("Native fullscreen lost its user gesture");
          }
          window.tofuFullscreenProof.entries += 1;
          window.tofuFullscreenProof.picture = undefined;
          this.webkitDisplayingFullscreen = true;
          this.dispatchEvent(new Event("webkitbeginfullscreen"));
        },
      },
      webkitExitFullscreen: {
        configurable: true,
        value(this: HTMLVideoElement & { webkitDisplayingFullscreen: boolean }) {
          window.tofuFullscreenProof.exits += 1;
          this.webkitDisplayingFullscreen = false;
          this.dispatchEvent(new Event("webkitendfullscreen"));
        },
      },
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("status")
    .filter({ hasText: "Fullscreen warmup requires a user gesture" })
    .waitFor();
  // Earlier playback authorized autoplay on this origin; wait for startup's own play command.
  await page.getByRole("button", { exact: true, name: "Pause" }).waitFor();
  await page.waitForFunction(
    () => Number(document.querySelector<HTMLInputElement>('[aria-label="Seek"]')?.value) > 0.5
  );
  await page.getByRole("button", { exact: true, name: "Pause" }).tap();
  await page.getByRole("button", { exact: true, name: "Play" }).waitFor();
  await page.getByRole("button", { exact: true, name: "Full screen" }).tap();
  await page
    .getByRole("status")
    .filter({ hasText: "Full screen video is getting ready. Tap full screen again." })
    .waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video && video.readyState >= 2 && video.paused;
  });
  const preparationEvidence = await page.evaluate(() => window.tofuFullscreenProof);
  if (
    preparationEvidence.deniedWarmups !== 1 ||
    preparationEvidence.gestureRetries !== 1 ||
    preparationEvidence.entries !== 0
  ) {
    throw new Error(
      `Native fullscreen preparation did not recover: ${JSON.stringify(preparationEvidence)}`
    );
  }
  // Initial paused entry must present actual VLC pixels without starting VLC.
  await page.getByRole("button", { exact: true, name: "Full screen" }).tap();
  await page.getByRole("button", { exact: true, name: "Exit full screen" }).waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video?.paused && !video.muted && !!window.tofuFullscreenProof.picture;
  });
  await page.getByRole("button", { exact: true, name: "Play" }).waitFor();
  const initialPicture = await page.evaluate(() => window.tofuFullscreenProof.picture);
  if (
    !initialPicture ||
    initialPicture.difference >= 12 ||
    initialPicture.brightness <= 20 ||
    initialPicture.nativeBrightness <= 20
  ) {
    throw new Error("The initial paused native video has no current picture");
  }
  const {
    nativePixels: initialNativePixels,
    pixels: initialPixels,
    ...initialPausedEvidence
  } = initialPicture;
  await page.evaluate(async () => {
    await document.querySelector("video")?.play();
  });
  await page.getByRole("button", { exact: true, name: "Pause" }).waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    const stream = video?.srcObject as MediaStream | null;
    return (
      video &&
      !video.muted &&
      !video.paused &&
      Math.abs(video.videoWidth / video.videoHeight - 16 / 9) < 0.02 &&
      stream?.getAudioTracks().length === 1 &&
      stream.getVideoTracks().length === 1 &&
      video.getVideoPlaybackQuality().totalVideoFrames > 3
    );
  });
  const fullscreenEvidence = await page.evaluate(async () => {
    const video = document.querySelector("video");
    if (!(video?.srcObject instanceof MediaStream)) {
      throw new Error("Native fullscreen has no media stream");
    }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    const input = context.createMediaStreamSource(video.srcObject);
    input.connect(analyser);
    try {
      await context.resume();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return {
        audioPeak: Math.max(...samples.map(Math.abs)),
        height: video.videoHeight,
        width: video.videoWidth,
      };
    } finally {
      input.disconnect();
      await context.close();
    }
  });
  if (fullscreenEvidence.audioPeak < 0.01) {
    throw new Error(`Native fullscreen audio is silent: ${JSON.stringify(fullscreenEvidence)}`);
  }
  await page.evaluate(() => document.querySelector("video")?.pause());
  await page.getByRole("button", { exact: true, name: "Play" }).waitFor();
  await page.evaluate(async () => {
    await document.querySelector("video")?.play();
  });
  await page.getByRole("button", { exact: true, name: "Pause" }).waitFor();
  await page.getByRole("button", { exact: true, name: "Exit full screen" }).tap();
  await page.getByRole("button", { exact: true, name: "Full screen" }).waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video?.muted && video.paused;
  });
  // Seek the real paused engine to a different picture before native reentry.
  await page.getByRole("button", { exact: true, name: "Pause" }).tap();
  await page.getByRole("button", { exact: true, name: "Play" }).waitFor();
  await seek.fill("12");
  await seek.dispatchEvent("pointerup");
  await page.waitForFunction(
    () => Number(document.querySelector<HTMLInputElement>('[aria-label="Seek"]')?.value) > 11
  );
  await page.getByRole("button", { exact: true, name: "Full screen" }).tap();
  await page.getByRole("button", { exact: true, name: "Exit full screen" }).waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video?.paused && !video.muted && !!window.tofuFullscreenProof.picture;
  });
  await page.getByRole("button", { exact: true, name: "Play" }).waitFor();
  const reenteredPicture = await page.evaluate(() => window.tofuFullscreenProof.picture);
  if (
    !reenteredPicture ||
    reenteredPicture.difference >= 12 ||
    reenteredPicture.brightness <= 20 ||
    reenteredPicture.nativeBrightness <= 20
  ) {
    throw new Error("The paused native video retained a stale picture after seeking");
  }
  const {
    nativePixels: reenteredNativePixels,
    pixels: reenteredPixels,
    ...reenteredMetrics
  } = reenteredPicture;
  let changed = 0;
  let nativeChanged = 0;
  let staleDifference = 0;
  for (let index = 0; index < reenteredPixels.length; index += 1) {
    if (index % 4 !== 3) {
      changed += Math.abs((reenteredPixels[index] ?? 0) - (initialPixels[index] ?? 0));
      nativeChanged += Math.abs(
        (reenteredNativePixels[index] ?? 0) - (initialNativePixels[index] ?? 0)
      );
    }
    if (index % 4 === 0) {
      const initialLuma =
        0.2126 * (initialPixels[index] ?? 0) +
        0.7152 * (initialPixels[index + 1] ?? 0) +
        0.0722 * (initialPixels[index + 2] ?? 0);
      const reenteredLuma =
        0.2126 * (reenteredNativePixels[index] ?? 0) +
        0.7152 * (reenteredNativePixels[index + 1] ?? 0) +
        0.0722 * (reenteredNativePixels[index + 2] ?? 0);
      staleDifference += Math.abs(initialLuma - reenteredLuma);
    }
  }
  changed /= (reenteredPixels.length * 3) / 4;
  nativeChanged /= (reenteredPixels.length * 3) / 4;
  staleDifference /= reenteredPixels.length / 4;
  if (changed <= 6 || nativeChanged <= 6 || staleDifference <= reenteredPicture.difference + 2) {
    throw new Error(
      `Paused reentry did not match the current picture: ${JSON.stringify({ changed, currentDifference: reenteredPicture.difference, nativeChanged, staleDifference })}`
    );
  }
  const reenteredPausedEvidence = { ...reenteredMetrics, changed, nativeChanged, staleDifference };
  await page.getByRole("button", { exact: true, name: "Exit full screen" }).tap();
  // A missing presentation callback must close native UI, including a late begin event.
  const exitsBeforeTimeout = await page.evaluate(() => {
    const video = document.querySelector("video");
    Object.defineProperty(video, "requestVideoFrameCallback", {
      configurable: true,
      value: () => 0,
    });
    return window.tofuFullscreenProof.exits;
  });
  await page.getByRole("button", { exact: true, name: "Full screen" }).tap();
  await page
    .getByRole("status")
    .filter({ hasText: "Full screen video did not present a picture. Try again." })
    .waitFor();
  await page.getByRole("button", { exact: true, name: "Full screen" }).waitFor();
  const timeoutEvidence = await page.evaluate(() => {
    const video = document.querySelector("video") as HTMLVideoElement & {
      webkitDisplayingFullscreen: boolean;
    };
    const closedAfterTimeout = !video.webkitDisplayingFullscreen;
    const exitsAfterTimeout = window.tofuFullscreenProof.exits;
    video.webkitDisplayingFullscreen = true;
    video.dispatchEvent(new Event("webkitbeginfullscreen"));
    Reflect.deleteProperty(video, "requestVideoFrameCallback");
    return {
      closedAfterLateBegin: !video.webkitDisplayingFullscreen,
      closedAfterTimeout,
      exitsAfterTimeout,
      restored: video.muted && video.paused,
    };
  });
  if (
    !(
      timeoutEvidence.closedAfterTimeout &&
      timeoutEvidence.closedAfterLateBegin &&
      timeoutEvidence.restored
    ) ||
    timeoutEvidence.exitsAfterTimeout <= exitsBeforeTimeout
  ) {
    throw new Error(`Native timeout cleanup failed: ${JSON.stringify(timeoutEvidence)}`);
  }
  // Preserve the paused source when native entry itself is rejected.
  await page.evaluate(() => {
    Object.defineProperty(document.querySelector("video"), "webkitEnterFullscreen", {
      value() {
        throw new Error("Native fullscreen was denied");
      },
    });
  });
  await page.getByRole("button", { exact: true, name: "Full screen" }).tap();
  await page.getByRole("status").filter({ hasText: "Native fullscreen was denied" }).waitFor();
  await page.getByRole("button", { exact: true, name: "Play" }).waitFor();
  await page.waitForFunction(() => document.querySelector("video")?.muted === true);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto(`${origin}/options/connections`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Connect your devices" }).waitFor();
  await page.getByText("Your AniList account stays here.", { exact: false }).waitFor();
  await page.screenshot({ fullPage: true, path: join(output, "connections-desktop.png") });
  await page.setViewportSize({ height: 844, width: 390 });
  const mobile = await page.evaluate(() => ({
    navigationHeight:
      document.querySelector(".settings-navigation")?.getBoundingClientRect().height ?? 0,
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  if (errors.length || mobile.width > mobile.viewport || mobile.navigationHeight > 140) {
    throw new Error(JSON.stringify({ errors, mobile }));
  }
  await page.locator(".settings-main").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ fullPage: true, path: join(output, "connections-mobile.png") });
  await Bun.write(
    join(output, "browser.json"),
    JSON.stringify(
      {
        browser: await browser.version(),
        errors,
        evidence,
        fullscreenEvidence,
        initialPausedEvidence,
        mobile,
        playerLayouts,
        preparationEvidence,
        reenteredPausedEvidence,
        timeoutEvidence,
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify(
      {
        browser: await browser.version(),
        errors,
        evidence,
        fullscreenEvidence,
        initialPausedEvidence,
        mobile,
        output,
        playerLayouts,
        preparationEvidence,
        reenteredPausedEvidence,
        timeoutEvidence,
      },
      null,
      2
    )
  );
} catch (cause) {
  console.error(
    await page.evaluate(() => {
      const video = document.querySelector("video");
      return {
        fullscreen: !!document.fullscreenElement,
        pausedPicture: window.tofuPausedPicture,
        text: document.body.innerText,
        video: video
          ? {
              height: video.videoHeight,
              muted: video.muted,
              paused: video.paused,
              ready: video.readyState,
              width: video.videoWidth,
            }
          : null,
      };
    })
  );
  await page.screenshot({ path: join(output, "proof-failure.png") });
  throw cause;
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
