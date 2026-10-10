// biome-ignore-all lint/style/noNonNullAssertion: missing DOM targets must fail this end-to-end test immediately.
// biome-ignore-all lint/performance/noAwaitInLoops: wait for real native UI and network events.
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { Server as Tracker } from "bittorrent-tracker";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WebTorrent, { type Torrent } from "webtorrent";
import { acquireInstance, resolveInstanceConfig } from "../src/api/lib/instance";
import { AutomationService } from "../src/api/modules/automation/service";
import { pluginEndpoints } from "../src/api/modules/plugins/service";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";
import { desktopLauncher, hostDesktopTarget } from "../src/platform";
import type { InstanceProfile, ThemePreference } from "../src/types";

const root = join(import.meta.dir, "..");
const folder = await mkdtemp(join(tmpdir(), "tofu-native-"));
const desktopTarget = hostDesktopTarget();
const nativeProfile: InstanceProfile =
  process.env.TOFU_NATIVE_PROFILE === "release" ? "release" : "dev";
const launcher =
  process.env.TOFU_NATIVE_LAUNCHER ?? desktopLauncher(root, desktopTarget, nativeProfile);
const bundle =
  desktopTarget.platform === "macos"
    ? dirname(dirname(dirname(launcher)))
    : dirname(dirname(launcher));
const isolatedBundle = join(folder, basename(bundle));
// Installed bundles must not resolve missing dependencies from the repository.
await cp(bundle, isolatedBundle, { dereference: true, recursive: true });
if (process.env.TOFU_NATIVE_WORKFLOW === "anilist-catalog") {
  try {
    await seedAniListCatalog(folder);
  } catch (error) {
    await rm(folder, { force: true, recursive: true });
    throw error;
  }
}
const source = join(folder, "Real Tofu test.bin");
const payload = randomBytes(256 * 1024);
await Bun.write(source, payload);
const trackers = [
  new Tracker({ http: true, stats: false, udp: false, ws: false }),
  new Tracker({ http: true, stats: false, udp: false, ws: false }),
];
for (const tracker of trackers) {
  await new Promise<void>((resolve) => tracker.listen(0, "127.0.0.1", resolve));
}
const urls = trackers.map((tracker) => {
  const address = tracker.http.address();
  if (!address || typeof address === "string") {
    throw new Error("Tracker not started");
  }
  return `http://127.0.0.1:${address.port}/announce`;
});
const seedClient = new WebTorrent({
  dht: false,
  lsd: false,
  natPmp: false,
  natUpnp: false,
  utp: false,
});
const seed = await new Promise<Torrent>((resolve) =>
  seedClient.seed(source, { announce: urls }, resolve)
);
const secondarySource = join(folder, "Second torrent Tofu.bin");
await Bun.write(secondarySource, payload);
const secondarySeed = await new Promise<Torrent>((resolve) =>
  seedClient.seed(secondarySource, { announce: [] }, resolve)
);
const magnet = `${seed.magnetURI}&x.pe=${encodeURIComponent(`127.0.0.1:${seedClient.torrentPort}`)}`;
let resolveReport: (value: string) => void = () => undefined;
const reportPromise = new Promise<string>((resolve) => {
  resolveReport = resolve;
});
const collector = Bun.serve({
  async fetch(request) {
    const body = await request.text();
    if (new URL(request.url).pathname === "/progress") {
      console.log(body);
    } else if (new URL(request.url).pathname === "/remove-downloaded") {
      await rm(join(folder, "downloads/relocated/Real Tofu test.bin"));
    } else {
      resolveReport(body);
    }
    return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
  },
  hostname: "127.0.0.1",
  port: 0,
});
async function generalPreferencesWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const wait = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 15_000;
    while (!(await condition())) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out: ${condition.toString()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (!passed) {
      throw new Error(name);
    }
  };
  const click = (label: string) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("button, a")).find(
      (item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label
    );
    if (!element) {
      throw new Error(`Navigation item missing: ${label}`);
    }
    element.click();
  };
  const state = async () =>
    (await (await fetch("/api/automation")).json()) as import("../src/types").AutomationState;
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    const initial = await state();
    const created = await fetch("/api/automations", {
      body: JSON.stringify({
        ...initial.preferences,
        destinationId: "default",
        enabled: false,
        includeExisting: false,
        languages: ["VF"],
        matchMode: "exact",
        query: "Existing Show in VF",
        season: null,
        title: "Existing Show",
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      method: "POST",
    });
    check("An existing rule can keep its own preferences", created.ok);
    const createdRule = (await created.json()) as import("../src/types").AutomationRule;
    const existing = (await state()).automations.find((rule) => rule.id === createdRule.id);
    if (!existing) {
      throw new Error("The existing rule is missing from the application state");
    }
    click("Settings");
    await wait(() => location.pathname === "/options");
    document.querySelector<HTMLAnchorElement>('a[href="/options/preferences"]')!.click();
    await wait(() => !!document.querySelector("#preferences-language"));
    check(
      "General preferences open in Options without a thread selector",
      location.pathname === "/options/preferences" &&
        !document.querySelector("#automation-destination") &&
        !document.body.innerText.includes("Changes apply automatically.")
    );
    check(
      "All preference groups are available",
      [
        "preferences-language",
        "preferences-resolution",
        "preferences-codec",
        "preferences-interval",
        "preferences-wait",
        "preferences-deleteReplacedFiles",
      ].every((id) => !!document.getElementById(id))
    );
    check(
      "Unchanged preferences cannot be saved",
      document.querySelector<HTMLButtonElement>('#preferences-form button[type="submit"]')!.disabled
    );
    const language = (name: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("#preferences-language button")).find(
        (item) => item.textContent?.endsWith(name)
      )!;
    language("VOSTFR").click();
    await wait(
      () => document.querySelector("#preferences-language")?.getAttribute("data-value") === "VOSTFR"
    );
    language("VF").click();
    await wait(
      () =>
        document.querySelector("#preferences-language")?.getAttribute("data-value") === "VOSTFR,VF"
    );
    click("Discard changes");
    await wait(
      () => document.querySelector("#preferences-language")?.getAttribute("data-value") === ""
    );
    check("Discard restores saved preferences", (await state()).preferences.languages.length === 0);
    language("VOSTFR").click();
    await wait(
      () => document.querySelector("#preferences-language")?.getAttribute("data-value") === "VOSTFR"
    );
    language("VF").click();
    await wait(
      () =>
        document.querySelector("#preferences-language")?.getAttribute("data-value") === "VOSTFR,VF"
    );
    const input = document.querySelector<HTMLInputElement>("#preferences-wait")!;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "35");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    click("Save preferences");
    await wait(
      () =>
        document
          .querySelector("#preferences-feedback")
          ?.textContent?.includes("Preferences saved.") === true
    );
    const saved = await state();
    check(
      "Saving persists the order and timing",
      saved.preferences.languages.join(",") === "VOSTFR,VF" && saved.preferences.waitMinutes === 35
    );
    check(
      "General preferences preserve existing rule settings",
      Object.entries(existing).every(
        ([key, value]) =>
          JSON.stringify(
            saved.automations.find((rule) => rule.id === existing.id)?.[
              key as keyof typeof existing
            ]
          ) === JSON.stringify(value)
      )
    );
    const interpreted = await fetch("/api/automations/interpret", {
      body: JSON.stringify({ destinationId: "default", query: "New Show" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const draft = (await interpreted.json()) as import("../src/types").AutomationDraft;
    check(
      "New rules use general preferences",
      interpreted.ok && draft.languages.join(",") === "VOSTFR,VF" && draft.waitMinutes === 35
    );
    click("General");
    await wait(
      () => location.pathname === "/options" && !document.querySelector("#preferences-form")
    );
    click("Preferences");
    await wait(() => !!document.querySelector("#preferences-wait"));
    check(
      "Returning to preferences restores saved values",
      document.querySelector("#preferences-language")?.getAttribute("data-value") === "VOSTFR,VF" &&
        document.querySelector<HTMLInputElement>("#preferences-wait")?.value === "35"
    );
    await fetch(config.reportUrl, {
      body: JSON.stringify({ checks, passed: true }),
      method: "POST",
    });
  } catch (error) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  }
}

function smokeWorkflow(name: string | undefined) {
  if (name === "tab-deletion") {
    return { reportName: "native-tab-deletion-smoke", workflow: tabDeletionWorkflow };
  }
  if (name === "theme") {
    return { reportName: "native-theme-smoke", workflow: themeWorkflow };
  }
  if (name === "preferences") {
    return { reportName: "native-preferences-smoke", workflow: preferencesWorkflow };
  }
  if (name === "general-preferences") {
    return { reportName: "native-general-preferences-smoke", workflow: generalPreferencesWorkflow };
  }
  if (name === "plugins") {
    return { reportName: "native-plugins-smoke", workflow: pluginsWorkflow };
  }
  if (name === "anilist-catalog") {
    return { reportName: "native-anilist-catalog-smoke", workflow: anilistCatalogWorkflow };
  }
  if (name === "anilist") {
    return { reportName: "native-anilist-smoke", workflow: anilistWorkflow };
  }
  if (name === "destination") {
    return { reportName: "native-destination-smoke", workflow: destinationWorkflow };
  }
  return { reportName: "native-smoke", workflow: nativeWorkflow };
}
const { workflow, reportName } = smokeWorkflow(process.env.TOFU_NATIVE_WORKFLOW);
const appearanceMarkup = renderToStaticMarkup(
  createElement(
    "div",
    null,
    createElement(Button, { variant: "outline" }, "Appearance test"),
    createElement(Input, { "aria-label": "Appearance test", disabled: true })
  )
);
const browserScript = `(${workflow.toString()})(${JSON.stringify({ appearanceMarkup, expectedHash: createHash("sha256").update(payload).digest("hex"), magnet, reportUrl: `http://127.0.0.1:${collector.port}`, secondaryTorrentBytes: Array.from(secondarySeed.torrentFile), torrentBytes: Array.from(seed.torrentFile), urls })})`;
const scriptPath = join(folder, "workflow.js");
await Bun.write(scriptPath, browserScript);
const native = Bun.spawn([join(isolatedBundle, relative(bundle, launcher))], {
  cwd: folder,
  env: {
    ...process.env,
    TOFU_DATA_DIR: join(folder, "state"),
    TOFU_DOWNLOAD_DIR: join(folder, "downloads"),
    TOFU_MODE: "desktop",
    TOFU_PROFILE: nativeProfile,
    TOFU_SMOKE_SCRIPT: scriptPath,
  },
  stderr: "pipe",
  stdout: "pipe",
});
const nativeStdout = new Response(native.stdout).text();
const nativeStderr = new Response(native.stderr).text();
void native.exited.then(async (code) => {
  resolveReport(
    JSON.stringify({
      error: `The native host exited with code ${code}: ${await nativeStderr}`,
      passed: false,
    })
  );
});
const timeout = setTimeout(
  () =>
    resolveReport(
      JSON.stringify({
        error: "The WebView did not complete the flow within 90 seconds",
        passed: false,
      })
    ),
  90_000
);
try {
  const report = await reportPromise;
  clearTimeout(timeout);
  await mkdir(join(root, ".cache"), { recursive: true });
  await Bun.write(join(root, `.cache/${reportName}.json`), report);
  console.log(report);
  const result = JSON.parse(report) as { passed: boolean };
  process.exitCode = result.passed ? 0 : 1;
} finally {
  native.kill("SIGTERM");
  await native.exited;
  await Bun.write(
    join(root, `.cache/${reportName}.log`),
    `${await nativeStdout}\n${await nativeStderr}`
  );
  collector.stop(true);
  await new Promise<void>((resolve) => seedClient.destroy(() => resolve()));
  for (const tracker of trackers) {
    await new Promise<void>((resolve) => tracker.close(resolve));
  }
  await rm(folder, { force: true, recursive: true });
}

async function seedAniListCatalog(directory: string) {
  const resources = new AsyncDisposableStack();
  const nativeFetch = globalThis.fetch;
  try {
    const lease = await acquireInstance(
      resolveInstanceConfig({
        dataDir: join(directory, "state"),
        desktop: true,
        downloadPath: join(directory, "downloads"),
        homeDir: directory,
        platform: process.platform,
        port: "0",
        profile: nativeProfile,
      })
    );
    resources.defer(() => lease.close());
    const engine = await TorrentEngine.open({
      dataDir: join(directory, "state"),
      downloadPath: join(directory, "downloads"),
      network: {
        dht: false,
        lsd: false,
        natPmp: false,
        natUpnp: false,
        tracker: false,
        utp: false,
      },
    });
    resources.defer(() => engine.close());
    const service = await AutomationService.open({
      dataDir: join(directory, "state"),
      endpoints: pluginEndpoints,
      engine: () => engine,
      now: Date.now,
    });
    resources.defer(() => service.close());
    // Retain the packaged provider's cache identity while seeding through its public service.
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== "https://graphql.anilist.co") {
        return nativeFetch(input, init);
      }
      const body = (await request.json()) as { query: string };
      return Response.json({
        data: body.query.includes("Viewer")
          ? { Viewer: { id: 42, name: "NativeUser" } }
          : {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [
                  {
                    entries: [
                      {
                        media: {
                          episodes: 12,
                          genres: ["Drama"],
                          id: 10,
                          status: "RELEASING",
                          studios: { nodes: [{ name: "Native Studio" }] },
                          synonyms: [],
                          title: { romaji: "Native Library" },
                        },
                        progress: 3,
                        status: "CURRENT",
                      },
                    ],
                  },
                ],
              },
            },
      });
    }, nativeFetch);
    service.configure("anilist", { apiKey: "native-catalog-token", enabled: true });
    await service.anilist.list();
  } finally {
    globalThis.fetch = nativeFetch;
    await resources.disposeAsync();
  }
}

async function tabDeletionWorkflow(config: {
  expectedHash: string;
  magnet: string;
  reportUrl: string;
}) {
  const checks: { name: string; passed: boolean }[] = [];
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  const wait = async (ready: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 15_000;
    while (!(await ready())) {
      if (Date.now() >= until) {
        throw new Error(`Timed out: ${ready.toString()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const state = async () =>
    (await (await fetch("/api/state")).json()) as import("../src/types").DashboardState;
  const click = (text: string) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) => item.textContent?.trim() === text
    );
    if (!button) {
      throw new Error(`Button not found: ${text}`);
    }
    button.click();
  };
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (!passed) {
      throw new Error(name);
    }
  };
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    const original = await state();
    const destination = (await (
      await fetch("/api/destinations", {
        body: JSON.stringify({
          downloadPath: `${original.settings.downloadPath}/series`,
          name: "Deletion test",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    ).json()) as import("../src/types").Destination;
    const torrent = (await (
      await fetch("/api/torrents", {
        body: JSON.stringify({
          destinationId: destination.id,
          paused: false,
          source: config.magnet,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    ).json()) as { id: string };
    await wait(async () =>
      (await state()).torrents.some((item) => item.id === torrent.id && item.progress === 1)
    );
    const link = `[aria-label="Destination tabs"] a[href="/thread/${destination.id}"]`;
    await wait(() => !!document.querySelector(link));
    document.querySelector<HTMLAnchorElement>(link)!.click();
    await wait(() => location.pathname.endsWith(destination.id));
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Edit tab Deletion test"]')!
      .click();
    await wait(() => !!document.querySelector("#destination-name"));
    click("Delete tab");
    await wait(() => !!document.querySelector('[role="alertdialog"][data-open]'));
    click("Cancel");
    await wait(() => !!document.querySelector("#destination-name"));
    check(
      "Cancel preserves the tab",
      (await state()).destinations.some((item) => item.id === destination.id)
    );
    click("Delete tab");
    await wait(() => !!document.querySelector('[role="alertdialog"][data-open]'));
    click("Delete tab");
    await wait(() => location.pathname === "/thread/default");
    await wait(
      async () => !(await state()).destinations.some((item) => item.id === destination.id)
    );
    const detail = (await (
      await fetch(`/api/torrents/${torrent.id}`)
    ).json()) as import("../src/types").TorrentDetail;
    check(
      "Deleting the active tab preserves seeding and reassigns its torrent",
      detail.destinationId === "default" &&
        detail.status === "seeding" &&
        detail.savePath === destination.downloadPath
    );
    const bytes = await (await fetch(`/api/torrents/${torrent.id}/files/0/content`)).arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    check("Deletion preserves exact downloaded bytes", hash === config.expectedHash);
    const quick = (await (
      await fetch("/api/destinations", {
        body: JSON.stringify({
          downloadPath: `${original.settings.downloadPath}/quick`,
          name: "Quick delete",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    ).json()) as import("../src/types").Destination;
    const quickDelete = 'button[aria-label="Delete tab Quick delete"]';
    await wait(() => !!document.querySelector(quickDelete));
    document.querySelector<HTMLButtonElement>(quickDelete)!.click();
    await wait(() => !!document.querySelector('[role="alertdialog"][data-open]'));
    click("Cancel");
    await wait(() => !document.querySelector('[role="alertdialog"][data-open]'));
    check(
      "Sidebar Delete asks for confirmation before deleting a tab",
      (await state()).destinations.some((item) => item.id === quick.id)
    );
    document
      .querySelector<HTMLButtonElement>(quickDelete)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await wait(async () => !(await state()).destinations.some((item) => item.id === quick.id));
    check(
      "Shift-clicking sidebar Delete removes the tab without a dialog",
      !document.querySelector('[role="alertdialog"][data-open]')
    );
    check("No JavaScript errors", errors.length === 0);
    await fetch(config.reportUrl, {
      body: JSON.stringify({ checks, errors, passed: true }),
      method: "POST",
    });
  } catch (cause) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({ checks, error: String(cause), errors, passed: false }),
      method: "POST",
    });
  }
}

async function themeWorkflow(config: { appearanceMarkup: string; reportUrl: string }) {
  const checks: string[] = [];
  const wait = async (ready: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 15_000;
    while (!(await ready())) {
      if (Date.now() >= until) {
        throw new Error(`Timed out: ${ready.toString()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const pickOption = async (selector: string, label: string) => {
    const trigger = document.querySelector<HTMLButtonElement>(selector)!;
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
    );
    await wait(
      () => !!document.querySelector('[data-slot="select-content"][data-open] [role="option"]')
    );
    const option = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-slot="select-content"][data-open] [role="option"]'
      )
    ).find((element) => element.textContent?.trim() === label);
    if (!option) {
      throw new Error(`Option missing: ${label}`);
    }
    option.focus();
    option.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
    option.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter" })
    );
    await wait(() => trigger.getAttribute("aria-expanded") === "false");
  };
  const themeLabels: Record<string, string> = {
    dark: "Dark",
    light: "Light",
    system: "System (default)",
  };
  const assertAppearance = (
    frame: HTMLIFrameElement,
    theme: ThemePreference,
    appearance: "light" | "dark"
  ) => {
    const view = frame.contentWindow!;
    const frameRoot = frame.contentDocument!.documentElement;
    const button = frame.contentDocument!.querySelector("button")!;
    const input = frame.contentDocument!.querySelector("input")!;
    const reference = frame.contentDocument!.querySelector<HTMLElement>("#reference")!;
    const dark = theme === "dark" || (theme === "system" && appearance === "dark");
    if (
      view.getComputedStyle(frameRoot).colorScheme !== (dark ? "dark" : "light") ||
      view.getComputedStyle(frameRoot).backgroundColor !==
        (dark ? "rgb(23, 27, 20)" : "rgb(248, 249, 244)")
    ) {
      throw new Error(`The ${theme} appearance under ${appearance} system colors needs JavaScript`);
    }
    reference.style.borderColor = dark ? "var(--input)" : "var(--border)";
    reference.style.backgroundColor = `color-mix(in oklab, var(--input) ${dark ? 80 : 50}%, transparent)`;
    if (
      view.getComputedStyle(button).borderColor !== view.getComputedStyle(reference).borderColor ||
      view.getComputedStyle(input).backgroundColor !==
        view.getComputedStyle(reference).backgroundColor
    ) {
      throw new Error(
        `Shadcn controls do not follow the ${theme} appearance under ${appearance} system colors`
      );
    }
  };
  const verifyWithoutJavaScript = async () => {
    const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
      .map((element) => element.outerHTML)
      .join("");
    for (const theme of ["dark", "light", "system"] as const) {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.srcdoc = `<html data-theme="${theme}"><head>${styles}</head><body>${config.appearanceMarkup}<div id="reference"></div></body></html>`;
      const loaded = new Promise<void>((resolve) =>
        frame.addEventListener("load", () => resolve(), { once: true })
      );
      document.body.append(frame);
      try {
        await loaded;
        assertAppearance(
          frame,
          theme,
          frame.contentWindow!.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
        );
        checks.push(`${theme} appearance and shadcn controls render without JavaScript`);
      } finally {
        frame.remove();
      }
    }
  };
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    await verifyWithoutJavaScript();
    let previous = "system";
    for (const theme of ["dark", "light", "system"]) {
      await wait(() => {
        if (document.querySelector(".settings-page")) {
          return true;
        }
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (item) => item.getAttribute("aria-label") === "Settings"
        );
        button?.focus();
        button?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        button?.click();
        return false;
      });
      document.querySelector<HTMLAnchorElement>('a[href="/options/appearance"]')!.click();
      await wait(() => !!document.querySelector("#appearance-theme"));
      const select = document.querySelector<HTMLButtonElement>("#appearance-theme")!;
      if (select.textContent?.trim() !== themeLabels[previous]) {
        throw new Error("The appearance selector did not restore the saved choice");
      }
      await pickOption("#appearance-theme", themeLabels[theme]!);
      await wait(async () => (await (await fetch("/api/settings")).json()).theme === theme);
      document.querySelector<HTMLButtonElement>(".settings-back")!.click();
      await wait(() => !document.querySelector("#appearance-theme"));
      await wait(() => document.documentElement.dataset.theme === theme);
      const dark =
        theme === "dark" ||
        (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
      if (
        getComputedStyle(document.documentElement).backgroundColor !==
          (dark ? "rgb(23, 27, 20)" : "rgb(248, 249, 244)") ||
        getComputedStyle(document.documentElement).colorScheme !== (dark ? "dark" : "light")
      ) {
        throw new Error(`The ${theme} appearance was not applied`);
      }
      const settings = (await (
        await fetch("/api/settings")
      ).json()) as import("../src/types").Settings;
      const html = new DOMParser().parseFromString(await (await fetch("/")).text(), "text/html");
      if (settings.theme !== theme || html.documentElement.dataset.theme !== theme) {
        throw new Error(`The ${theme} appearance was not persisted for the next page load`);
      }
      checks.push(`${theme} appearance selected, saved, restored and styled in the native WebView`);
      previous = theme;
    }
    const settings = (await (
      await fetch("/api/settings")
    ).json()) as import("../src/types").Settings;
    const updated = await fetch("/api/settings", {
      body: JSON.stringify({ ...settings, theme: "dark" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    if (!updated.ok) {
      throw new Error("Unable to save appearance outside the settings form");
    }
    await wait(
      () =>
        document.documentElement.dataset.theme === "dark" &&
        getComputedStyle(document.documentElement).backgroundColor === "rgb(23, 27, 20)" &&
        getComputedStyle(document.documentElement).colorScheme === "dark"
    );
    checks.push("External appearance changes reach the theme store through Furin Sync");
    await fetch(config.reportUrl, {
      body: JSON.stringify({ checks, passed: true }),
      method: "POST",
    });
  } catch (error) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  }
}

async function nativeWorkflow(config: {
  magnet: string;
  secondaryTorrentBytes: number[];
  torrentBytes: number[];
  urls: string[];
  reportUrl: string;
  expectedHash: string;
}) {
  const checks: { name: string; passed: boolean }[] = [];
  const errors: string[] = [];
  const layoutWarnings: string[] = [];
  window.addEventListener("error", (event) => {
    // WebKit reports deferred ResizeObserver layout notifications without a JavaScript exception.
    if (
      event.error === null &&
      event.lineno === 0 &&
      event.message === "ResizeObserver loop completed with undelivered notifications."
    ) {
      layoutWarnings.push(event.message);
    } else {
      errors.push(event.message);
    }
  });
  window.addEventListener("unhandledrejection", (event) =>
    errors.push(`${String(event.reason)}\n${event.reason?.stack ?? ""}`)
  );
  const wait = async (condition: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out : ${condition.toString()}`);
  };
  const click = (text: string) => {
    const button = Array.from(
      document.querySelectorAll<HTMLElement>('button, a, [role="menuitem"]')
    ).find(
      (element) =>
        element.getAttribute("aria-label") === text || element.textContent?.trim() === text
    );
    if (!button) {
      throw new Error(`Button missing: ${text}`);
    }
    button.focus();
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    button.click();
  };
  const set = (
    element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    value: string
  ) => {
    const prototype = Object.getPrototypeOf(element);
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    void fetch(`${config.reportUrl}/progress`, {
      body: JSON.stringify({ name, passed }),
      method: "POST",
    });
    if (!passed) {
      throw new Error(name);
    }
  };
  const state = async () =>
    (await (await fetch("/api/state")).json()) as import("../src/types").DashboardState;
  const verifyShortcuts = () => {
    const shortcuts = document.querySelector('[aria-label="Sidebar shortcuts"]');
    const appIcons = Array.from(document.querySelectorAll(".sidebar-app-shortcut"));
    const brand = document.querySelector(
      '[data-slot="sidebar-header"] .sidebar-brand-row > a.sidebar-brand'
    );
    return (
      brand?.getAttribute("href") === "/" &&
      brand.getAttribute("aria-label") === "All torrents" &&
      !!brand.querySelector("img") &&
      brand.textContent?.trim() === "Tofu" &&
      !!shortcuts?.querySelector('a[aria-label="AniList"][href="/anilist"] svg') &&
      !shortcuts.querySelector('a[aria-label="AniList"]')?.textContent?.trim() &&
      appIcons.length === 1 &&
      appIcons.every((link) => {
        const style = getComputedStyle(link);
        const active = link.getAttribute("aria-current") === "page";
        return (
          style.backgroundColor === "rgba(0, 0, 0, 0)" &&
          style.boxShadow === "none" &&
          Number(getComputedStyle(link, "::before").opacity) > 0 === active
        );
      }) &&
      document.querySelectorAll('a[href="/"]').length === 1
    );
  };
  const verifyThreadPresentation = async (id: string, path: string, pinned: boolean) => {
    const thread = (await state()).destinations.find((tab) => tab.id === id);
    const group = pinned ? "Sidebar shortcuts" : "Destination tabs";
    const link = document.querySelector<HTMLAnchorElement>(
      `[aria-label="${group}"] a[href="/thread/${id}"]`
    );
    return (
      !!link?.querySelector(".lucide-film") &&
      !(pinned && link.textContent?.trim()) &&
      thread?.pinned === pinned &&
      thread.icon === "film" &&
      thread.downloadPath === path
    );
  };
  const choose = async (selector: string, label: string) => {
    await fetch("/api/desktop/open", { method: "POST" });
    await wait(() => document.visibilityState === "visible");
    const trigger = document.querySelector<HTMLButtonElement>(selector)!;
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
    );
    await wait(
      () => !!document.querySelector('[data-slot="select-content"][data-open] [role="listbox"]')
    );
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () =>
          reject(
            new Error(
              `The WebView is not producing frames : ${JSON.stringify({ focused: document.hasFocus(), visibility: document.visibilityState })}`
            )
          ),
        2000
      );
      requestAnimationFrame(() => {
        clearTimeout(deadline);
        resolve();
      });
    });
    trigger.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "ArrowDown" })
    );
    const option = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-slot="select-content"][data-open] [role="option"]'
      )
    ).find((element) => element.textContent?.trim() === label);
    if (!option) {
      throw new Error(`Option missing: ${label}`);
    }
    option.focus();
    await wait(() => document.activeElement === option);
    option.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
    option.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter" })
    );
    await wait(
      () =>
        trigger.getAttribute("aria-expanded") === "false" &&
        Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).every(
          (list) => list.getClientRects().length === 0
        )
    ).catch((cause: unknown) => {
      const popup = document.querySelector<HTMLElement>('[data-slot="select-content"]');
      throw new Error(
        `Select dismissal : ${JSON.stringify({
          animation: popup && getComputedStyle(popup).animation,
          animations: popup?.getAnimations().map((animation) => ({
            playState: animation.playState,
            timing: animation.effect?.getComputedTiming(),
          })),
          expanded: trigger.getAttribute("aria-expanded"),
          popup: popup?.outerHTML.slice(0, 1800),
        })}`,
        { cause }
      );
    });
    await wait(() => trigger.textContent?.trim() === label);
  };
  const verifyAppearance = async () => {
    await wait(() => getComputedStyle(document.documentElement).colorScheme === "dark");
    check(
      "Dark appearance is saved and applied in the native WebView",
      (await state()).settings.theme === "dark"
    );
    const loaded = new DOMParser().parseFromString(await (await fetch("/")).text(), "text/html");
    check(
      "Saved dark appearance is present before hydration",
      loaded.documentElement.dataset.theme === "dark"
    );
    for (const theme of ["light", "system"] as const) {
      click("Settings");
      await wait(() => !!document.querySelector(".settings-page"));
      click("Appearance");
      await wait(() => !!document.querySelector("#appearance-theme"));
      check(
        "The appearance selector restores the saved choice",
        document.querySelector("#appearance-theme")!.textContent?.trim() ===
          (theme === "light" ? "Dark" : "Light")
      );
      await choose("#appearance-theme", theme === "light" ? "Light" : "System (default)");
      await wait(async () => (await (await fetch("/api/settings")).json()).theme === theme);
      document.querySelector<HTMLButtonElement>(".settings-back")!.click();
      await wait(() => !document.querySelector("#appearance-theme"));
      await wait(() => document.documentElement.dataset.theme === theme);
      check(
        `${theme} appearance is saved and resolved correctly`,
        (await state()).settings.theme === theme &&
          getComputedStyle(document.documentElement).colorScheme ===
            (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches
              ? "dark"
              : "light")
      );
    }
  };
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    await fetch("/api/desktop/open", { method: "POST" });
    await document.fonts.ready;
    await wait(
      () =>
        getComputedStyle(document.querySelector('[data-slot="sidebar-container"]')!).width ===
          "190px" && getComputedStyle(document.documentElement).fontFamily.includes("system-ui")
    );
    // The status bar only shows a port once the engine is listening.
    const enginePort = Number(
      document.querySelector(".status-port")!.textContent!.replace("Port ", "")
    );
    check("React hydrated and engine connected", enginePort > 0);
    check(
      "Filtering and sorting use accessible Select controls",
      document.querySelector('[aria-label="Filter torrents by status"]')?.getAttribute("role") ===
        "combobox" &&
        document.querySelector('[aria-label="Sort torrents"]')?.getAttribute("role") === "combobox"
    );
    check(
      "Styles and system font loaded",
      getComputedStyle(document.querySelector('[data-slot="sidebar-container"]')!).width ===
        "190px" && getComputedStyle(document.documentElement).fontFamily.includes("system-ui")
    );
    check("The Tofu logo opens all torrents and AniList stays an icon shortcut", verifyShortcuts());
    const content = document.querySelector("main")!;
    const contentBounds = content.getBoundingClientRect();
    const navigationBounds = document
      .querySelector('[data-slot="sidebar-container"]')!
      .getBoundingClientRect();
    check(
      "Inset content rounded and spaced without sidebar overlap",
      document.querySelectorAll("main").length === 1 &&
        contentBounds.left >= navigationBounds.right &&
        contentBounds.top > 0 &&
        contentBounds.right < window.innerWidth &&
        Number.parseFloat(getComputedStyle(content).borderTopLeftRadius) > 0
    );
    check(
      "Engine data present in HTML before JavaScript",
      (await (await fetch("/")).text()).includes(`class="status-port">Port <b>${enginePort}</b>`)
    );
    await wait(() =>
      performance
        .getEntriesByType("resource")
        .some((entry) => entry.name.includes("/_furin/sync/changes"))
    );
    check(
      "Statistics refreshed by Furin Sync without browser API polling",
      !performance.getEntriesByType("resource").some((entry) => entry.name.includes("/api/state"))
    );
    const settingsAction = document.querySelector<HTMLButtonElement>(
      '[data-slot="sidebar-footer"] button[aria-label="Settings"]'
    );
    const pluginsAction = document.querySelector<HTMLButtonElement>(
      '[data-slot="sidebar-footer"] button[aria-label="Plugins"]'
    );
    const updateAction = document.querySelector<HTMLButtonElement>(
      '[data-slot="sidebar-footer"] button[aria-label="Check for updates"]'
    );
    check(
      "Sidebar has compact Settings and Plugins icons with updates on the right",
      !!settingsAction &&
        !!pluginsAction &&
        !!updateAction &&
        !settingsAction.textContent?.trim() &&
        !pluginsAction.textContent?.trim() &&
        settingsAction.getBoundingClientRect().left < pluginsAction.getBoundingClientRect().left &&
        pluginsAction.getBoundingClientRect().right < updateAction.getBoundingClientRect().left &&
        Math.abs(
          settingsAction.getBoundingClientRect().top - updateAction.getBoundingClientRect().top
        ) < 1
    );
    await wait(
      () =>
        document.querySelector<HTMLButtonElement>(
          '[data-slot="sidebar-footer"] button[aria-label="Check for updates"]'
        )?.disabled === false
    );
    check(
      "The update action stays enabled without any GitHub access configuration",
      !document.querySelector("#release-token")
    );
    await choose('[aria-label="Sort torrents"]', "Name");
    await choose('[aria-label="Sort torrents"]', "Newest first");
    check("Select controls support keyboard selection and dismissal", true);
    const sidebarToggle = document.querySelector<HTMLButtonElement>(
      '.sidebar-brand-row button[aria-label="Toggle sidebar"]'
    )!;
    check("Sidebar toggle sits next to the Tofu logo", sidebarToggle !== null);
    check(
      "The topbar toggle is reserved for the mobile sidebar",
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '.library-topbar button[aria-label="Toggle sidebar"]'
        )
      ).every((button) => button.getClientRects().length === 0)
    );
    // WebKit tracks keyboard modality separately from programmatic focus.
    (document.activeElement as HTMLElement | null)?.blur();
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    sidebarToggle.focus();
    await wait(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"][data-open]')
      ).some(
        (tooltip) => tooltip.textContent === "Toggle sidebar" && tooltip.getClientRects().length > 0
      )
    );
    check("Icon action tooltips visible on keyboard focus", true);
    sidebarToggle.blur();
    const originalPath = (await state()).settings.downloadPath;
    await fetch("/api/destinations", {
      body: JSON.stringify({ downloadPath: originalPath, name: "Sync" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await wait(() =>
      Array.from(document.querySelectorAll('[aria-label="Destination tabs"] a')).some(
        (link) => link.textContent?.trim() === "Sync"
      )
    );
    check("An external change appears automatically through Sync", true);
    const createTab = async (name: string) => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Create a tab"]')!.click();
      await wait(() => !!document.querySelector('[role="dialog"][data-open]'));
      set(document.querySelector<HTMLInputElement>("#destination-name")!, name);
      set(document.querySelector<HTMLInputElement>("#destination-path")!, originalPath);
      await new Promise((resolve) => setTimeout(resolve, 100));
      document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit();
      await wait(async () => (await state()).destinations.some((tab) => tab.name === name));
      await wait(() => !document.querySelector('[role="dialog"][data-open]'));
      await wait(() => document.body.innerText.includes(name));
    };
    await createTab("Series");
    await createTab("Following");
    const shared = (await state()).destinations.filter((tab) =>
      ["Series", "Following"].includes(tab.name)
    );
    check(
      "Two independent tabs with the same folder",
      shared.length === 2 &&
        shared[0]!.id !== shared[1]!.id &&
        shared.every((tab) => tab.downloadPath === originalPath)
    );
    const seriesId = shared.find((tab) => tab.name === "Series")!.id;
    const threadMenu = async () => {
      await fetch("/api/desktop/open", { method: "POST" });
      const link = document.querySelector<HTMLElement>(
        `[data-slot="sidebar"] a[href="/thread/${seriesId}"]`
      )!;
      const bounds = link.getBoundingClientRect();
      link.focus();
      link.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          cancelable: true,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
        })
      );
      await wait(() => !!document.querySelector('[data-slot="context-menu-content"][data-open]'));
    };
    await threadMenu();
    click("Change icon…");
    await wait(() => !!document.querySelector('[aria-label="Thread icon"]'));
    document.querySelector<HTMLElement>('label[title="Film icon"]')!.click();
    await wait(
      () =>
        document.querySelector('[aria-label="Film icon"]')?.getAttribute("aria-checked") === "true"
    );
    document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit();
    await wait(() => !document.querySelector('[aria-label="Thread icon"]'));
    await threadMenu();
    click("Pin thread");
    const pinnedLink = () =>
      document.querySelector<HTMLAnchorElement>(
        `[aria-label="Sidebar shortcuts"] a[href="/thread/${seriesId}"]`
      );
    await wait(() => !!pinnedLink());
    check(
      "Pinning moves a thread into the icon group with the chosen icon and preserves its folder",
      (await verifyThreadPresentation(seriesId, originalPath, true)) &&
        !document.querySelector(`[aria-label="Destination tabs"] a[href="/thread/${seriesId}"]`)
    );
    click("Series");
    await wait(() => location.pathname.endsWith(seriesId));
    const sidebar = document.querySelector('[data-slot="sidebar-container"]');
    document.querySelector<HTMLButtonElement>('button[aria-label="Toggle sidebar"]')!.click();
    await wait(
      () =>
        document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state") === "collapsed"
    );
    const sidebarIconsCentered = () => {
      const bounds = sidebar!.getBoundingClientRect();
      const center = bounds.left + bounds.width / 2;
      const icons = Array.from(sidebar!.querySelectorAll("svg, img")).filter(
        (icon) => icon.getBoundingClientRect().width > 0
      );
      return (
        icons.length >= 5 &&
        icons.every((icon) => {
          const iconBounds = icon.getBoundingClientRect();
          return Math.abs(iconBounds.left + iconBounds.width / 2 - center) < 1;
        })
      );
    };
    await wait(sidebarIconsCentered).catch(() => {
      const bounds = sidebar!.getBoundingClientRect();
      const offsets = Array.from(sidebar!.querySelectorAll("svg, img")).map((icon) => {
        const iconBounds = icon.getBoundingClientRect();
        return {
          label: icon.parentElement?.textContent,
          offset: iconBounds.left + iconBounds.width / 2 - bounds.left - bounds.width / 2,
          width: iconBounds.width,
        };
      });
      throw new Error(
        `Sidebar centering : ${JSON.stringify({ connected: sidebar!.isConnected, disk: getComputedStyle(document.querySelector(".sidebar-disk")!).display, offsets, root: sidebar!.parentElement?.outerHTML.slice(0, 300), width: bounds.width })}`
      );
    });
    check("Collapsed sidebar icons centered with symmetric margins", true);
    check(
      "Collapsed navigation icons are larger while utility actions keep their compact size",
      Array.from(sidebar!.querySelectorAll("svg, img"))
        .filter((icon) => icon.getBoundingClientRect().width > 0)
        .every((icon) => {
          const bounds = icon.getBoundingClientRect();
          let size = icon.closest('[data-sidebar="menu-button"]') ? 20 : 18;
          if (icon.closest(".sidebar-brand")) {
            size = 28;
          }
          return bounds.width === size && bounds.height === size;
        })
    );
    await threadMenu();
    click("Unpin thread");
    await wait(() => !pinnedLink());
    check(
      "Unpinning from a collapsed sidebar restores the thread row and retains its icon",
      await verifyThreadPresentation(seriesId, originalPath, false)
    );
    const followedId = shared.find((tab) => tab.name === "Following")!.id;
    click("Following");
    await wait(() => location.pathname === `/thread/${followedId}`);
    check(
      "Furin navigation preserves the layout and compact sidebar",
      document.querySelector('[data-slot="sidebar-container"]') === sidebar &&
        document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state") === "collapsed"
    );
    history.back();
    await wait(() => !location.pathname.endsWith(followedId));
    check(
      "Browser back restores the previous destination",
      document.querySelector(".library-title")?.textContent?.includes("Series") === true
    );
    click("Following");
    await wait(() => location.pathname.endsWith(followedId));
    document.querySelector<HTMLButtonElement>('button[aria-label="Toggle sidebar"]')!.click();
    click("Add a torrent");
    await wait(() => !!document.querySelector('[role="dialog"][data-open]'));
    check(
      "Destination inherited from the selected tab",
      document.querySelector("#torrent-destination")!.textContent?.trim() === "Following"
    );
    const fileZone = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Choose a .torrent file"]'
    )!;
    const uploadTransfer = new DataTransfer();
    uploadTransfer.items.add(
      new File([new Uint8Array(config.torrentBytes)], "test.torrent", {
        type: "application/x-bittorrent",
      })
    );
    fileZone.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: uploadTransfer })
    );
    await wait(() => document.querySelector("[data-file-name]")?.textContent === "test.torrent");
    document.body.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: uploadTransfer })
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    check(
      "Dropping a file in the form waits for confirmation and preserves the destination",
      (await state()).torrents.length === 0 &&
        document.querySelector<HTMLInputElement>("#torrent-source")!.disabled
    );
    click("Remove file");
    await wait(() => !document.querySelector<HTMLInputElement>("#torrent-source")!.disabled);
    await wait(
      () => !!document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')
    );
    set(document.querySelector<HTMLInputElement>("#torrent-source")!, config.magnet);
    await new Promise((resolve) => setTimeout(resolve, 100));
    document
      .querySelector<HTMLFormElement>('[role="dialog"] form, [role="alertdialog"] form')!
      .requestSubmit();
    await wait(async () => (await state()).detail?.progress === 1);
    await wait(
      () => !document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')
    );
    check(
      "Magnet added through the form",
      document.querySelectorAll(".torrent-table tbody tr").length === 1
    );
    check(
      "Download directly into the target folder",
      (await state()).detail?.savePath === originalPath
    );
    const secondForm = new FormData();
    secondForm.set(
      "file",
      new File([new Uint8Array(config.secondaryTorrentBytes)], "second.torrent")
    );
    secondForm.set("paused", "true");
    secondForm.set("destinationId", followedId);
    const secondResponse = await fetch("/api/torrents/file", { body: secondForm, method: "POST" });
    const second = (await secondResponse.json()) as { id: string };
    await wait(() => document.querySelectorAll(".torrent-table tbody tr").length === 2);
    const secondRow = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".torrent-select")
    ).find((button) => button.textContent?.includes("Second torrent Tofu.bin"))!;
    secondRow.click();
    await wait(
      () =>
        document.querySelector(".detail-pane")?.textContent?.includes("Second torrent Tofu.bin") ===
        true
    );
    set(
      document.querySelector<HTMLInputElement>('[aria-label="Search torrents"]')!,
      "Real Tofu test"
    );
    await wait(() => document.querySelectorAll(".torrent-table tbody tr").length === 1);
    await wait(
      () =>
        document.querySelector(".detail-pane")?.textContent?.includes("Real Tofu test.bin") === true
    );
    check(
      "Search selects a visible torrent and preserves its details",
      document.querySelector('.torrent-select[aria-pressed="true"]') !== null
    );
    set(document.querySelector<HTMLInputElement>('[aria-label="Search torrents"]')!, "");
    await fetch(`/api/torrents/${second.id}`, {
      body: JSON.stringify({ deleteFiles: false }),
      headers: { "content-type": "application/json" },
      method: "DELETE",
    });
    await wait(() => document.querySelectorAll(".torrent-table tbody tr").length === 1);
    await wait(() =>
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Trackers2"
      )
    );
    click("Trackers2");
    await wait(() => document.querySelectorAll(".inner-table tbody tr").length === 2);
    await wait(
      async () => (await state()).detail?.trackers.every((row) => row.status === "working") === true
    );
    check("Real trackers and statistics", document.body.textContent?.includes("Sources") === true);
    document
      .querySelector<HTMLButtonElement>(`button[aria-label="Remove ${config.urls[0]}"]`)!
      .click();
    await wait(async () => (await state()).detail?.trackers.length === 1);
    click("Manage trackers");
    await wait(
      () => !!document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')
    );
    set(
      document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!,
      config.urls.join("\n")
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    document
      .querySelector<HTMLFormElement>('[role="dialog"] form, [role="alertdialog"] form')!
      .requestSubmit();
    await wait(async () => (await state()).detail?.trackers.length === 2);
    await wait(
      () => !document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')
    );
    check("Remove, edit, and add trackers through the UI", true);
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Pause Real Tofu test.bin"]')!
      .click();
    await wait(async () => (await state()).detail?.status === "paused");
    await wait(() => !!document.querySelector('button[aria-label="Resume Real Tofu test.bin"]'));
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Resume Real Tofu test.bin"]')!
      .click();
    await wait(async () => (await state()).detail?.status === "seeding");
    check("Native pause and resume", true);
    click("Files1");
    await wait(() => !!document.querySelector('.inner-table [role="combobox"]'));
    await choose('.inner-table [role="combobox"]', "High");
    await wait(async () => (await state()).detail?.files[0]?.priority === "high");
    const detail = (await state()).detail!;
    const bytes = await (await fetch(`/api/torrents/${detail.id}/files/0/content`)).arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    check("File priority and exact SHA-256 data", hash === config.expectedHash);
    const initialTorrent = (await state()).detail!;
    document.querySelector<HTMLButtonElement>('button[aria-label="Edit tab Following"]')!.click();
    await wait(() => !!document.querySelector('[role="dialog"][data-open]'));
    set(document.querySelector<HTMLInputElement>("#destination-name")!, "Anime");
    set(document.querySelector<HTMLInputElement>("#destination-path")!, `${originalPath}/future`);
    await wait(() => !!document.querySelector("#move-files"));
    check(
      "Changing folders offers an explicit move",
      document.querySelector<HTMLInputElement>("#move-files")!.checked === false
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit();
    await wait(async () => (await state()).destinations.some((tab) => tab.name === "Anime"));
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    check(
      "Rename and change folders without moving the torrent",
      (await state()).detail!.savePath === initialTorrent.savePath
    );
    await wait(() => !!document.querySelector('button[aria-label="Edit tab Anime"]'));
    document.querySelector<HTMLButtonElement>('button[aria-label="Edit tab Anime"]')!.click();
    await wait(() => !!document.querySelector("#destination-path"));
    const movedPath = `${originalPath}/relocated`;
    set(document.querySelector<HTMLInputElement>("#destination-path")!, movedPath);
    await wait(() => !!document.querySelector("#move-files"));
    document.querySelector<HTMLInputElement>("#move-files")!.click();
    await wait(() => document.querySelector<HTMLInputElement>("#move-files")!.checked === true);
    document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit();
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    await wait(async () => (await state()).detail?.status === "seeding");
    const relocated = (await state()).detail!;
    const relocatedBytes = await (
      await fetch(`/api/torrents/${relocated.id}/files/0/content`)
    ).arrayBuffer();
    const relocatedHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", relocatedBytes))
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    check(
      "Move through the form, resume seeding, and preserve priorities and bytes",
      relocated.savePath === movedPath &&
        relocated.files[0]!.priority === "high" &&
        relocatedHash === config.expectedHash
    );
    click("Series");
    await wait(() => document.querySelectorAll(".torrent-table tbody tr").length === 0);
    click("Anime");
    await wait(() => document.querySelectorAll(".torrent-table tbody tr").length === 1);
    check("Filter torrents by tab ID", true);
    const automationState = async () =>
      (await (await fetch("/api/automation")).json()) as import("../src/types").AutomationState;
    const pluginsOrigin = location.pathname;
    click("Plugins");
    await wait(() => !!document.querySelector("#plugin-nyaa"));
    check("Plugins opens as a dedicated page without a modal", location.pathname === "/plugins");
    check("Plugins page has no modal overlay", !document.querySelector("[role=dialog]"));
    check(
      "Five plugins offered, initially disabled",
      document.querySelectorAll(".plugin-card").length === 5 &&
        (await automationState()).plugins.every((plugin) => !plugin.enabled)
    );
    document.querySelector<HTMLButtonElement>("#plugin-jev")!.click();
    await wait(() => !!document.querySelector('[role="alert"]'));
    check(
      "Enabling Jev without a key shows an inline error and focuses its API key field",
      [
        document
          .querySelector("#key-jev")!
          .closest("article")!
          .querySelector('[role="alert"]')
          ?.textContent?.includes("API key") === true,
        document.activeElement?.id === "key-jev",
        document.querySelector("#key-jev")!.getAttribute("aria-invalid") === "true",
        document.querySelector("#plugin-jev")!.getAttribute("aria-checked") === "false",
        (await automationState()).plugins.every((plugin) => !plugin.enabled),
      ].every(Boolean)
    );
    document.querySelector<HTMLInputElement>("#plugin-nyaa")!.click();
    await wait(async () =>
      (await automationState()).plugins.some((plugin) => plugin.id === "nyaa" && plugin.enabled)
    );
    await wait(() => !document.querySelector("#plugin-nyaa")!.hasAttribute("data-disabled"));
    click("Back");
    await wait(() => !!document.querySelector(".add-button"));
    check("Plugins returns to its originating library", location.pathname === pluginsOrigin);
    click("Automations");
    await wait(() => !!document.querySelector("[role=dialog]"));
    click("Discover");
    await wait(() => !!document.querySelector("#discovery-source-nyaa"));
    check(
      "Without Jev configured, Discover displays keyword search",
      document.querySelector<HTMLInputElement>("#feed-search")!.placeholder ===
        "A title, keywords…" &&
        document
          .querySelector('label[for="feed-search"]')!
          .textContent?.includes("Keyword search") === true
    );
    check(
      "Discover offers only enabled sources and selects all of them",
      document.querySelector<HTMLInputElement>("#discovery-all-sources")!.checked === true &&
        document.querySelector<HTMLInputElement>("#discovery-source-nyaa")!.checked === true &&
        !document.querySelector("#discovery-source-tsundere") &&
        !document.querySelector("#discovery-source-c411") &&
        !document.querySelector("#discovery-source-jev") &&
        !document.querySelector("#discovery-source-anilist")
    );
    set(document.querySelector<HTMLInputElement>("#feed-search")!, "re zero ep9 season4");
    document.querySelector<HTMLInputElement>("#discovery-source-nyaa")!.click();
    await wait(
      () => document.querySelector<HTMLInputElement>("#discovery-all-sources")!.checked === false
    );
    check(
      "Discover blocks search when all sources are unchecked",
      document
        .querySelector<HTMLButtonElement>("#feed-search")!
        .closest("form")!
        .querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled
    );
    document.querySelector<HTMLInputElement>("#discovery-all-sources")!.click();
    await wait(
      () => document.querySelector<HTMLInputElement>("#discovery-source-nyaa")!.checked === true
    );
    await wait(
      () =>
        !document
          .querySelector<HTMLInputElement>("#feed-search")!
          .closest("form")!
          .querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled
    );
    check("All restores sources and enables search", true);
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
    await wait(() => !document.querySelector("[role=dialog]"));
    click("Plugins");
    await wait(() => !!document.querySelector("#plugin-nyaa"));
    document.querySelector<HTMLInputElement>("#plugin-nyaa")!.click();
    await wait(async () => (await automationState()).plugins.every((plugin) => !plugin.enabled));
    set(document.querySelector<HTMLInputElement>("#key-jev")!, "native-test-secret");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await wait(() => {
      const save = Array.from(
        document.querySelector("#key-jev")!.closest("article")!.querySelectorAll("button")
      ).find((button) => button.textContent?.trim() === "Save");
      return !!save && !save.disabled;
    });
    Array.from(
      document
        .querySelector("#key-jev")!
        .closest("article")!
        .querySelectorAll<HTMLButtonElement>("button")
    )
      .find((button) => button.textContent?.trim() === "Save")!
      .click();
    await wait(async () =>
      (await automationState()).plugins.some((plugin) => plugin.id === "jev" && plugin.hasApiKey)
    );
    check(
      "Jev key saved without exposing it in public state",
      !JSON.stringify(await automationState()).includes("native-test-secret")
    );
    const toggleJev = async (enabled: boolean, name: string) => {
      await wait(() => !document.querySelector("#plugin-jev")!.hasAttribute("data-disabled"));
      document.querySelector<HTMLButtonElement>("#plugin-jev")!.click();
      await wait(async () =>
        (await automationState()).plugins.some((plugin) =>
          [plugin.id === "jev", plugin.enabled === enabled, plugin.hasApiKey].every(Boolean)
        )
      );
      await wait(
        () =>
          document.querySelector("#plugin-jev")!.getAttribute("aria-checked") === String(enabled)
      );
      check(
        name,
        !document.querySelector("#key-jev")!.closest("article")!.querySelector('[role="alert"]')
      );
    };
    await toggleJev(true, "Jev enables with its saved key and clears the inline error");
    await toggleJev(false, "Jev disables without losing its saved key");
    click("Back");
    await wait(() => !!document.querySelector(".add-button"));
    click("Automations");
    await wait(() => !!document.querySelector("[role=dialog]"));
    click("AniList tracking");
    await wait(() => !!document.querySelector('section[aria-label="AniList account connection"]'));
    check(
      "AniList does not ask for OAuth credentials",
      document.querySelector(
        "#anilist-client-id, #anilist-client-secret, #anilist-redirect, #key-anilist"
      ) === null
    );
    check(
      "AniList connection is available without an API key",
      document.querySelector<HTMLButtonElement>(
        'section[aria-label="AniList account connection"] button'
      )?.disabled === false
    );
    await wait(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Prepare tracking" && !button.disabled
      )
    );
    click("Prepare tracking");
    await wait(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Create AniList tracking"
      )
    );
    document.querySelector<HTMLButtonElement>("#anilist-customize")!.click();
    await wait(() => !!document.querySelector("#automation-language"));
    check(
      "AniList tracking starts from the general preferences and tracked statuses are configurable",
      [
        document.querySelector("#automation-language")!.getAttribute("data-value") ===
          (await automationState()).preferences.languages.join(","),
        document.querySelector<HTMLInputElement>("#anilist-CURRENT")!.checked === true,
        document.querySelector<HTMLInputElement>("#anilist-PLANNING")!.checked === true,
      ].every(Boolean)
    );
    check(
      "AniList proposes one thread per anime from the current folder and waits for selection before creation",
      [
        document.querySelector("#anilist-organization")!.textContent?.trim() ===
          "One thread per anime",
        document.querySelector<HTMLInputElement>("#anilist-base-path")!.value === movedPath,
        Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
          (button) => button.textContent?.trim() === "Create AniList tracking" && button.disabled
        ),
      ].every(Boolean)
    );
    await choose("#anilist-organization", "All anime in the selected thread");
    await wait(() => !document.querySelector("#anilist-base-path"));
    check(
      "AniList can group all anime into one thread",
      document.querySelector("#anilist-organization")!.textContent?.trim() ===
        "All anime in the selected thread"
    );
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    click("Automations");
    await wait(() => !!document.querySelector("#automation-query"));
    const anime = (await state()).destinations.find((tab) => tab.name === "Anime")!;
    check(
      "Automation linked to the current tab and its folder",
      document.querySelector("#automation-destination")!.textContent?.trim() === anime.name &&
        document.querySelector(".automation-destination-path")!.textContent === anime.downloadPath
    );
    set(
      document.querySelector<HTMLTextAreaElement>("#automation-query")!,
      'Download new episodes of "Example" with VF, prefer 1080p then 720p with Tsundere-Raws before Nyaa.'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    click("Prepare rule");
    await wait(() => !!document.querySelector("#automation-title"));
    check(
      "Without Jev, editable criteria and exact matching",
      document.querySelector<HTMLInputElement>("#automation-title")!.value === "Example" &&
        document.querySelector("#automation-matcher")!.textContent?.trim() === "Exact title name" &&
        document
          .querySelector("#automation-resolution")!
          .getAttribute("data-value")
          ?.includes("1080p") === true
    );
    const resolution900 = Array.from(
      document.querySelectorAll<HTMLButtonElement>("#automation-resolution button")
    ).find((element) => element.textContent?.trim() === "900p");
    check("Automation offers 900p among resolution priorities", !!resolution900);
    resolution900!.click();
    await wait(
      () =>
        document.querySelector("#automation-resolution")!.getAttribute("data-value") ===
        "1080p,720p,900p"
    );
    document.querySelector<HTMLInputElement>("#automation-enabled")!.click();
    await wait(
      () => document.querySelector<HTMLInputElement>("#automation-enabled")!.checked === false
    );
    check(
      "Deleting old versions is disabled by default",
      document.querySelector<HTMLInputElement>("#automation-deleteReplacedFiles")!.checked === false
    );
    document.querySelector<HTMLInputElement>("#automation-deleteReplacedFiles")!.click();
    await wait(
      () =>
        document.querySelector<HTMLInputElement>("#automation-deleteReplacedFiles")!.checked ===
        true
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    click("Preview matches");
    await wait(() => !!document.querySelector(".automation-preview"));
    check("Match preview available before creation", true);
    click("Create automation");
    await wait(async () => (await automationState()).automations.length === 1);
    const automation = (await automationState()).automations[0]!;
    check(
      "Rule persisted in the thread with its priorities",
      automation.destinationId === anime.id &&
        !automation.enabled &&
        automation.deleteReplacedFiles === true &&
        automation.resolutions.join(",") === "1080p,720p,900p" &&
        automation.sources[0] === "tsundere"
    );
    await fetch(`/api/automations/${automation.id}`, { method: "DELETE" });
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    click("Settings");
    await wait(() => !!document.querySelector(".settings-page"));
    check(
      "Settings opens as a dedicated page without a modal",
      location.pathname === "/options" && !document.querySelector("[role=dialog]")
    );
    click("Updates");
    await wait(() => location.pathname === "/options/updates");
    check(
      "The updates section shows the installed version without a GitHub token input",
      location.pathname === "/options/updates" &&
        !document.querySelector("#release-token") &&
        !!document.querySelector(".settings-updates")
    );
    click("Appearance");
    await wait(() => !!document.querySelector("#appearance-theme"));
    check(
      "Appearance defaults to the system theme",
      document.querySelector("#appearance-theme")?.textContent?.trim() === "System (default)"
    );
    await choose("#appearance-theme", "Dark");
    await wait(async () => (await state()).settings.theme === "dark");
    click("Downloads");
    await wait(() => !!document.querySelector("#limit-download"));
    const downloadLimit = document.querySelector<HTMLInputElement>("#limit-download")!;
    downloadLimit.focus();
    set(downloadLimit, "128");
    downloadLimit.blur();
    await wait(async () => (await state()).settings.downloadLimit === 128 * 1024);
    check("Preferences apply without a save button", location.pathname === "/options/downloads");
    click("Back");
    await wait(() => !document.querySelector(".settings-page"));
    await verifyAppearance();
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove torrent"]')!.click();
    await wait(
      () => !!document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')
    );
    document
      .querySelector<HTMLFormElement>('[role="dialog"] form, [role="alertdialog"] form')!
      .requestSubmit();
    await wait(async () => (await state()).torrents.length === 0);
    await wait(
      () => !document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')
    );
    check("Removal confirmed through the UI", true);
    const drop = (target: Element) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(config.torrentBytes)], "test.torrent", {
          type: "application/x-bittorrent",
        })
      );
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
    };
    drop(document.querySelector('[data-slot="sidebar-container"]')!);
    await wait(async () => (await state()).torrents.length === 1);
    const dropped = (await state()).torrents[0]!;
    check(
      "Global drop: immediate addition in the active folder without a dialog",
      dropped.destinationId === followedId && !document.querySelector('[role="dialog"][data-open]')
    );
    await fetch(`/api/torrents/${dropped.id}`, {
      body: JSON.stringify({ deleteFiles: false }),
      headers: { "content-type": "application/json" },
      method: "DELETE",
    });
    await wait(() => document.querySelectorAll(".torrent-table tbody tr").length === 0);
    click("All torrents");
    await wait(() => location.pathname === "/");
    drop(document.body);
    await wait(() => !!document.querySelector("#drop-destination"));
    check(
      "All torrents: dropping waits for a destination choice",
      (await state()).torrents.length === 0
    );
    click("Cancel");
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    check("Cancel drop without adding", (await state()).torrents.length === 0);
    drop(document.body);
    await wait(() => !!document.querySelector("#drop-destination"));
    await choose("#drop-destination", "Series");
    await new Promise((resolve) => setTimeout(resolve, 100));
    document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit();
    await wait(async () => (await state()).torrents.length === 1);
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    await wait(() => location.pathname.endsWith(seriesId));
    const existing = (await state()).torrents[0]!;
    check("Drop into an existing tab and navigate to it", existing.destinationId === seriesId);
    await fetch(`/api/torrents/${existing.id}`, {
      body: JSON.stringify({ deleteFiles: false }),
      headers: { "content-type": "application/json" },
      method: "DELETE",
    });
    await wait(() => document.querySelectorAll(".torrent-table tbody tr").length === 0);
    click("All torrents");
    await wait(() => location.pathname === "/");
    drop(document.body);
    await wait(() => !!document.querySelector("#drop-destination"));
    await choose("#drop-destination", "Create a new tab…");
    await wait(() => !!document.querySelector("#destination-name"));
    set(document.querySelector<HTMLInputElement>("#destination-name")!, "Drop");
    set(document.querySelector<HTMLInputElement>("#destination-path")!, `${originalPath}/drop`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit();
    await wait(async () => (await state()).torrents.length === 1);
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    const created = (await state()).destinations.find((tab) => tab.name === "Drop")!;
    await wait(() => location.pathname.endsWith(created.id));
    await wait(async () => (await state()).detail?.progress === 1);
    check(
      "Drop: destination creation and immediate real download",
      (await state()).detail!.destinationId === created.id &&
        (await state()).detail!.savePath.startsWith(`${originalPath}/drop`)
    );
    const droppedBytes = await (
      await fetch(`/api/torrents/${(await state()).detail!.id}/files/0/content`)
    ).arrayBuffer();
    const droppedHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", droppedBytes))
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    check(
      "The dropped .torrent file downloads the exact bytes",
      droppedHash === config.expectedHash
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Edit tab Drop"]')!.click();
    await wait(() => !!document.querySelector("#destination-name"));
    click("Delete tab");
    await wait(() => !!document.querySelector('[role="alertdialog"][data-open]'));
    click("Cancel");
    await wait(() => !!document.querySelector("#destination-name"));
    check(
      "Cancel tab deletion preserves the destination",
      (await state()).destinations.some((tab) => tab.id === created.id)
    );
    click("Delete tab");
    await wait(() => !!document.querySelector('[role="alertdialog"][data-open]'));
    click("Delete tab");
    await wait(() => location.pathname === "/thread/default");
    await wait(async () => !(await state()).destinations.some((tab) => tab.id === created.id));
    const remaining = (await state()).torrents.find((torrent) => torrent.id === dropped.id)!;
    check(
      "Deleting the active tab reassigns its torrent to Downloads",
      remaining.destinationId === "default"
    );
    const preservedBytes = await (
      await fetch(`/api/torrents/${dropped.id}/files/0/content`)
    ).arrayBuffer();
    const preservedHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", preservedBytes))
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    check("Tab deletion preserves downloaded bytes", preservedHash === config.expectedHash);
    check("No JavaScript errors", errors.length === 0);
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        errors,
        layoutWarnings,
        passed: true,
        userAgent: navigator.userAgent,
      }),
      method: "POST",
    });
  } catch (error) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        errors,
        layoutWarnings,
        page: document.body.innerText,
        passed: false,
        userAgent: navigator.userAgent,
      }),
      method: "POST",
    });
  }
}

async function anilistWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const errors: string[] = [];
  const layoutWarnings: string[] = [];
  window.addEventListener("error", (event) => {
    // WebKit reports deferred ResizeObserver layout notifications without a JavaScript exception.
    if (
      event.error === null &&
      event.lineno === 0 &&
      event.message === "ResizeObserver loop completed with undelivered notifications."
    ) {
      layoutWarnings.push(event.message);
    } else {
      errors.push(event.message);
    }
  });
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  const wait = async (condition: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out : ${condition.toString()}`);
  };
  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>("button, a")).find(
      (element) =>
        element.getAttribute("aria-label") === label || element.textContent?.trim() === label
    )!;
  const pickOption = async (selector: string, label: string) => {
    const trigger = document.querySelector<HTMLButtonElement>(selector)!;
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
    );
    await wait(
      () => !!document.querySelector('[data-slot="select-content"][data-open] [role="option"]')
    );
    const option = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-slot="select-content"][data-open] [role="option"]'
      )
    ).find((element) => element.textContent?.trim() === label);
    if (!option) {
      throw new Error(`Option missing: ${label}`);
    }
    option.focus();
    option.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
    option.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter" })
    );
    await wait(() => trigger.getAttribute("aria-expanded") === "false");
  };
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    void fetch(`${config.reportUrl}/progress`, {
      body: JSON.stringify({ name, passed }),
      method: "POST",
    });
    if (!passed) {
      throw new Error(name);
    }
  };
  // Public HTTP fixtures isolate native UI interactions from a real AniList account.
  const nativeFetch = window.fetch.bind(window);
  const sample = (await (
    await nativeFetch("/api/anilist")
  ).json()) as import("../src/types").AniListState;
  sample.connectedUser = "Native test account";
  sample.entries = [
    {
      aliases: ["Native Example"],
      automationId: null,
      bannerImage: null,
      completedEpisodes: [],
      coverImage: null,
      episodes: 3,
      format: "TV",
      genres: ["Action", "Comedy"],
      mediaId: 10,
      progress: 0,
      season: "SPRING",
      seasonYear: 2026,
      siteUrl: "https://anilist.co/anime/10",
      status: "CURRENT",
      title: "Native Example",
    },
  ];
  const releaseSearch = Promise.withResolvers<void>();
  let pluginNavigation = Promise.withResolvers<void>();
  let pluginNavigationStarted = Promise.withResolvers<void>();
  let pluginNavigationFinished = Promise.withResolvers<void>();
  const pluginState = Promise.withResolvers<void>();
  let openedAniListUrl: string | null = null;
  const fixtureUrl = (input: RequestInfo | URL) => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      ({ url } = input);
    }
    return new URL(url, location.origin);
  };
  const catalogFixture = (path: string, init: RequestInit | undefined): Response | null => {
    if (path === "/api/anilist/catalog/options") {
      return Response.json({
        genres: ["Action", "Comedy", "Drama"],
        streaming: [{ id: 7, name: "Crunchyroll" }],
        tags: [{ category: "Setting", isAdult: false, name: "Space" }],
      });
    }
    if (path === "/api/anilist/catalog") {
      const filters = JSON.parse(
        String(init?.body)
      ) as import("../src/types").AniListCatalogFilters;
      return Response.json({
        hasNextPage: false,
        media: [
          {
            ...sample.entries[0],
            aliases: ["Native Trending"],
            automationId: undefined,
            averageScore: 62,
            mediaId: 99,
            nextAiringEpisode: {
              airingAt: Math.floor(Date.now() / 1000) + 6 * 86_400,
              episode: 2,
            },
            progress: undefined,
            status: undefined,
            studios: ["Native Studio"],
            title: "Native Trending",
          },
        ],
        page: filters.page ?? 1,
      });
    }

    return null;
  };
  const episodeFixture = (path: string, init: RequestInit | undefined): Response | null => {
    if (path.startsWith("/api/anilist/entries/10/episodes/")) {
      const episode = Number(path.split("/").at(-1));
      const body = JSON.parse(String(init?.body)) as { completed: boolean };
      const completed = new Set(sample.entries[0]!.completedEpisodes);
      if (body.completed) {
        completed.add(episode);
      } else {
        completed.delete(episode);
      }
      sample.entries[0]!.completedEpisodes = [...completed];
      sample.entries[0]!.progress = 0;
      while (completed.has(sample.entries[0]!.progress + 1)) {
        sample.entries[0]!.progress += 1;
      }
      return Response.json(sample);
    }

    return null;
  };
  const fixtureFetch: typeof window.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fixtureUrl(input);
      const path = url.pathname;
      if (path === "/api/anilist/open") {
        openedAniListUrl = (JSON.parse(String(init?.body)) as { url: string }).url;
        return Response.json({ opened: true, url: openedAniListUrl });
      }
      if (path === "/_furin/data" && url.searchParams.get("path") === "/plugins") {
        const finished = pluginNavigationFinished;
        pluginNavigationStarted.resolve();
        await pluginNavigation.promise;
        try {
          init?.signal?.throwIfAborted();
          const response = await nativeFetch(input, init);
          await response.clone().arrayBuffer();
          return response;
        } finally {
          finished.resolve();
        }
      }
      if (path === "/api/automation") {
        await pluginState.promise;
      }
      if (path === "/api/anilist" && (!init?.method || init.method === "GET")) {
        return Response.json(sample);
      }
      const catalogResponse = catalogFixture(path, init);
      if (catalogResponse) {
        return catalogResponse;
      }
      if (path === "/api/anilist/preferences") {
        Object.assign(sample, JSON.parse(String(init?.body)));
        return Response.json(sample);
      }
      if (path === "/api/anilist/entries/10/releases") {
        await releaseSearch.promise;
        return Response.json({
          errors: [],
          releases: [
            {
              codec: null,
              downloadUrl: `magnet:?xt=urn:btih:${"1".repeat(40)}`,
              episode: 1,
              id: "native-release",
              infoHash: "1".repeat(40),
              language: "VOSTFR",
              pack: false,
              pageUrl: null,
              publishedAt: null,
              resolution: "1080p",
              season: null,
              seeders: null,
              size: null,
              sourceId: "nyaa",
              title: "Native Example - 01 VOSTFR 1080p",
              workTitle: "Native Example",
            },
          ],
          torrents: [],
        });
      }
      const episodeResponse = episodeFixture(path, init);
      return episodeResponse ?? (await nativeFetch(input, init));
    },
    { preconnect: nativeFetch.preconnect }
  );
  window.fetch = fixtureFetch;
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    await wait(() =>
      performance
        .getEntriesByType("resource")
        .some((entry) => entry.name.includes("/_furin/sync/changes"))
    );
    const regularTopbarHeight = document
      .querySelector<HTMLElement>(".library-topbar")!
      .getBoundingClientRect().height;
    document.querySelector<HTMLAnchorElement>('a[href="/"]')!.click();
    await wait(
      () =>
        location.pathname === "/" &&
        document.querySelector(".library-topbar h1")?.textContent === "All torrents"
    );
    const highlightedShortcut = () =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>(".sidebar-app-shortcut")).filter(
        (link) =>
          link.getAttribute("aria-current") === "page" &&
          getComputedStyle(link).backgroundColor === "rgba(0, 0, 0, 0)" &&
          getComputedStyle(link, "::before").backgroundImage.includes("radial-gradient") &&
          Number(getComputedStyle(link, "::before").opacity) > 0
      );
    check(
      "All torrents marks the Tofu logo as the current page",
      document.querySelector(".sidebar-brand")?.getAttribute("aria-current") === "page" &&
        highlightedShortcut().length === 0
    );
    const pluginsOrigin = location.pathname;
    button("Plugins").click();
    await pluginNavigationStarted.promise;
    check(
      "Pending plugin navigation keeps the current workspace mounted",
      location.pathname === pluginsOrigin &&
        !!document.querySelector(".add-button") &&
        !document.querySelector(".plugins-page")
    );
    button("Settings").click();
    await wait(() => !!document.querySelector(".settings-page"));
    pluginNavigation.resolve();
    await pluginNavigationFinished.promise;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    check(
      "Another route cancels pending plugin navigation",
      !document.querySelector(".plugins-page") && location.pathname === "/options"
    );
    button("Back").click();
    await wait(() => !!document.querySelector(".add-button"));
    // Exercise cancellation before a completed navigation caches the Plugins route.
    pluginNavigation = Promise.withResolvers<void>();
    pluginNavigationStarted = Promise.withResolvers<void>();
    pluginNavigationFinished = Promise.withResolvers<void>();
    button("Plugins").click();
    await pluginNavigationStarted.promise;
    pluginNavigation.resolve();
    pluginState.resolve();
    await wait(() => location.pathname === "/plugins" && !!document.querySelector("#plugin-nyaa"));
    check(
      "Completing plugin navigation renders the installed route",
      document.querySelector(".settings-topbar h1")?.textContent?.includes("Installed") === true
    );
    check("Plugins opens as a dedicated native page", location.pathname === "/plugins");
    check("Plugins has no modal overlay", document.querySelector("[role=dialog]") === null);
    check(
      "Installed plugins show all five integrations",
      document.querySelectorAll(".plugin-card").length === 5
    );
    button("Sources").click();
    await wait(
      () => document.querySelector(".settings-topbar h1")?.textContent?.includes("Sources") === true
    );
    check(
      "Sources mounts only its three plugin cards",
      location.pathname === "/plugins/sources" &&
        document.querySelectorAll(".plugin-card").length === 3 &&
        !document.querySelector("#plugin-jev") &&
        !document.querySelector("#plugin-anilist")
    );
    button("Installed").click();
    await wait(
      () =>
        document.querySelector(".settings-topbar h1")?.textContent?.includes("Installed") === true
    );
    const nyaaEnabled = async () =>
      (
        (await (await fetch("/api/automation")).json()) as import("../src/types").AutomationState
      ).plugins.find((plugin) => plugin.id === "nyaa")!.enabled;
    document.querySelector<HTMLButtonElement>("#plugin-nyaa")!.click();
    await wait(nyaaEnabled);
    check("Plugin switches persist through the public API", await nyaaEnabled());
    await wait(() => !document.querySelector("#plugin-nyaa")!.hasAttribute("data-disabled"));
    document.querySelector<HTMLButtonElement>("#plugin-nyaa")!.click();
    await wait(async () => !(await nyaaEnabled()));
    await wait(() => !document.querySelector("#plugin-nyaa")!.hasAttribute("data-disabled"));
    button("Back").click();
    await wait(() => !!document.querySelector(".add-button"));
    check("Plugins returns to the originating library", location.pathname === pluginsOrigin);
    button("Automations").click();
    await wait(() => !!document.querySelector("[role=dialog]"));
    const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (element) => element.textContent?.trim() === "AniList tracking"
    )!;
    tab.focus();
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    tab.click();
    await wait(() => !!document.querySelector("#anilist-base-path"));
    const state = (await (
      await fetch("/api/state")
    ).json()) as import("../src/types").DashboardState;
    const rootInput = document.querySelector<HTMLInputElement>("#anilist-base-path")!;
    const organization = () => document.querySelector("#anilist-organization")?.textContent?.trim();
    check(
      "AniList proposes one thread per anime from the current folder",
      organization() === "One thread per anime" && rootInput.value === state.settings.downloadPath
    );
    const customRoot = `${state.settings.downloadPath}/anime`;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      rootInput,
      customRoot
    );
    rootInput.dispatchEvent(new Event("input", { bubbles: true }));
    rootInput.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(
      () => rootInput.value === customRoot && !button("Prepare tracking").hasAttribute("disabled")
    );
    button("Prepare tracking").click();
    await wait(
      () =>
        Array.from(document.querySelectorAll("button")).some(
          (element) => element.textContent?.trim() === "Create AniList tracking"
        ) && !button("Prepare tracking").hasAttribute("disabled")
    );
    check(
      "Custom root folder is preserved and the general preferences are summarized",
      rootInput.value === customRoot && !!document.querySelector(".preference-summary li")
    );
    check(
      "Creation waits for AniList title approval",
      button("Create AniList tracking").hasAttribute("disabled")
    );
    await pickOption("#anilist-organization", "All anime in the selected thread");
    await wait(() => !document.querySelector("#anilist-base-path"));
    check(
      "All anime can use the same thread",
      organization() === "All anime in the selected thread" &&
        !document.querySelector('[aria-label="Proposed threads"]')
    );
    check(
      "No thread created during preparation",
      ((await (await fetch("/api/state")).json()) as import("../src/types").DashboardState)
        .destinations.length === 1
    );
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
    await wait(() => !document.querySelector('[role="dialog"]'));
    // Native WebKit can suspend transitions while the test window is obscured.
    const sidebarMotion = document.createElement("style");
    sidebarMotion.textContent =
      '[data-slot="sidebar-wrapper"] *, [data-slot="sidebar-wrapper"] *::before, [data-slot="sidebar-wrapper"] *::after { transition: none !important; }';
    document.head.append(sidebarMotion);
    document.querySelector<HTMLAnchorElement>('a[href="/anilist"]')!.click();
    await wait(() => location.pathname === "/anilist" && !!document.querySelector("#anime-search"));
    check(
      "AniList topbar matches the regular page height",
      document.querySelector<HTMLElement>(".anilist-page-header")!.getBoundingClientRect()
        .height === regularTopbarHeight
    );
    check("AniList opens as a dedicated Furin page", !!document.querySelector(".anilist-library"));
    await wait(() => highlightedShortcut().length === 1);
    check(
      "Navigating to AniList moves the shortcut highlight",
      highlightedShortcut().length === 1 &&
        highlightedShortcut()[0]!.getAttribute("aria-label") === "AniList" &&
        highlightedShortcut()[0]!.getAttribute("aria-current") === "page"
    );
    const sidebarToggle = document.querySelector<HTMLButtonElement>(
      '.sidebar-brand-row button[aria-label="Toggle sidebar"]'
    )!;
    check("AniList keeps the sidebar toggle next to the Tofu logo", !!sidebarToggle);
    sidebarToggle.focus();
    sidebarToggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    sidebarToggle.click();
    await wait(
      () =>
        document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state") === "collapsed"
    );
    await wait(() => {
      const sidebar = document.querySelector('[data-slot="sidebar-container"]')!;
      const bounds = sidebar.getBoundingClientRect();
      const center = bounds.left + bounds.width / 2;
      const icons = Array.from(sidebar.querySelectorAll("svg, img"))
        .map((icon) => icon.getBoundingClientRect())
        .filter((icon) => icon.width > 0);
      return (
        icons.length >= 5 &&
        icons.every(
          (iconBounds) => Math.abs(iconBounds.left + iconBounds.width / 2 - center) < 1
        ) &&
        Array.from(sidebar.querySelectorAll("svg, img"))
          .filter((icon) => icon.getBoundingClientRect().width > 0)
          .every((icon) => {
            const iconBounds = icon.getBoundingClientRect();
            let size = icon.closest('[data-sidebar="menu-button"]') ? 20 : 18;
            if (icon.closest(".sidebar-brand")) {
              size = 28;
            }
            return iconBounds.width === size && iconBounds.height === size;
          })
      );
    });
    check("AniList collapsed sidebar icons share size and alignment", true);
    check(
      "Collapsed sidebar toggle reports its state",
      sidebarToggle.getAttribute("aria-expanded") === "false"
    );
    sidebarToggle.focus();
    sidebarToggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    sidebarToggle.click();
    await wait(
      () =>
        document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state") ===
          "expanded" && sidebarToggle.getAttribute("aria-expanded") === "true"
    );
    check("The sidebar toggle reopens the sidebar from AniList", true);
    sidebarMotion.remove();
    const library = document.querySelector<HTMLElement>(".anilist-library")!;
    const themeSurface = document.createElement("div");
    themeSurface.style.backgroundColor = "var(--background)";
    themeSurface.style.color = "var(--foreground)";
    document.body.append(themeSurface);
    check(
      "AniList uses the active Furin theme colors",
      getComputedStyle(library).backgroundColor ===
        getComputedStyle(themeSurface).backgroundColor &&
        getComputedStyle(library).color === getComputedStyle(themeSurface).color
    );
    themeSurface.remove();
    const statusFilter = document.querySelector<HTMLButtonElement>(".anilist-status-filter")!;
    const accessibleName = (element: HTMLElement) =>
      element
        .getAttribute("aria-labelledby")
        ?.split(" ")
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .join(" ");
    check(
      "AniList list filter announces its selected statuses",
      accessibleName(statusFilter) === "Lists Watching, Plan to Watch"
    );
    const genreFilter = document.querySelector<HTMLButtonElement>(
      'button[aria-labelledby^="anilist-genres-label"]'
    )!;
    check(
      "AniList genre filter announces Any before selection",
      accessibleName(genreFilter) === "Genres & Tags Any"
    );
    genreFilter.focus();
    genreFilter.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
    );
    await wait(() => !!document.querySelector('[role="menu"]'));
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
      .find((element) => element.textContent?.trim() === "Action")!
      .click();
    await wait(() => genreFilter.textContent?.trim() === "Action");
    genreFilter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    genreFilter.click();
    await wait(() => !document.querySelector('[role="menu"]'));
    check(
      "AniList genre filter announces its selected values",
      accessibleName(genreFilter) === "Genres & Tags Action"
    );
    statusFilter.focus();
    statusFilter.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
    );
    await wait(() => !!document.querySelector('[role="menu"]'));
    check(
      "AniList offers all six list statuses",
      document.querySelectorAll('[role="menu"] [role="menuitemcheckbox"]').length === 6
    );
    statusFilter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    statusFilter.click();
    await wait(() => !document.querySelector('[role="menu"]'));
    for (const label of ["Watching", "Plan to Watch"]) {
      statusFilter.focus();
      statusFilter.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
      );
      await wait(() => !!document.querySelector('[role="menu"]'));
      const choice = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')
      ).find((element) => element.textContent?.trim() === label)!;
      const selectedCount = sample.visibleStatuses.length;
      choice.click();
      await wait(() => sample.visibleStatuses.length < selectedCount);
      await wait(() => choice.getAttribute("aria-disabled") !== "true");
      statusFilter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      statusFilter.click();
      await wait(() => !document.querySelector('[role="menu"]'));
    }
    await wait(() => statusFilter.textContent?.trim() === "None");
    check(
      "No selected AniList lists shows and announces None",
      statusFilter.textContent?.trim() === "None" &&
        accessibleName(statusFilter) === "Lists None" &&
        !document.querySelector('button[aria-label="View episodes for Native Example"]')
    );
    await wait(
      () => !!document.querySelector('button[aria-label="Open Native Trending on AniList"]')
    );
    check(
      "None browses trending anime with real airing information",
      document.querySelector(".anilist-sort")?.textContent?.includes("Trending") === true &&
        document.querySelector(".anime-grid")?.textContent?.includes("Ep 2 airing in") === true
    );
    button("More filters").click();
    await wait(() => !!document.querySelector("#anilist-airingStatus"));
    check(
      "AniList exposes advanced catalog filters",
      [
        "airingStatus",
        "streamingOn",
        "countryOfOrigin",
        "source",
        "yearMin",
        "episodesMin",
        "durationMin",
      ].every((key) => !!document.getElementById(`anilist-${key}`))
    );
    await pickOption("#anilist-airingStatus", "Airing");
    await wait(
      () =>
        document.querySelector(".anilist-active-filters")?.textContent?.includes("Airing") === true
    );
    button("Remove filter Airing").click();
    button("More filters").click();
    statusFilter.focus();
    statusFilter.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
    );
    await wait(() => !!document.querySelector('[role="menu"]'));
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
      .find((element) => element.textContent?.trim() === "Watching")!
      .click();
    await wait(() => sample.visibleStatuses.includes("CURRENT"));
    statusFilter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    statusFilter.click();
    await wait(() => !document.querySelector('[role="menu"]'));
    await wait(
      () => !!document.querySelector('button[aria-label="View episodes for Native Example"]')
    );
    document
      .querySelector<HTMLButtonElement>('button[aria-label="View episodes for Native Example"]')!
      .click();
    await wait(() => document.querySelectorAll(".anime-episode-row").length === 3);
    check(
      "Episodes appear before release matching finishes",
      document.querySelector('[data-slot="dialog-title"]')?.textContent === "Native Example" &&
        document.querySelector(".anime-modal")?.textContent?.includes("No release found") === false
    );
    document.querySelector<HTMLAnchorElement>(".anime-external-link")!.click();
    await wait(() => openedAniListUrl !== null);
    check(
      "The anime link requests the system browser without leaving the episode dialog",
      openedAniListUrl === "https://anilist.co/anime/10" &&
        !!document.querySelector(".anime-modal") &&
        location.pathname === "/anilist"
    );
    await wait(() => !document.querySelector<HTMLInputElement>("#anime-episode-2")!.disabled);
    const mark = async (episode: number) => {
      const checkbox = document
        .querySelector<HTMLInputElement>(`#anime-episode-${episode}`)!
        .closest('[data-slot="field"]')!
        .querySelector<HTMLElement>('[role="checkbox"]')!;
      await wait(() => !checkbox.hasAttribute("data-disabled"));
      checkbox.click();
    };
    await mark(2);
    await wait(() => document.querySelector<HTMLInputElement>("#anime-episode-2")!.checked);
    check(
      "Native UI preserves out-of-order episode completion",
      document.querySelector('[data-slot="dialog-description"]')?.textContent?.includes("0 / 3") ===
        true
    );
    await mark(1);
    await wait(
      () =>
        document
          .querySelector('[data-slot="dialog-description"]')
          ?.textContent?.includes("2 / 3") === true
    );
    check("Native UI displays consecutive episode progress", true);
    releaseSearch.resolve();
    await wait(
      () =>
        document.querySelector(".anime-release-name")?.textContent ===
        "Native Example - 01 VOSTFR 1080p"
    );
    check(
      "Release proposals appear without losing episode completion",
      !!button("Download") &&
        document.querySelector<HTMLInputElement>("#anime-episode-1")!.checked &&
        document.querySelector<HTMLInputElement>("#anime-episode-2")!.checked
    );
    const releaseName = document.querySelector<HTMLElement>(".anime-release-name")!;
    (document.activeElement as HTMLElement | null)?.blur();
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    releaseName.focus();
    await wait(() => !!document.querySelector('[data-slot="tooltip-content"][data-open]'));
    check(
      "The release name shows its full text in a shadcn tooltip on keyboard focus",
      !releaseName.hasAttribute("title") &&
        document.querySelector('[data-slot="tooltip-content"][data-open]')?.textContent?.trim() ===
          "Native Example - 01 VOSTFR 1080p"
    );
    button("Download").focus();
    await wait(() => !document.querySelector('[data-slot="tooltip-content"][data-open]'));
    const animeAutomation = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((element) => element.textContent?.trim() === "Automation")!;
    animeAutomation.focus();
    animeAutomation.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    animeAutomation.click();
    await wait(() => !!button("Customize automation"));
    button("Customize automation").click();
    await wait(() => !!document.querySelector("#automation-resolution"));
    check(
      "Anime automation exposes quality preferences with identity supplied by AniList",
      !document.querySelector("#automation-title") &&
        document.querySelector("#automation-resolution")!.getAttribute("data-value") ===
          "1080p,720p"
    );
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
    await wait(() => !document.querySelector(".anime-modal"));
    document
      .querySelector<HTMLButtonElement>(
        '.anilist-header-actions button[aria-label="AniList settings"]'
      )!
      .click();
    await wait(() => !!document.querySelector('section[aria-label="AniList account connection"]'));
    check(
      "AniList account and default tracking settings open from its page",
      document.querySelector('[data-slot="dialog-title"]')?.textContent === "AniList settings"
    );
    check("No JavaScript errors", errors.length === 0);
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        errors,
        layoutWarnings,
        passed: true,
        userAgent: navigator.userAgent,
      }),
      method: "POST",
    });
  } catch (error) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        errors,
        layoutWarnings,
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  }
}

async function destinationWorkflow(config: {
  magnet: string;
  expectedHash: string;
  reportUrl: string;
}) {
  const checks: { name: string; passed: boolean }[] = [];
  const errors: string[] = [];
  const layoutWarnings: string[] = [];
  window.addEventListener("error", (event) => {
    // WebKit reports deferred ResizeObserver layout notifications without a JavaScript exception.
    if (
      event.error === null &&
      event.lineno === 0 &&
      event.message === "ResizeObserver loop completed with undelivered notifications."
    ) {
      layoutWarnings.push(event.message);
    } else {
      errors.push(event.message);
    }
  });
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  const state = async () =>
    (await (await fetch("/api/state")).json()) as import("../src/types").DashboardState;
  const wait = async (condition: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out : ${condition.toString()}`);
  };
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (!passed) {
      throw new Error(name);
    }
  };
  const send = (path: string, method: string, body: object) =>
    fetch(`/api${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method,
    });
  const changePath = async (path: string) => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Edit tab Downloads"]')!.click();
    await wait(() => !!document.querySelector("#destination-path"));
    const input = document.querySelector<HTMLInputElement>("#destination-path")!;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, path);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(() => !!document.querySelector("#move-files"));
  };
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    const originalPath = (await state()).settings.downloadPath;
    const added = await send("/torrents", "POST", { paused: false, source: config.magnet });
    const { id } = (await added.json()) as { id: string };
    await wait(async () => (await state()).detail?.progress === 1);
    await send(`/torrents/${id}/pause`, "POST", {});
    await send(`/torrents/${id}/files/0`, "PUT", { priority: "high" });
    await wait(() => !!document.querySelector('button[aria-label="Verify files"]'));
    const newPath = `${originalPath}/relocated`;
    await changePath(newPath);
    check(
      "Moving is offered and requires an explicit choice",
      document.querySelector<HTMLInputElement>("#move-files")!.checked === false
    );
    document.querySelector<HTMLInputElement>("#move-files")!.click();
    await wait(() => document.querySelector<HTMLInputElement>("#move-files")!.checked === true);
    document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit();
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    const moved = (await state()).detail!;
    const content = await (await fetch(`/api/torrents/${id}/files/0/content`)).arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    check(
      "The form moves exact bytes and preserves paused state and priorities",
      moved.savePath === newPath &&
        moved.status === "paused" &&
        moved.files[0]!.priority === "high" &&
        hash === config.expectedHash
    );
    await fetch(`${config.reportUrl}/remove-downloaded`, { method: "POST" });
    await changePath(`${originalPath}/missing`);
    document.querySelector<HTMLInputElement>("#move-files")!.click();
    await wait(() => document.querySelector<HTMLInputElement>("#move-files")!.checked === true);
    document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit();
    await wait(
      () =>
        document
          .querySelector('[role="dialog"] [role="alert"]')
          ?.textContent?.includes("is no longer present") === true
    );
    check(
      "The form displays the missing file and preserves the destination",
      (await state()).detail!.savePath === newPath &&
        (await state()).destinations[0]!.downloadPath === newPath
    );
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((button) => button.textContent?.trim() === "Cancel")!
      .click();
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    const filesTab = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (tab) => tab.textContent?.startsWith("Files")
    )!;
    filesTab.focus();
    filesTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    filesTab.click();
    await wait(() => !!document.querySelector('button[aria-label="Save Real Tofu test.bin"]'));
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Save Real Tofu test.bin"]')!
      .click();
    await wait(
      () =>
        document
          .querySelector('.detail-pane [role="alert"]')
          ?.textContent?.includes("is no longer present") === true
    );
    check("Saving a missing file displays an error in the UI", true);
    check("No JavaScript errors", errors.length === 0);
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        errors,
        layoutWarnings,
        passed: true,
        userAgent: navigator.userAgent,
      }),
      method: "POST",
    });
  } catch (error) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        errors,
        layoutWarnings,
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  }
}

async function pluginsWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  const nativeFetch = window.fetch;
  let started = false;
  const release = Promise.withResolvers<void>();
  let rejectConfiguration = false;
  let rejectionStarted = false;
  const rejection = Promise.withResolvers<void>();
  let keySaveStarted = false;
  const keySave = Promise.withResolvers<void>();
  let connectionStarted = false;
  const connection = Promise.withResolvers<void>();
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    if (url.pathname === "/api/plugins/nyaa" && init?.method === "PUT") {
      started = true;
      await release.promise;
    }
    if (url.pathname === "/api/plugins/tsundere" && init?.method === "PUT" && rejectConfiguration) {
      rejectionStarted = true;
      await rejection.promise;
      return nativeFetch(input, {
        ...init,
        body: JSON.stringify({ ...JSON.parse(String(init.body)), dailyLimit: 0 }),
      });
    }
    if (url.pathname === "/api/plugins/jev" && init?.method === "PUT") {
      keySaveStarted = true;
      await keySave.promise;
    }
    if (url.pathname === "/api/plugins/nyaa/test" && init?.method === "POST") {
      connectionStarted = true;
      await connection.promise;
    }
    return nativeFetch(input, init);
  }, nativeFetch);
  const wait = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${condition.toString()}`);
  };
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (!passed) {
      throw new Error(name);
    }
  };
  const state = async () =>
    (await (await nativeFetch("/api/automation")).json()) as import("../src/types").AutomationState;
  const toggle = (id: string) => document.querySelector<HTMLButtonElement>(`#plugin-${id}`)!;
  const click = (label: string) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>("button, a")).find(
      (item) => item.textContent?.trim() === label
    );
    if (!target) {
      throw new Error(`Action missing: ${label}`);
    }
    target.click();
  };
  const set = (selector: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  try {
    if (location.pathname !== "/plugins") {
      await wait(
        () => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false
      );
      document.querySelector<HTMLButtonElement>('button[aria-label="Plugins"]')!.click();
    }
    await wait(() => location.pathname === "/plugins" && !!document.querySelector("#plugin-nyaa"));
    toggle("nyaa").click();
    await wait(() => started);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    check(
      "Enabling a plugin updates its switch and badge before the request completes",
      toggle("nyaa").getAttribute("aria-checked") === "true" &&
        toggle("nyaa").closest("article")!.querySelector('[data-slot="badge"]')?.textContent ===
          "Enabled" &&
        (await state()).plugins.find((plugin) => plugin.id === "nyaa")?.enabled === false
    );
    check("An in-flight plugin does not disable another plugin", !toggle("tsundere").disabled);
    toggle("tsundere").click();
    await wait(async () =>
      (await state()).plugins.some((plugin) => plugin.id === "tsundere" && plugin.enabled)
    );
    check(
      "Another plugin saves before the previous request completes",
      (await state()).plugins.some((plugin) => plugin.id === "tsundere" && plugin.enabled) &&
        (await state()).plugins.some((plugin) => plugin.id === "nyaa" && !plugin.enabled)
    );
    release.resolve();
    await wait(() => !(toggle("nyaa").disabled || toggle("tsundere").disabled));
    check(
      "Concurrent plugin writes converge to their confirmed states",
      toggle("nyaa").getAttribute("aria-checked") === "true" &&
        toggle("tsundere").getAttribute("aria-checked") === "true"
    );
    rejectConfiguration = true;
    toggle("tsundere").click();
    await wait(() => rejectionStarted);
    check(
      "A pending disable is optimistic and leaves other plugins usable",
      toggle("tsundere").getAttribute("aria-checked") === "false" &&
        !toggle("nyaa").disabled &&
        (await state()).plugins.some((plugin) => plugin.id === "tsundere" && plugin.enabled)
    );
    rejection.resolve();
    await wait(() => !!toggle("tsundere").closest("article")!.querySelector('[role="alert"]'));
    check(
      "An API rejection restores the confirmed switch and keeps its error on its own card",
      toggle("tsundere").getAttribute("aria-checked") === "true" &&
        !toggle("nyaa").closest("article")!.querySelector('[role="alert"]')
    );
    rejectConfiguration = false;
    toggle("tsundere").click();
    await wait(() => !toggle("tsundere").disabled);
    check(
      "Retrying a rejected action saves and clears its error",
      toggle("tsundere").getAttribute("aria-checked") === "false" &&
        !toggle("tsundere").closest("article")!.querySelector('[role="alert"]')
    );
    toggle("jev").click();
    await wait(() => document.querySelector("#key-jev")?.getAttribute("aria-invalid") === "true");
    check(
      "Missing credentials focus the key field without starting a mutation",
      document.activeElement?.id === "key-jev" &&
        !keySaveStarted &&
        toggle("jev").getAttribute("aria-checked") === "false"
    );
    set("#key-jev", "submitted-native-key");
    set("#jev-daily-limit", "0");
    document.querySelector<HTMLFormElement>("#plugin-form-jev")!.requestSubmit();
    await wait(
      () => document.querySelector("#jev-daily-limit")?.getAttribute("aria-invalid") === "true"
    );
    check(
      "Invalid limits stay in the form without sending a configuration request",
      !keySaveStarted &&
        document.querySelector<HTMLInputElement>("#key-jev")!.value === "submitted-native-key"
    );
    set("#jev-daily-limit", "42");
    await wait(
      () =>
        toggle("jev").closest("article")!.querySelector<HTMLButtonElement>(".plugins-save")
          ?.disabled === false
    );
    document.querySelector<HTMLFormElement>("#plugin-form-jev")!.requestSubmit();
    await wait(() => keySaveStarted);
    click("Intelligence");
    await wait(
      () => location.pathname === "/plugins/intelligence" && !!document.querySelector("#key-jev")
    );
    check(
      "Section navigation remains available during a save and preserves its draft",
      document.querySelector<HTMLInputElement>("#key-jev")!.value === "submitted-native-key" &&
        document.querySelector<HTMLInputElement>("#jev-daily-limit")!.value === "42"
    );
    set("#key-jev", "new-unsaved-native-key");
    set("#jev-daily-limit", "43");
    keySave.resolve();
    await wait(async () =>
      (await state()).plugins.some((plugin) => plugin.id === "jev" && plugin.hasApiKey)
    );
    await wait(
      () =>
        document.querySelector<HTMLInputElement>("#key-jev")?.placeholder ===
        "Saved · type to replace"
    );
    check(
      "A completed save keeps credentials edited after navigating away",
      document.querySelector<HTMLInputElement>("#key-jev")!.value === "new-unsaved-native-key"
    );
    check(
      "A completed save keeps limits edited while the submitted limit reaches the API",
      document.querySelector<HTMLInputElement>("#jev-daily-limit")!.value === "43" &&
        (await state()).plugins.find((plugin) => plugin.id === "jev")?.dailyLimit === 42
    );
    click("Sources");
    await wait(
      () => location.pathname === "/plugins/sources" && !!document.querySelector("#plugin-nyaa")
    );
    const previousCheck = toggle("nyaa")
      .closest("article")!
      .querySelector(".automation-caption")?.textContent;
    const previousCheckedAt = (await state()).plugins.find(
      (plugin) => plugin.id === "nyaa"
    )?.checkedAt;
    toggle("nyaa")
      .closest("article")!
      .querySelector<HTMLButtonElement>(".plugins-plugin-actions button")!
      .click();
    await wait(() => connectionStarted);
    check(
      "A connection test keeps other plugins usable and does not invent a check timestamp",
      !toggle("tsundere").disabled &&
        toggle("nyaa").closest("article")!.querySelector(".automation-caption")?.textContent ===
          previousCheck
    );
    toggle("tsundere").click();
    await wait(async () =>
      (await state()).plugins.some((plugin) => plugin.id === "tsundere" && plugin.enabled)
    );
    connection.resolve();
    const connectionConfirmed = async () => {
      const plugin = (await state()).plugins.find((item) => item.id === "nyaa");
      return (
        plugin?.checkedAt !== null &&
        plugin?.checkedAt !== undefined &&
        plugin.checkedAt !== previousCheckedAt &&
        toggle("nyaa")
          .closest("article")!
          .querySelector(".automation-caption")
          ?.textContent?.includes(new Date(plugin.checkedAt).toLocaleTimeString("en-US")) === true
      );
    };
    await wait(connectionConfirmed);
    check("Connection results are shown after the API confirms them", await connectionConfirmed());
    click("Intelligence");
    await wait(
      () => location.pathname === "/plugins/intelligence" && !!document.querySelector("#key-jev")
    );
    check(
      "Unsaved credentials survive multiple section changes",
      document.querySelector<HTMLInputElement>("#key-jev")!.value === "new-unsaved-native-key"
    );
    document.querySelector<HTMLFormElement>("#plugin-form-jev")!.requestSubmit();
    await wait(() => document.querySelector<HTMLInputElement>("#key-jev")?.value === "");
    check(
      "A successful form action clears the submitted credential",
      document.querySelector<HTMLInputElement>("#key-jev")?.value === ""
    );
    check(
      "The next save persists the edited limit",
      (await state()).plugins.find((plugin) => plugin.id === "jev")?.dailyLimit === 43
    );
    check("No JavaScript errors", errors.length === 0);
    await nativeFetch(config.reportUrl, {
      body: JSON.stringify({ checks, errors, passed: true }),
      method: "POST",
    });
  } catch (error) {
    await nativeFetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        errors,
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  } finally {
    release.resolve();
    rejection.resolve();
    keySave.resolve();
    connection.resolve();
    window.fetch = nativeFetch;
  }
}

async function preferencesWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const errors: string[] = [];
  window.addEventListener("error", (event) => {
    if (
      event.error ||
      event.message !== "ResizeObserver loop completed with undelivered notifications."
    ) {
      errors.push(event.message);
    }
  });
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  const wait = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${condition.toString()}`);
  };
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (!passed) {
      throw new Error(name);
    }
  };
  const click = (label: string) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("button, a")).find(
      (item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label
    );
    if (!element) {
      throw new Error(`Navigation item missing: ${label}`);
    }
    element.click();
  };
  const set = (selector: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    const origin = location.pathname;
    click("Settings");
    await wait(
      () => location.pathname === "/options" && !!document.querySelector(".settings-page")
    );
    const optionsNavigation = document.querySelector('nav[aria-label="Settings sections"]');
    check(
      "General settings mount without the other sections",
      !(document.querySelector("#appearance-theme") || document.querySelector("#destination-path"))
    );
    click("Appearance");
    await wait(
      () =>
        location.pathname === "/options/appearance" && !!document.querySelector("#appearance-theme")
    );
    const trigger = document.querySelector<HTMLButtonElement>("#appearance-theme")!;
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
    );
    await wait(
      () => !!document.querySelector('[data-slot="select-content"][data-open] [role="option"]')
    );
    const option = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-slot="select-content"][data-open] [role="option"]'
      )
    ).find((item) => item.textContent?.trim() === "Dark")!;
    option.focus();
    option.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
    option.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter" })
    );
    await wait(
      () =>
        trigger.getAttribute("aria-expanded") === "false" && trigger.textContent?.trim() === "Dark"
    );
    await wait(async () => (await (await fetch("/api/settings")).json()).theme === "dark");
    click("Downloads");
    await wait(
      () =>
        location.pathname === "/options/downloads" && !!document.querySelector("#limit-download")
    );
    const downloadLimit = document.querySelector<HTMLInputElement>("#limit-download")!;
    downloadLimit.focus();
    set("#limit-download", "128");
    downloadLimit.blur();
    await wait(
      async () => (await (await fetch("/api/settings")).json()).downloadLimit === 128 * 1024
    );
    click("Appearance");
    await wait(
      () =>
        location.pathname === "/options/appearance" && !!document.querySelector("#appearance-theme")
    );
    check(
      "Options navigation preserves the layout and saved appearance",
      document.querySelector('nav[aria-label="Settings sections"]') === optionsNavigation &&
        document.querySelector("#appearance-theme")?.textContent?.trim() === "Dark" &&
        !document.querySelector("#limit-download")
    );
    click("Downloads");
    await wait(() => !!document.querySelector("#limit-download"));
    check(
      "Saved download preferences survive section navigation",
      document.querySelector<HTMLInputElement>("#limit-download")?.value === "128"
    );

    const settings = (await (
      await fetch("/api/settings")
    ).json()) as import("../src/types").Settings;
    check(
      "Appearance and bandwidth apply independently without a save button",
      settings.theme === "dark" &&
        settings.downloadLimit === 128 * 1024 &&
        !document.querySelector("#settings-form") &&
        !Array.from(document.querySelectorAll(".settings-page button")).some(
          (button) => button.textContent?.trim() === "Save"
        )
    );
    click("Updates");
    await wait(() => location.pathname === "/options/updates");
    check(
      "Updates has its own page without download controls",
      !!document.querySelector(".settings-updates") && !document.querySelector("#limit-download")
    );
    click("Back");
    await wait(() => location.pathname === origin && !!document.querySelector(".add-button"));
    click("Plugins");
    await wait(() => location.pathname === "/plugins" && !!document.querySelector("#plugin-nyaa"));
    check(
      "Installed plugins show all five cards",
      document.querySelectorAll(".plugin-card").length === 5
    );
    const pluginsNavigation = document.querySelector('nav[aria-label="Plugin sections"]');
    click("Intelligence");
    await wait(
      () => location.pathname === "/plugins/intelligence" && !!document.querySelector("#key-jev")
    );
    set("#key-jev", "unsaved-native-key");
    click("Sources");
    await wait(() => location.pathname === "/plugins/sources");
    check(
      "Source routes mount only source cards",
      document.querySelectorAll(".plugin-card").length === 3 &&
        !document.querySelector("#plugin-jev") &&
        !document.querySelector("#plugin-anilist")
    );
    click("Integrations");
    await wait(() => location.pathname === "/plugins/integrations");
    check(
      "Integration routes mount only account cards",
      document.querySelectorAll(".plugin-card").length === 1 &&
        !!document.querySelector("#plugin-anilist")
    );
    click("Intelligence");
    await wait(
      () => location.pathname === "/plugins/intelligence" && !!document.querySelector("#key-jev")
    );
    check(
      "Plugin navigation preserves the layout and unsaved credentials",
      document.querySelector('nav[aria-label="Plugin sections"]') === pluginsNavigation &&
        document.querySelector<HTMLInputElement>("#key-jev")?.value === "unsaved-native-key"
    );
    set("#key-jev", "");
    click("Back");
    await wait(() => location.pathname === origin && !!document.querySelector(".add-button"));
    check("Back from nested preferences restores the workspace", location.pathname === origin);
    check("No JavaScript errors", errors.length === 0);
    await fetch(config.reportUrl, {
      body: JSON.stringify({ checks, errors, passed: true }),
      method: "POST",
    });
  } catch (error) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        errors,
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  }
}

async function anilistCatalogWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const errors: string[] = [];
  window.addEventListener("error", (event) => {
    if (event.error) {
      errors.push(String(event.error));
    }
  });
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  const wait = async (condition: () => boolean) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${condition.toString()}`);
  };
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    void fetch(`${config.reportUrl}/progress`, {
      body: JSON.stringify({ name, passed }),
      method: "POST",
    });
    if (!passed) {
      throw new Error(name);
    }
  };
  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  const media: import("../src/types").AniListMedia = {
    airingStatus: "RELEASING",
    aliases: ["Native Catalog"],
    averageScore: 62,
    bannerImage: null,
    coverImage: null,
    episodes: 12,
    format: "TV",
    genres: ["Drama"],
    mediaId: 99,
    nextAiringEpisode: { airingAt: Math.floor(Date.now() / 1000) + 6 * 86_400, episode: 2 },
    season: "SPRING",
    seasonYear: 2026,
    siteUrl: null,
    studios: ["Native Studio"],
    title: "Native Catalog",
  };
  const catalogRequests: import("../src/types").AniListCatalogFilters[] = [];
  window.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      let target: string;
      if (typeof input === "string") {
        target = input;
      } else if (input instanceof URL) {
        target = input.href;
      } else {
        target = input.url;
      }
      const address = new URL(target, location.origin);
      const path = address.pathname;
      if (path === "/api/anilist/catalog/options") {
        return Response.json({
          genres: ["Drama", "Action"],
          streaming: [{ id: 7, name: "Crunchyroll" }],
          tags: [{ category: "Setting", isAdult: false, name: "Space" }],
        });
      }
      if (path === "/api/anilist/catalog") {
        const filters = JSON.parse(
          String(init?.body)
        ) as import("../src/types").AniListCatalogFilters;
        catalogRequests.push(filters);
        const page = filters.page ?? 1;
        return Response.json({
          hasNextPage: page === 1,
          media: [
            {
              ...media,
              mediaId: page === 1 ? 99 : 100,
              title: page === 1 ? "Native Catalog" : "Next Page",
            },
          ],
          page,
        });
      }
      return await nativeFetch(input, init);
    },
    { preconnect: nativeFetch.preconnect }
  );
  const openMenu = async (selector: string) => {
    const trigger = document.querySelector<HTMLButtonElement>(selector)!;
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
    );
    await wait(() => !!document.querySelector('[role="menu"], [role="listbox"]'));
  };
  try {
    await wait(() => !!document.querySelector('a[href="/anilist"]'));
    document.querySelector<HTMLAnchorElement>('a[href="/anilist"]')!.click();
    await wait(() => !!document.querySelector(".anilist-status-filter"));
    await wait(
      () => !!document.querySelector('button[aria-label="View episodes for Native Library"]')
    );
    await openMenu(".anilist-status-filter");
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((element) => element.textContent?.includes("None · Browse"))!
      .click();
    await wait(
      () => !!document.querySelector('button[aria-label="Open Native Catalog on AniList"]')
    );
    check(
      "None loads the trending catalog",
      document.querySelector(".anilist-sort")?.textContent?.includes("Trending") === true &&
        catalogRequests.at(-1)?.sort === "trending"
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="More filters"]')!.click();
    await wait(() => !!document.querySelector("#anilist-airingStatus"));
    check(
      "Catalog exposes AniList advanced filters",
      [
        "airingStatus",
        "streamingOn",
        "countryOfOrigin",
        "source",
        "yearMin",
        "episodesMin",
        "durationMin",
      ].every((key) => !!document.getElementById(`anilist-${key}`))
    );
    await openMenu("#anilist-airingStatus");
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (element) => element.textContent?.trim() === "Airing"
    )!;
    option.focus();
    option.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
    option.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter" })
    );
    await wait(() => catalogRequests.at(-1)?.airingStatus === "RELEASING");
    check(
      "Catalog filters are sent to AniList",
      catalogRequests.at(-1)?.airingStatus === "RELEASING"
    );
    await wait(
      () => !!document.querySelector('button[aria-label="Open Native Catalog on AniList"]')
    );
    const card = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Native Catalog on AniList"]'
    )!;
    card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await wait(() => !!document.querySelector(".anime-preview"));
    check(
      "Hover preview shows episode, score, studio and genres",
      document.querySelector(".anime-preview")?.textContent?.includes("Ep 2 airing in") === true &&
        document.querySelector(".anime-preview")?.textContent?.includes("62%") === true &&
        document.querySelector(".anime-preview")?.textContent?.includes("Native Studio") === true
    );
    card.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.textContent?.trim() === "Load more anime")!
      .click();
    await wait(() => !!document.querySelector('button[aria-label="Open Next Page on AniList"]'));
    check(
      "Pagination appends titles",
      document.querySelectorAll(".anime-card").length === 2 && catalogRequests.at(-1)?.page === 2
    );
    await openMenu(".anilist-status-filter");
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
      .find((element) => element.textContent?.trim() === "Watching")!
      .click();
    await wait(
      () => !!document.querySelector('button[aria-label="View episodes for Native Library"]')
    );
    check(
      "Returning to a list preserves personal progress",
      document.querySelector(".anime-card")?.textContent?.includes("3 / 12 watched") === true
    );
    check("No native JavaScript errors", errors.length === 0);
    await nativeFetch(config.reportUrl, {
      body: JSON.stringify({ checks, errors, passed: true }),
      method: "POST",
    });
  } catch (error) {
    await nativeFetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        errors,
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  } finally {
    window.fetch = originalFetch;
  }
}
