// biome-ignore-all lint/style/noNonNullAssertion: missing DOM targets must fail this end-to-end test immediately.
// biome-ignore-all lint/performance/noAwaitInLoops: wait for real native UI and network events.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server as Tracker } from "bittorrent-tracker";
import WebTorrent, { type Torrent } from "webtorrent";

const root = join(import.meta.dir, "..");
const folder = await mkdtemp(join(tmpdir(), "tofu-native-"));
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
function smokeWorkflow(name: string | undefined) {
  if (name === "anilist") {
    return { reportName: "native-anilist-smoke", workflow: anilistWorkflow };
  }
  if (name === "destination") {
    return { reportName: "native-destination-smoke", workflow: destinationWorkflow };
  }
  return { reportName: "native-smoke", workflow: nativeWorkflow };
}
const { workflow, reportName } = smokeWorkflow(process.env.TOFU_NATIVE_WORKFLOW);
const browserScript = `(${workflow.toString()})(${JSON.stringify({ expectedHash: createHash("sha256").update(payload).digest("hex"), magnet, reportUrl: `http://127.0.0.1:${collector.port}`, secondaryTorrentBytes: Array.from(secondarySeed.torrentFile), torrentBytes: Array.from(seed.torrentFile), urls })})`;
const scriptPath = join(folder, "workflow.js");
await Bun.write(scriptPath, browserScript);
const native = Bun.spawn(
  [join(root, `build/dev-macos-${process.arch}/Tofu-dev.app/Contents/MacOS/launcher`)],
  {
    cwd: root,
    env: {
      ...process.env,
      TOFU_DATA_DIR: join(folder, "state"),
      TOFU_DOWNLOAD_DIR: join(folder, "downloads"),
      TOFU_MODE: "desktop",
      TOFU_SMOKE_SCRIPT: scriptPath,
    },
    stderr: "pipe",
    stdout: "pipe",
  }
);
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
    `${await new Response(native.stdout).text()}\n${await new Response(native.stderr).text()}`
  );
  collector.stop(true);
  await new Promise<void>((resolve) => seedClient.destroy(() => resolve()));
  for (const tracker of trackers) {
    await new Promise<void>((resolve) => tracker.close(resolve));
  }
  await rm(folder, { force: true, recursive: true });
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
      document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button, a")
    ).find((element) => element.textContent?.trim() === text);
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
  const choose = async (selector: string, label: string) => {
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
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    await fetch("/api/desktop/open", { method: "POST" });
    await document.fonts.ready;
    check(
      "React hydrated and engine connected",
      document.body.textContent?.includes("Engine connected") === true
    );
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
      (await (await fetch("/")).text()).includes("Engine connected")
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
    await choose('[aria-label="Sort torrents"]', "Name");
    await choose('[aria-label="Sort torrents"]', "Newest first");
    check("Select controls support keyboard selection and dismissal", true);
    const sidebarToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse sidebar"]'
    )!;
    // WebKit tracks keyboard modality separately from programmatic focus.
    (document.activeElement as HTMLElement | null)?.blur();
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    sidebarToggle.focus();
    await wait(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"][data-open]')
      ).some(
        (tooltip) =>
          tooltip.textContent === "Collapse sidebar" && tooltip.getClientRects().length > 0
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
    click("Series");
    await wait(() => location.pathname.endsWith(seriesId));
    const sidebar = document.querySelector('[data-slot="sidebar-container"]');
    document.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]')!.click();
    await wait(
      () =>
        document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state") === "collapsed"
    );
    const sidebarIconsCentered = () => {
      const bounds = sidebar!.getBoundingClientRect();
      const center = bounds.left + bounds.width / 2;
      const icons = Array.from(sidebar!.querySelectorAll("svg")).filter(
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
      const offsets = Array.from(sidebar!.querySelectorAll("svg")).map((icon) => {
        const iconBounds = icon.getBoundingClientRect();
        return {
          label: icon.parentElement?.textContent,
          offset: iconBounds.left + iconBounds.width / 2 - bounds.left - bounds.width / 2,
          width: iconBounds.width,
        };
      });
      throw new Error(
        `Sidebar centering : ${JSON.stringify({ connected: sidebar!.isConnected, offsets })}`
      );
    });
    check("Collapsed sidebar icons centered with symmetric margins", true);
    const followedId = shared.find((tab) => tab.name === "Following")!.id;
    click("Following");
    await wait(() => location.pathname === `/library/destinations/${followedId}`);
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
    document.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]')!.click();
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
    document.querySelector<HTMLButtonElement>('button[aria-label^="Pause Test"]')!.click();
    await wait(async () => (await state()).detail?.status === "paused");
    await wait(() => !!document.querySelector('button[aria-label^="Resume Test"]'));
    document.querySelector<HTMLButtonElement>('button[aria-label^="Resume Test"]')!.click();
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
    click("Plugins");
    await wait(() => !!document.querySelector("#plugin-nyaa"));
    check(
      "Five plugins offered, initially disabled",
      document.querySelectorAll(".plugin-card").length === 5 &&
        (await automationState()).plugins.every((plugin) => !plugin.enabled)
    );
    document.querySelector<HTMLInputElement>("#plugin-nyaa")!.click();
    await wait(async () =>
      (await automationState()).plugins.some((plugin) => plugin.id === "nyaa" && plugin.enabled)
    );
    await wait(() => !document.querySelector<HTMLInputElement>("#plugin-nyaa")!.disabled);
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
    const pluginsTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((button) => button.textContent?.trim() === "Plugins")!;
    pluginsTab.focus();
    pluginsTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    pluginsTab.click();
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
    click("AniList");
    await wait(() => !!document.querySelector("#anilist-client-id"));
    set(document.querySelector<HTMLInputElement>("#anilist-client-id")!, "9037");
    set(
      document.querySelector<HTMLInputElement>("#anilist-client-secret")!,
      "native-oauth-private"
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    click("Save connection");
    await wait(async () => (await (await fetch("/api/anilist")).json()).hasClientSecret === true);
    check(
      "AniList OAuth configuration persisted without exposing the secret",
      !(await (await fetch("/api/anilist")).text()).includes("native-oauth-private")
    );
    await wait(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Prepare tracking" && !button.disabled
      )
    );
    click("Prepare tracking");
    await wait(() => !!document.querySelector("#automation-language"));
    check(
      "AniList list preferences and tracked statuses configurable",
      document.querySelector<HTMLInputElement>("#automation-language")!.value === "VOSTFR" &&
        document.querySelector<HTMLInputElement>("#anilist-CURRENT")!.checked === true &&
        document.querySelector<HTMLInputElement>("#anilist-PLANNING")!.checked === true
    );
    check(
      "AniList proposes one thread per anime from the current folder and waits for selection before creation",
      document.querySelector<HTMLSelectElement>("#anilist-organization")!.value === "per-anime" &&
        document.querySelector<HTMLInputElement>("#anilist-base-path")!.value === movedPath &&
        Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
          (button) => button.textContent?.trim() === "Create AniList tracking" && button.disabled
        )
    );
    const organization = document.querySelector<HTMLSelectElement>("#anilist-organization")!;
    organization.value = "shared";
    organization.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(() => !document.querySelector("#anilist-base-path"));
    check("AniList can group all anime into one thread", organization.value === "shared");
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
        document.querySelector<HTMLInputElement>("#automation-resolution")!.value.includes("1080p")
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
        automation.resolutions.join(",") === "1080p,720p" &&
        automation.sources[0] === "tsundere"
    );
    await fetch(`/api/automations/${automation.id}`, { method: "DELETE" });
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
    await wait(() => !document.querySelector('[role="dialog"][data-open]'));
    click("Preferences");
    await wait(
      () => !!document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')
    );
    set(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="number"]')!, "128");
    await new Promise((resolve) => setTimeout(resolve, 100));
    document
      .querySelector<HTMLFormElement>('[role="dialog"] form, [role="alertdialog"] form')!
      .requestSubmit();
    await wait(async () => (await state()).settings.downloadLimit === 128 * 1024);
    await wait(
      () => !document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')
    );
    check("Preferences saved through the form", true);
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove torrent"]')!.click();
    await wait(
      () => !!document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')
    );
    document
      .querySelector<HTMLFormElement>('[role="dialog"] form, [role="alertdialog"] form')!
      .requestSubmit();
    await wait(async () => (await state()).torrents.length === 0);
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
    await wait(() => location.pathname === "/library/all");
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
    await wait(() => location.pathname === "/library/all");
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
  const wait = async (condition: () => boolean) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      if (condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out : ${condition.toString()}`);
  };
  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (element) => element.textContent?.trim() === label
    )!;
  const check = (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (!passed) {
      throw new Error(name);
    }
  };
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    await wait(() =>
      performance
        .getEntriesByType("resource")
        .some((entry) => entry.name.includes("/_furin/sync/changes"))
    );
    button("Plugins").click();
    await wait(() => !!document.querySelector("#plugin-nyaa"));
    const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (element) => element.textContent?.trim() === "AniList"
    )!;
    tab.focus();
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    tab.click();
    await wait(() => !!document.querySelector("#anilist-base-path"));
    const state = (await (
      await fetch("/api/state")
    ).json()) as import("../src/types").DashboardState;
    const rootInput = document.querySelector<HTMLInputElement>("#anilist-base-path")!;
    const organization = document.querySelector<HTMLSelectElement>("#anilist-organization")!;
    check(
      "AniList proposes one thread per anime from the current folder",
      organization.value === "per-anime" && rootInput.value === state.settings.downloadPath
    );
    const customRoot = `${state.settings.downloadPath}/anime`;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      rootInput,
      customRoot
    );
    rootInput.dispatchEvent(new Event("input", { bubbles: true }));
    rootInput.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(() => rootInput.value === customRoot && !button("Prepare tracking").disabled);
    button("Prepare tracking").click();
    await wait(
      () => !!document.querySelector("#automation-language") && !button("Prepare tracking").disabled
    );
    check(
      "Custom root folder and Nyaa preferences are preserved",
      rootInput.value === customRoot &&
        document.querySelector<HTMLInputElement>("#automation-language")!.value === "VOSTFR"
    );
    check("Creation waits for AniList title approval", button("Create AniList tracking").disabled);
    organization.value = "shared";
    organization.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(() => !document.querySelector("#anilist-base-path"));
    check(
      "All anime can use the same thread",
      organization.value === "shared" && !document.querySelector('[aria-label="Proposed threads"]')
    );
    check(
      "No thread created during preparation",
      ((await (await fetch("/api/state")).json()) as import("../src/types").DashboardState)
        .destinations.length === 1
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
