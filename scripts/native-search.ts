// biome-ignore-all lint/performance/noAwaitInLoops: poll the real native WebView sequentially.
import { join } from "node:path";
import { acquireInstance, resolveInstanceConfig } from "../src/api/lib/instance";
import { AutomationService } from "../src/api/modules/automation/service";
import { pluginEndpoints } from "../src/api/modules/plugins/service";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import type { FeedRelease, InstanceProfile } from "../src/types";

export async function seedSearchReleases(
  directory: string,
  sourceUrl: string,
  profile: InstanceProfile
) {
  await using resources = new AsyncDisposableStack();
  const lease = await acquireInstance(
    resolveInstanceConfig({
      dataDir: join(directory, "state"),
      desktop: true,
      downloadPath: join(directory, "downloads"),
      homeDir: directory,
      platform: process.platform,
      port: "0",
      profile,
    })
  );
  resources.defer(() => lease.close());
  const engine = await TorrentEngine.open({
    dataDir: join(directory, "state"),
    downloadPath: join(directory, "downloads"),
    network: { dht: false, lsd: false, natPmp: false, natUpnp: false, tracker: false, utp: false },
  });
  resources.defer(() => engine.close());
  const service = await AutomationService.open({
    dataDir: join(directory, "state"),
    endpoints: { ...pluginEndpoints, nyaa: sourceUrl },
    engine: () => engine,
    now: Date.now,
  });
  resources.defer(() => service.close());
  service.configure("nyaa", { enabled: true });
  service.configure("tsundere", { enabled: true });
  return (await service.discover("Second", ["nyaa"])).releases;
}

export async function globalSearchWorkflow(config: {
  expectedHash: string;
  magnet: string;
  reportUrl: string;
  secondaryTorrentBytes: number[];
  searchReleases: FeedRelease[];
}) {
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
    void fetch(`${config.reportUrl}/progress`, {
      body: JSON.stringify({ name, passed }),
      method: "POST",
    });
    if (!passed) {
      throw new Error(name);
    }
  };
  const click = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) {
      throw new Error(`Missing target: ${selector}`);
    }
    element.click();
  };
  const setQuery = (value: string) => {
    const input = document.querySelector<HTMLInputElement>("#global-search-input");
    if (!input) {
      throw new Error("Search input missing");
    }
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const send = async (path: string, body: object) => {
    const response = await fetch(`/api${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response;
  };
  const state = async () =>
    (await (
      await fetch("/api/state?detail=false")
    ).json()) as import("../src/types").DashboardState;
  const press = (key: string) =>
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  const originalFetch = window.fetch;
  const sourceQueries: { query: string; sources: string[] }[] = [];
  const errors: string[] = [];
  window.addEventListener("error", (event) => {
    if (event.error) {
      errors.push(String(event.error));
    }
  });
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  try {
    await wait(() => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false);
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Search everything"]');
    check("Global search is accessible from the sidebar", !!trigger);
    await wait(() => {
      if (document.querySelector(".global-search-dialog[data-open]")) {
        return true;
      }
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true })
      );
      return false;
    });
    await wait(() => document.activeElement?.getAttribute("aria-label") === "Search everything");
    check(
      "Command K opens global search and focuses the input",
      document.activeElement?.getAttribute("aria-label") === "Search everything"
    );
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    await wait(() => !document.querySelector(".global-search-dialog[data-open]"));
    check("Escape closes global search", true);
    const initial = await state();
    const path = initial.destinations[0]?.downloadPath;
    if (!path) {
      throw new Error("Default download path missing");
    }
    const thread = (await (
      await send("/destinations", { downloadPath: `${path}/anime`, name: "Anime" })
    ).json()) as { id: string };
    const downloaded = (await (
      await send("/torrents", { destinationId: thread.id, paused: false, source: config.magnet })
    ).json()) as { id: string };
    await wait(async () =>
      (await state()).torrents.some(
        (torrent) => torrent.id === downloaded.id && torrent.progress === 1
      )
    );
    await wait(() => !!document.querySelector(`a[href="/thread/${thread.id}"]`));
    click('button[aria-label="Search everything"]');
    await wait(() => !!document.querySelector("#global-search-input"));
    const localScope = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (element) => element.textContent === "My torrents"
    );
    localScope?.click();
    setQuery("real tofu");
    await wait(
      () =>
        document
          .querySelector(".global-search-result-copy")
          ?.textContent?.includes("Real Tofu test.bin") === true
    );
    await wait(
      () =>
        document
          .querySelector(".global-search-results")
          ?.textContent?.includes("Anime · Seeding") === true
    );
    check(
      "Global results include completed torrents and their thread",
      document.querySelector(".global-search-results")?.textContent?.includes("Anime · Seeding") ===
        true
    );
    document.querySelector<HTMLInputElement>("#global-search-input")?.focus();
    press("ArrowDown");
    await new Promise((resolve) => setTimeout(resolve, 60));
    press("ArrowUp");
    await wait(() => !!document.querySelector(".global-search-result[data-highlighted]"));
    document.querySelector<HTMLInputElement>("#global-search-input")?.focus();
    await wait(() => document.activeElement?.id === "global-search-input");
    press("Enter");
    await wait(
      () =>
        location.pathname === `/thread/${thread.id}` &&
        !document.querySelector(".global-search-dialog[data-open]")
    );
    await wait(
      () =>
        document.querySelector(".detail-pane")?.textContent?.includes("Real Tofu test.bin") === true
    );
    check("Keyboard selection opens the torrent in its destination thread", true);

    const filter = document.querySelector<HTMLInputElement>('[aria-label="Filter torrents"]');
    if (!filter) {
      throw new Error("Thread filter missing");
    }
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      filter,
      "missing"
    );
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(() => document.querySelectorAll(".torrent-table tbody tr").length === 0);
    click('button[aria-label="Search everything"]');
    await wait(() => !!document.querySelector("#global-search-input"));
    Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
      .find((element) => element.textContent === "My torrents")
      ?.click();
    setQuery("real tofu");
    await wait(() => !!document.querySelector(".global-search-result"));
    click(".global-search-result");
    await wait(() => !document.querySelector(".global-search-dialog[data-open]"));
    await wait(
      () =>
        document.querySelector(".detail-pane")?.textContent?.includes("Real Tofu test.bin") === true
    );
    check(
      "Opening a local result clears filters that would hide its details",
      document.querySelector<HTMLInputElement>('[aria-label="Filter torrents"]')?.value === ""
    );

    // Mock the discovery HTTP boundary; adding the cached release and peer transfer stay real.
    window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      let target: string;
      if (typeof input === "string") {
        target = input;
      } else {
        target = input instanceof URL ? input.href : input.url;
      }
      const url = new URL(target, location.origin);
      if (url.pathname !== "/api/discover") {
        return originalFetch(input, init);
      }
      const body = JSON.parse(String(init?.body)) as { query: string; sources: string[] };
      sourceQueries.push(body);
      if (body.query === "stale") {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return Response.json({
          errors: [],
          releases: config.searchReleases.map((release) => ({ ...release, title: "Stale result" })),
        });
      }
      if (body.sources[0] === "tsundere") {
        return Response.json({
          errors: [{ message: "Source temporarily unavailable", sourceId: "tsundere" }],
          releases: [],
        });
      }
      return Response.json({ errors: [], releases: config.searchReleases });
    }, originalFetch);
    click('button[aria-label="Search everything"]');
    await wait(() => !!document.querySelector("#global-search-input"));
    setQuery("stale");
    await wait(() => sourceQueries.some((query) => query.query === "stale"));
    setQuery("Second");
    await wait(
      () =>
        document
          .querySelector(".global-search-results")
          ?.textContent?.includes("Second torrent Tofu.bin") === true
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    check(
      "Old source responses cannot replace the current query",
      !document.querySelector(".global-search-results")?.textContent?.includes("Stale result")
    );
    check(
      "Only enabled source plugins are queried",
      sourceQueries.every(
        (query) =>
          query.sources.length === 1 && ["nyaa", "tsundere"].includes(query.sources[0] ?? "")
      )
    );
    check(
      "A failed source preserves releases from the other source",
      document
        .querySelector(".global-search-source-status")
        ?.textContent?.includes("Source temporarily unavailable") === true
    );
    check(
      "Unknown statistics stay unknown",
      document.querySelector(".global-search-results")?.textContent?.includes("— seeds") === true
    );
    click(".global-search-result");
    await wait(() => !!document.querySelector(".global-search-review"));
    check("Reviewing a release does not start a download", (await state()).torrents.length === 1);
    check(
      "The current thread is selected by default",
      document.querySelector("#global-search-destination")?.textContent?.includes("Anime") === true
    );
    click("#global-search-destination");
    await wait(() => !!document.querySelector('[role="option"]'));
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (element) => element.textContent?.trim() === "Downloads"
    );
    if (!option) {
      throw new Error("Destination option missing");
    }
    option.click();
    await wait(
      () =>
        document.querySelector("#global-search-destination")?.textContent?.includes("Downloads") ===
        true
    );
    const downloadButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".global-search-review button")
    ).find((button) => button.textContent?.trim() === "Download");
    if (!downloadButton) {
      throw new Error("Download button missing");
    }
    downloadButton.click();
    await wait(async () =>
      (await state()).torrents.some(
        (torrent) => torrent.name === "Second torrent Tofu.bin" && torrent.progress === 1
      )
    );
    const added = (await state()).torrents.find(
      (torrent) => torrent.name === "Second torrent Tofu.bin"
    );
    check(
      "Search downloads through real peers into the selected thread",
      added?.destinationId === initial.destinations[0]?.id && added?.progress === 1
    );
    if (!added) {
      throw new Error("The downloaded torrent is missing");
    }
    const content = await fetch(`/api/torrents/${added.id}/files/0/content`);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", await content.arrayBuffer()))
    )
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    check("The downloaded file contains the original peer bytes", hash === config.expectedHash);
    await wait(
      () =>
        document
          .querySelector(".global-search-results")
          ?.textContent?.includes("Already in Downloads") === true
    );
    const existingResult = Array.from(
      document.querySelectorAll<HTMLElement>(".global-search-result")
    ).find((element) => element.textContent?.includes("Already in Downloads"));
    existingResult?.click();
    await wait(
      () =>
        document
          .querySelector(".global-search-review")
          ?.textContent?.includes("Open existing torrent") === true
    );
    check(
      "Existing downloads offer to open instead of downloading twice",
      !Array.from(document.querySelectorAll(".global-search-review button")).some(
        (button) => button.textContent?.trim() === "Download"
      )
    );
    press("Escape");
    await wait(() => !document.querySelector(".global-search-dialog[data-open]"));
    click('button[aria-label="Settings"]');
    await wait(() => location.pathname.startsWith("/options"));
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "k" }));
    await wait(() => !!document.querySelector(".global-search-dialog[data-open]"));
    check("Control K opens search from preferences too", true);
    check("No JavaScript errors", errors.length === 0);
    await fetch(config.reportUrl, {
      body: JSON.stringify({ checks, passed: true }),
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
  } finally {
    window.fetch = originalFetch;
  }
}
