// biome-ignore-all lint/style/noNonNullAssertion: missing UI controls must fail the native benchmark.
// biome-ignore-all lint/performance/noAwaitInLoops: measure clicks sequentially during real parallel downloads.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebTorrent, { type Torrent } from "webtorrent";
import { desktopLauncher, hostDesktopTarget } from "../src/platform";

const root = join(import.meta.dir, "..");
const folder = await mkdtemp(join(tmpdir(), "tofu-latency-"));
const seeder = new WebTorrent({
  dht: false,
  lsd: false,
  natPmp: false,
  natUpnp: false,
  tracker: false,
  utp: false,
});
const magnets: string[] = [];
for (let index = 0; index < 4; index += 1) {
  const path = join(folder, `Charge ${index + 1}.bin`);
  await Bun.write(path, randomBytes(16 * 1024 * 1024));
  const options = { announce: [], pieceLength: 16_384 };
  const seed = await new Promise<Torrent>((resolve) => seeder.seed(path, options, resolve));
  magnets.push(`${seed.magnetURI}&x.pe=127.0.0.1:${seeder.torrentPort}`);
}
let resolveReport: (report: string) => void = () => undefined;
const report = new Promise<string>((resolve) => {
  resolveReport = resolve;
});
const collector = Bun.serve({
  async fetch(request) {
    const body = await request.text();
    if (new URL(request.url).pathname === "/progress") {
      console.log(body);
      if (body.includes("ready")) {
        const info = (await Bun.file(join(folder, "state/server.json")).json()) as { pid: number };
        const focus = Bun.spawn(
          [
            "swift",
            "-e",
            `import AppKit; let app = NSRunningApplication(processIdentifier: ${info.pid}); app?.unhide(); app?.activate(options: [.activateIgnoringOtherApps])`,
          ],
          { stderr: "ignore", stdout: "ignore" }
        );
        await focus.exited;
      }
    } else {
      resolveReport(body);
    }
    return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
  },
  hostname: "127.0.0.1",
  port: 0,
});
const script = join(folder, "workflow.js");
await Bun.write(
  script,
  `(${workflow.toString()})(${JSON.stringify({ magnets, reportUrl: `http://127.0.0.1:${collector.port}` })})`
);
const native = Bun.spawn([desktopLauncher(root, hostDesktopTarget(), "dev")], {
  cwd: root,
  env: {
    ...process.env,
    TOFU_DATA_DIR: join(folder, "state"),
    TOFU_DOWNLOAD_DIR: join(folder, "downloads"),
    TOFU_MODE: "desktop",
    TOFU_SMOKE_SCRIPT: script,
  },
  stderr: "pipe",
  stdout: "pipe",
});
const timeout = setTimeout(
  () => resolveReport(JSON.stringify({ error: "Native benchmark timed out", passed: false })),
  60_000
);
try {
  const value = await report;
  const label = process.argv[2] ?? "after";
  await Bun.write(join(root, `.cache/native-latency-${label}.json`), value);
  console.log(value);
  process.exitCode = (JSON.parse(value) as { passed: boolean }).passed ? 0 : 1;
} finally {
  clearTimeout(timeout);
  native.kill("SIGTERM");
  await native.exited;
  await Bun.write(
    join(root, ".cache/native-latency.log"),
    `${await new Response(native.stdout).text()}\n${await new Response(native.stderr).text()}`
  );
  collector.stop(true);
  await new Promise<void>((resolve) => seeder.destroy(() => resolve()));
  await rm(folder, { force: true, recursive: true });
}

async function workflow(config: { magnets: string[]; reportUrl: string }) {
  const wait = async (condition: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timeout: ${condition.toString()}`);
  };
  const frame = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The WebView stopped producing frames")),
        2000
      );
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  const state = async () =>
    (await (await fetch("/api/state")).json()) as import("../src/types").DashboardState;
  const step = (phase: string) =>
    fetch(`${config.reportUrl}/progress`, {
      body: JSON.stringify({
        focused: document.hasFocus(),
        phase,
        visibility: document.visibilityState,
      }),
      method: "POST",
    });
  const metrics = { details: [] as number[], selection: [] as number[] };
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    await step("ready");
    await fetch("/api/settings", {
      body: JSON.stringify({ ...(await state()).settings, downloadLimit: 512 * 1024 }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    for (const source of config.magnets) {
      await fetch("/api/torrents", {
        body: JSON.stringify({ paused: false, source }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }
    await wait(() => document.querySelectorAll(".torrent-select").length === 4);
    await wait(async () => {
      const data = await state();
      return data.torrents.every((t) => t.peers > 0 && t.downloaded > 0 && t.progress < 1);
    });
    await step("4 active");
    const names = Array.from(document.querySelectorAll<HTMLButtonElement>(".torrent-select")).map(
      (button) => button.querySelector("strong")!.textContent!
    );
    const select = async (name: string, record: boolean) => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".torrent-select")
      ).find((element) => element.querySelector("strong")?.textContent === name)!;
      const started = performance.now();
      button.click();
      await wait(
        () =>
          document
            .querySelector<HTMLButtonElement>(".torrent-select[aria-pressed=true]")
            ?.querySelector("strong")?.textContent === name
      );
      await frame();
      const highlighted = performance.now() - started;
      await wait(() => document.querySelector(".detail-name strong")?.textContent === name);
      await frame();
      const detailed = performance.now() - started;
      if (record) {
        metrics.selection.push(highlighted);
        metrics.details.push(detailed);
      }
      return detailed;
    };
    for (const name of names) {
      await select(name, false);
      await step(`cached ${name}`);
    }
    for (let index = 0; index < 16; index += 1) {
      await select(names[index % 4]!, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const realFetch = window.fetch.bind(window);
    const delayedFetch = async (input: RequestInfo | URL, init: RequestInit | undefined) => {
      const response = await realFetch(input, init);
      const path = new URL(input instanceof Request ? input.url : input.toString(), location.origin)
        .pathname;
      if (path.startsWith("/api/") || path === "/_furin/data") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return response;
    };
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: delayedFetch,
      writable: true,
    });
    const delayed: number[] = [];
    for (const name of names) {
      delayed.push(await select(name, false));
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const correctSelection =
      document.querySelector(".detail-name strong")?.textContent === names.at(-1);
    window.fetch = realFetch;
    const active = (await state()).torrents.filter(
      (t) => t.peers > 0 && t.progress < 1 && t.downloadSpeed > 0
    ).length;
    const summary = (values: number[]) => {
      const sorted = values.toSorted((a, b) => a - b);
      return {
        max: Math.max(...values),
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      };
    };
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        activeDownloads: active,
        cachedDetailsUnderDelayMs: summary(delayed),
        clicks: 16,
        correctSelectionAfterDelayedResponses: correctSelection,
        delayedResponsesMs: 1000,
        detailsMs: summary(metrics.details),
        passed: active === 4 && correctSelection && Math.max(...delayed) < 250,
        samples: metrics,
        selectionMs: summary(metrics.selection),
        userAgent: navigator.userAgent,
      }),
      method: "POST",
    });
  } catch (error) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({ error: String(error), page: document.body.innerText, passed: false }),
      method: "POST",
    });
  }
}
