// biome-ignore-all lint/style/noNonNullAssertion: Missing native UI targets must fail the smoke test.
// biome-ignore-all lint/performance/noAwaitInLoops: Native interactions must settle before continuing.

import type { DashboardState } from "../src/types";
import {
  collectNativeErrors,
  createNativeCheck,
  createNativeWait,
  nativeClick,
  nativeSelectOption,
  nativeSetInput,
} from "./native-browser";
export async function nativeWorkflow(config: {
  magnet: string;
  secondaryTorrentBytes: number[];
  torrentBytes: number[];
  urls: string[];
  reportUrl: string;
  expectedHash: string;
}) {
  const originalFetch = window.fetch;
  // Provider authentication is tested through the API; native UI checks use fixture credentials.
  window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    if (url.pathname === "/api/plugins/jev/connect" && init?.method === "POST") {
      return originalFetch("/api/plugins/jev", { ...init, method: "PUT" });
    }
    return originalFetch(input, init);
  }, originalFetch);
  const checks: { name: string; passed: boolean }[] = [];
  const { errors, layoutWarnings } = collectNativeErrors("layout-aware");
  const wait = createNativeWait({ interval: 100, timeout: 15_000 });
  const click = nativeClick;
  const set = nativeSetInput;
  const check = createNativeCheck(checks, `${config.reportUrl}/progress`);
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
  const choose = (selector: string, label: string) =>
    nativeSelectOption(document.querySelector<HTMLElement>(selector)!, label, wait);
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
    await verifyUpdateChecks(check, wait);
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
    await fetch("/api/desktop/open", { method: "POST" });
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
    await wait(() => !document.querySelector('[data-slot="tooltip-content"][data-open]'));
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
      click(document.querySelector<HTMLButtonElement>('button[aria-label="Create a tab"]')!);
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
        .every(hasExpectedCollapsedIconSize)
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
    await wait(() => document.querySelectorAll(".torrent-table tbody tr").length === 1);
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
      document.querySelector<HTMLInputElement>('[aria-label="Filter torrents"]')!,
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
    set(document.querySelector<HTMLInputElement>('[aria-label="Filter torrents"]')!, "");
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
      "Credential setup links point to the provider key pages",
      [
        document.querySelector<HTMLAnchorElement>('a[href="https://c411.org/user/integrations"]')
          ?.target === "_blank",
        document.querySelector<HTMLAnchorElement>('a[href="https://console.typesafe.ai/keys"]')
          ?.target === "_blank",
        document.querySelector('label[for="key-c411"]')?.textContent?.includes("Torznab link") ===
          true,
      ].every(Boolean)
    );
    check(
      "Five built-in plugins are offered and initially disabled",
      document.querySelectorAll(".plugin-card:not([data-plugin-contributions])").length === 5 &&
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
      ).find((button) => button.textContent?.trim() === "Validate and save");
      return !!save && !save.disabled;
    });
    Array.from(
      document
        .querySelector("#key-jev")!
        .closest("article")!
        .querySelectorAll<HTMLButtonElement>("button")
    )
      .find((button) => button.textContent?.trim() === "Validate and save")!
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
    await verifyTorrentSettings(check, wait, state);
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
    await wait(async () => {
      const { detail: droppedDetail } = await state();
      return droppedDetail?.status === "seeding" && droppedDetail.files[0]?.progress === 1;
    });
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
      [remaining.destinationId === "default", remaining.status === "seeding"].every(Boolean)
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
    const quick = (await (
      await fetch("/api/destinations", {
        body: JSON.stringify({ downloadPath: `${originalPath}/quick`, name: "Quick delete" }),
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
      "Sidebar deletion asks for confirmation and Cancel preserves the tab",
      (await state()).destinations.some((tab) => tab.id === quick.id)
    );
    document
      .querySelector<HTMLButtonElement>(quickDelete)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await wait(async () => !(await state()).destinations.some((tab) => tab.id === quick.id));
    check(
      "Shift-click deletes a tab without a confirmation dialog",
      !document.querySelector('[role="alertdialog"][data-open]')
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

function hasExpectedCollapsedIconSize(icon: Element) {
  const bounds = icon.getBoundingClientRect();
  let size = 18;
  if (icon.closest('[data-sidebar="menu-button"]')) {
    size = 20;
  }
  if (icon.closest(".sidebar-brand")) {
    size = 28;
  }
  return bounds.width === size && bounds.height === size;
}

async function verifyUpdateChecks(
  check: ReturnType<typeof createNativeCheck>,
  wait: ReturnType<typeof createNativeWait>
) {
  const button = () => document.querySelector<HTMLButtonElement>(".sidebar-update button")!;
  await wait(() => !button().disabled);
  button().click();
  await wait(() => button().disabled);
  await wait(() => !button().disabled);
  button().click();
  await wait(() => button().disabled);
  await wait(() => !button().disabled);
  check("Update checks finish and can run again without animation events", true);
}

async function verifyTorrentSettings(
  check: ReturnType<typeof createNativeCheck>,
  wait: ReturnType<typeof createNativeWait>,
  state: () => Promise<DashboardState>
) {
  const defaultTorrentApp = document.querySelector<HTMLButtonElement>("#default-torrent-app")!;
  const instance = (await (
    await fetch("/api/instance")
  ).json()) as import("../src/types").ApplicationInstance;
  check(
    "Default torrent application is available only in the installed release",
    !!defaultTorrentApp && defaultTorrentApp.disabled === (instance.profile !== "release")
  );
  const deleteSource = () =>
    document.querySelector<HTMLButtonElement>("#delete-torrent-file-after-add")!;
  check(
    "Torrent source deletion starts disabled",
    deleteSource().getAttribute("aria-checked") === "false" &&
      !(await state()).settings.deleteTorrentFileAfterAdd
  );
  deleteSource().click();
  await wait(
    async () =>
      (await state()).settings.deleteTorrentFileAfterAdd &&
      deleteSource().getAttribute("aria-checked") === "true" &&
      !deleteSource().disabled
  );
  check("The source deletion switch saves automatically", true);
  deleteSource().click();
  await wait(
    async () =>
      !(await state()).settings.deleteTorrentFileAfterAdd &&
      deleteSource().getAttribute("aria-checked") === "false" &&
      !deleteSource().disabled
  );
  check("The source deletion switch can be turned off", true);
  nativeClick("Downloads");
  await wait(() => !!document.querySelector("#seeding-connections"));
  const seedingButton = (label: "Balanced" | "Incoming only") =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("#seeding-connections button")).find(
      (button) => button.textContent?.trim() === label
    )!;
  check(
    "Seeding connections default to Balanced",
    seedingButton("Balanced").getAttribute("aria-pressed") === "true" &&
      (await state()).settings.seedingConnectionMode === "balanced"
  );
  nativeClick(seedingButton("Incoming only"));
  await wait(
    async () =>
      (await state()).settings.seedingConnectionMode === "incoming-only" &&
      seedingButton("Incoming only").getAttribute("aria-pressed") === "true" &&
      !seedingButton("Incoming only").disabled
  );
  check("Incoming only seeding saves automatically", true);
  nativeClick(seedingButton("Balanced"));
  await wait(
    async () =>
      (await state()).settings.seedingConnectionMode === "balanced" &&
      seedingButton("Balanced").getAttribute("aria-pressed") === "true" &&
      !seedingButton("Balanced").disabled
  );
  check("Balanced seeding can be restored", true);
  nativeClick("General");
  await wait(() => !!document.querySelector("#delete-torrent-file-after-add"));
}
