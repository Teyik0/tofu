// biome-ignore-all lint/performance/noAwaitInLoops: wait for observable native lifecycle and real peers.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { desktopLauncher, hostDesktopTarget } from "../src/platform";
import type { DashboardState, DesktopState, ServerInfo } from "../src/types";
import { fixture, json, waitFor } from "../tests/helpers";
import { nativeRequest } from "./native-request";

const root = join(import.meta.dir, "..");
const context = await fixture(4 * 1024 * 1024, []);
let ready: (report: { passed: boolean; error?: string }) => void = () => undefined;
const uiReady = new Promise<{ passed: boolean; error?: string }>((resolve) => {
  ready = resolve;
});
const collector = Bun.serve({
  async fetch(request) {
    ready(await request.json());
    return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
  },
  hostname: "127.0.0.1",
  port: 0,
});
const script = join(context.directory, "background-ui.js");
await Bun.write(
  script,
  `(${configureBackground.toString()})(${JSON.stringify(`http://127.0.0.1:${collector.port}`)})`
);
const native = Bun.spawn([desktopLauncher(root, hostDesktopTarget(), "dev")], {
  cwd: root,
  env: {
    ...process.env,
    TOFU_DATA_DIR: join(context.directory, "native-state"),
    TOFU_DOWNLOAD_DIR: join(context.directory, "native-downloads"),
    TOFU_MODE: "desktop",
    TOFU_SMOKE_SCRIPT: script,
  },
  stderr: "pipe",
  stdout: "pipe",
});
const stdout = new Response(native.stdout).text();
const stderr = new Response(native.stderr).text();
const deadline = setTimeout(
  () => ready({ error: "The native preferences flow did not complete", passed: false }),
  25_000
);
const checks: string[] = [];
try {
  const report = await uiReady;
  clearTimeout(deadline);
  if (!report.passed) {
    throw new Error(report.error);
  }
  checks.push("Preference enabled and saved from the native WebView");
  const server: ServerInfo = await Bun.file(
    join(context.directory, "native-state/server.json")
  ).json();
  const call = async (path: string, init: RequestInit | undefined) => {
    const response = await nativeRequest(server, `/api${path}`, init);
    if (!response.ok) {
      throw new Error(`${path}: ${await response.text()}`);
    }
    return response;
  };
  const dashboard = async () => (await (await call("/state", undefined)).json()) as DashboardState;
  const desktop = async () => (await (await call("/desktop", undefined)).json()) as DesktopState;
  const initial = await dashboard();
  await call("/settings", {
    ...json({ ...initial.settings, runInBackground: false }),
    method: "PUT",
  });
  const refused = await nativeRequest(server, "/api/desktop/background", json({}));
  if (refused.status !== 409 || (await desktop()).windows !== 1) {
    throw new Error("Closing must be refused without consent to background mode");
  }
  await call("/settings", {
    ...json({ ...initial.settings, downloadLimit: 4096, runInBackground: true }),
    method: "PUT",
  });
  const { id }: { id: string } = await (
    await call("/torrents", json({ paused: false, source: context.magnet }))
  ).json();
  await waitFor(dashboard, (state) =>
    state.torrents.some(
      (torrent) => torrent.id === id && torrent.downloaded > 0 && torrent.progress < 1
    )
  );
  await call("/desktop/background", json({}));
  const background = await waitFor(desktop, (state) => state.windows === 0 && state.webviews === 0);
  if (!background.trayVisible) {
    throw new Error("The menu icon must remain available");
  }
  checks.push("Window and WebView destroyed, menu icon preserved");
  await call("/automation", undefined);
  await call("/settings", {
    ...json({ ...initial.settings, runInBackground: true }),
    method: "PUT",
  });
  await waitFor(dashboard, (state) =>
    state.torrents.some((torrent) => torrent.id === id && torrent.progress === 1)
  );
  const bytes = await (await call(`/torrents/${id}/files/0/content`, undefined)).arrayBuffer();
  if (Bun.SHA256.hash(bytes, "hex") !== Bun.SHA256.hash(context.bytes, "hex")) {
    throw new Error("The background transfer is incomplete");
  }
  checks.push("Automation API available and real transfer completed without UI, identical SHA-256");
  await call("/desktop/open", json({}));
  await call("/desktop/open", json({}));
  await waitFor(
    desktop,
    (state) => state.windows === 1 && state.webviews === 1 && !state.background
  );
  checks.push("Single native reopening with the same server and transfers");
  await mkdir(join(root, ".cache"), { recursive: true });
  const result = JSON.stringify({ checks, passed: true }, null, 2);
  await Bun.write(join(root, ".cache/native-background-smoke.json"), result);
  console.log(result);
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  clearTimeout(deadline);
  native.kill("SIGTERM");
  await native.exited;
  if (process.exitCode) {
    console.error(await stdout, await stderr);
  }
  collector.stop(true);
  await context.close();
}

async function configureBackground(reportUrl: string) {
  const wait = async (condition: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Native element unavailable : ${condition.toString()}`);
  };
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.getAttribute("aria-label") === text || item.textContent?.trim() === text
    );
  try {
    await wait(() => Boolean(button("Settings")));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const preferences = button("Settings");
    preferences?.focus();
    preferences?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    preferences?.click();
    await wait(() => Boolean(document.querySelector("#run-in-background")));
    if (!document.body.textContent?.includes("Updates")) {
      throw new Error("Updates panel missing");
    }
    document.querySelector<HTMLButtonElement>("#run-in-background")?.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    button("Save")?.click();
    await wait(
      async () => (await (await fetch("/api/state")).json()).settings.runInBackground === true
    );
    await fetch(reportUrl, { body: JSON.stringify({ passed: true }), method: "POST" });
  } catch (error) {
    await fetch(reportUrl, {
      body: JSON.stringify({ error: String(error), passed: false }),
      method: "POST",
    });
  }
}
