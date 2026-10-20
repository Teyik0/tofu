// biome-ignore-all lint/style/noNonNullAssertion: Missing native UI targets must fail the smoke test.
// biome-ignore-all lint/performance/noAwaitInLoops: Native interactions must settle before continuing.
import {
  collectNativeErrors,
  createNativeCheck,
  createNativeWait,
  nativeClick,
  nativeSelectOption,
  nativeSetInput,
} from "../../../scripts/native-browser";
export async function libraryWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const { errors, layoutWarnings } = collectNativeErrors("layout-aware");
  const wait = createNativeWait({ interval: 30, timeout: 15_000 });
  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>("button, a")).find(
      (element) =>
        element.getAttribute("aria-label") === label || element.textContent?.trim() === label
    )!;
  const pickOption = (selector: string, label: string) =>
    nativeSelectOption(document.querySelector<HTMLElement>(selector)!, label, wait);
  const check = createNativeCheck(checks, `${config.reportUrl}/progress`);
  // Public HTTP fixtures isolate native UI interactions from a real AniList account.
  const nativeFetch = window.fetch.bind(window);
  const sample = (await (
    await nativeFetch("/api/anilist")
  ).json()) as import("../../../src/types").AniListState;
  sample.connectedUser = "Native test account";
  sample.authenticated = true;
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
  const listEditor: import("../../../src/types").AniListEditor = {
    entry: {
      advancedScores: [],
      completedAt: null,
      customLists: ["Weekend"],
      hiddenFromStatusLists: false,
      id: 100,
      mediaId: 10,
      notes: "Original notes",
      priority: 0,
      private: false,
      progress: 0,
      repeat: 0,
      score: 3,
      startedAt: { day: null, month: 10, year: 2026 },
      status: "CURRENT",
    },
    isFavourite: false,
    isFavouriteBlocked: false,
    options: {
      advancedScoring: [],
      advancedScoringEnabled: false,
      customLists: ["Weekend"],
      scoreFormat: "POINT_3",
    },
  };
  const editorWrites: import("../../../src/types").AniListListUpdate[] = [];
  let downloads = 0;
  const releaseSearch = Promise.withResolvers<void>();
  let pluginNavigation = Promise.withResolvers<void>();
  let pluginNavigationStarted = Promise.withResolvers<void>();
  let pluginNavigationFinished = Promise.withResolvers<void>();
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
      ) as import("../../../src/types").AniListCatalogFilters;
      return Response.json({
        hasNextPage: false,
        media: [
          {
            ...sample.entries[0],
            aliases: ["Native Trending"],
            automationId: undefined,
            averageScore: 62,
            mediaId: 10,
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
  const editorFixture = (path: string, init: RequestInit | undefined): Response | null => {
    if (path === "/api/anilist/entries/10/editor") {
      if (init?.method === "PUT") {
        const body = JSON.parse(
          String(init.body)
        ) as import("../../../src/types").AniListListUpdate;
        editorWrites.push(body);
        Object.assign(listEditor.entry!, body);
        if (body.status) {
          sample.entries[0]!.status = body.status;
        }
        return Response.json(sample);
      }
      return Response.json(listEditor);
    }
    if (path === "/api/anilist/entries/10/favourite") {
      listEditor.isFavourite = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
      return Response.json({ isFavourite: listEditor.isFavourite });
    }
    return null;
  };
  const delayedPluginNavigation = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined
  ) => {
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
  };
  const navigationFixture = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined
  ): Promise<Response | null> => {
    const url = fixtureUrl(input);
    if (url.searchParams.get("_furin") !== "data") {
      return null;
    }
    if (url.pathname === "/plugins") {
      return delayedPluginNavigation(input, init);
    }
    if (url.pathname !== "/anilist") {
      return null;
    }
    const response = await nativeFetch(input, init);
    const patched = await nativeFetch(`${config.reportUrl}/anilist-loader`, {
      body: JSON.stringify({ anilist: sample, payload: await response.json() }),
      method: "POST",
    });
    return new Response(`${await patched.text()}\n`, {
      headers: response.headers,
      status: response.status,
    });
  };
  const fixtureFetch: typeof window.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fixtureUrl(input);
      const path = url.pathname;
      const editorResponse = editorFixture(path, init);
      if (editorResponse) {
        return editorResponse;
      }
      if (path === "/api/anilist/open") {
        openedAniListUrl = (JSON.parse(String(init?.body)) as { url: string }).url;
        return Response.json({ opened: true, url: openedAniListUrl });
      }
      if (path === "/api/discover/add") {
        downloads += 1;
        return Response.json({});
      }
      const navigationResponse = await navigationFixture(input, init);
      if (navigationResponse) {
        return navigationResponse;
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
        (await (
          await fetch("/api/automation")
        ).json()) as import("../../../src/types").AutomationState
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
      await fetch("/api/host")
    ).json()) as import("../../../src/types").HostState;
    const rootInput = document.querySelector<HTMLInputElement>("#anilist-base-path")!;
    const organization = () => document.querySelector("#anilist-organization")?.textContent?.trim();
    check(
      "AniList proposes one thread per anime from the current folder",
      organization() === "One thread per anime" && rootInput.value === state.settings.downloadPath
    );
    const customRoot = `${state.settings.downloadPath}/anime`;
    nativeSetInput(rootInput, customRoot);
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
      ((await (await fetch("/api/state")).json()) as import("../../../src/types").LibraryState)
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
      element.getAttribute("aria-label") ??
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
    await wait(() => document.getElementById("anilist-genres-value")?.textContent === "Action");
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
      );
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
      document.querySelectorAll('[role="menu"] [role="menuitemcheckbox"]').length === 7
    );
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
      );
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
      nativeClick(choice);
      await wait(() => sample.visibleStatuses.length < selectedCount);
      await wait(() => choice.getAttribute("aria-disabled") !== "true");
      document
        .querySelector('[role="menu"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
        );
      await wait(() => !document.querySelector('[role="menu"]'));
    }
    await wait(() => document.getElementById("anilist-lists-value")?.textContent === "None");
    check(
      "No selected AniList lists shows and announces None",
      document.getElementById("anilist-lists-value")?.textContent === "None" &&
        accessibleName(statusFilter) === "Lists None" &&
        !document.querySelector('button[aria-label="View episodes for Native Example"]')
    );
    await wait(
      () => !!document.querySelector('button[aria-label="View episodes for Native Trending"]')
    );
    check(
      "None browses trending anime with real airing information",
      document.querySelector(".anilist-sort")?.textContent?.includes("Trending") === true &&
        document.querySelector(".anime-card")?.textContent?.trim() === "Native Trending"
    );
    const trendingCard = document.querySelector<HTMLButtonElement>(".anime-card")!;
    check(
      "Catalog cards show personal list status as an accessible dot",
      trendingCard.querySelector('[role="img"][aria-label="Watching"]') !== null &&
        trendingCard.getAttribute("aria-description")?.includes("Watching") === true
    );
    trendingCard.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await wait(() => !!document.querySelector(".anime-preview"));
    check(
      "Trending airing information appears in the hover preview",
      document.querySelector(".anime-preview")?.textContent?.includes("Ep 2 airing in") === true
    );
    trendingCard.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
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
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
      );
    await wait(() => !document.querySelector('[role="menu"]'));
    await wait(
      () => !!document.querySelector('button[aria-label="View episodes for Native Example"]')
    );
    document
      .querySelector<HTMLButtonElement>('button[aria-label="View episodes for Native Example"]')!
      .click();
    await wait(() => !!document.querySelector("#anime-list-status"));
    check(
      "Cards open the AniList editor with the account scoring format",
      [
        document.querySelector("#anime-list-status")?.textContent?.trim() === "Watching",
        !!button("Happy"),
        document.querySelector("#anime-list-start")?.textContent?.trim() === "2026-10",
      ].every(Boolean)
    );
    button("Add to favourites").click();
    await wait(
      () =>
        button("Remove from favourites")?.getAttribute("aria-pressed") === "true" &&
        !button("Remove from favourites").hasAttribute("disabled")
    );
    button("Remove from favourites").click();
    await wait(
      () =>
        button("Add to favourites")?.getAttribute("aria-pressed") === "false" &&
        !button("Add to favourites").hasAttribute("disabled")
    );
    check(
      "The favourite heart syncs both ways without leaving Tofu",
      listEditor.isFavourite === false
    );
    await pickOption("#anime-list-status", "Paused");
    await wait(() => editorWrites.length === 1);
    button("Neutral").click();
    await wait(() => editorWrites.length === 2);
    const notes = document.querySelector<HTMLTextAreaElement>("#anime-list-notes")!;
    notes.focus();
    nativeSetInput(notes, "Saved from Tofu");
    check("Typed notes wait for the field to lose focus", editorWrites.length === 2);
    notes.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await wait(() => editorWrites.length === 3);
    button("Episodes").click();
    await wait(() => !!document.querySelector(".anime-episode-row"));
    check(
      "Switching tabs hides the list form",
      getComputedStyle(
        document.querySelector(".anime-list-editor")!.closest('[data-slot="tabs-content"]')!
      ).display === "none"
    );
    button("My list").click();
    await wait(
      () => document.querySelector("#anime-list-status")?.textContent?.trim() === "Paused"
    );
    check(
      "List edits survive switching to episode downloads",
      document.querySelector<HTMLTextAreaElement>("#anime-list-notes")!.value === "Saved from Tofu"
    );
    check(
      "Each edit saves only its own field to AniList and preserves partial dates",
      [
        JSON.stringify(editorWrites[0]) === JSON.stringify({ status: "PAUSED" }),
        JSON.stringify(editorWrites[1]) === JSON.stringify({ score: 2 }),
        JSON.stringify(editorWrites[2]) === JSON.stringify({ notes: "Saved from Tofu" }),
        listEditor.entry!.startedAt?.day === null,
      ].every(Boolean)
    );
    const finish = document.querySelector<HTMLButtonElement>("#anime-list-finish")!;
    finish.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    finish.click();
    await wait(() => !!document.querySelector('.anime-calendar-day[data-outside="false"]'));
    const day = document.querySelector<HTMLButtonElement>(
      '.anime-calendar-day[data-outside="false"]'
    )!;
    const picked = day.getAttribute("aria-label")!;
    day.click();
    await wait(() => editorWrites.length === 4);
    const [year, month, date] = picked.split("-").map(Number);
    check(
      "Picking a calendar day saves the finish date immediately",
      JSON.stringify(editorWrites[3]) ===
        JSON.stringify({ completedAt: { day: date, month, year } }) &&
        finish.textContent?.trim() === picked
    );
    await pickOption("#anime-list-status", "Watching");
    await wait(() => editorWrites.length === 5);
    const progress = document.querySelector<HTMLInputElement>("#anime-list-progress")!;
    progress.focus();
    nativeSetInput(progress, "1");
    progress.blur();
    await wait(() => editorWrites.length === 6);
    progress.focus();
    nativeSetInput(progress, "0");
    progress.blur();
    await wait(() => editorWrites.length === 7);
    const privacy = document
      .getElementById("anime-list-private")!
      .closest('[data-slot="field"]')!
      .querySelector<HTMLElement>('[role="checkbox"]')!;
    privacy.click();
    await wait(() => editorWrites.length === 8);
    privacy.click();
    await wait(() => editorWrites.length === 9);
    check(
      "Progress and privacy autosave without changing partial dates or custom lists",
      [
        !button("Save to AniList"),
        JSON.stringify(editorWrites[5]) === JSON.stringify({ progress: 1 }),
        JSON.stringify(editorWrites[6]) === JSON.stringify({ progress: 0 }),
        JSON.stringify(editorWrites[7]) === JSON.stringify({ private: true }),
        JSON.stringify(editorWrites[8]) === JSON.stringify({ private: false }),
        listEditor.entry!.startedAt?.day === null,
        listEditor.entry!.customLists[0] === "Weekend",
        editorWrites.every(
          (write) => write.startedAt === undefined && write.customLists === undefined
        ),
      ].every(Boolean)
    );
    button("Episodes").click();
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
    button("Download").click();
    await wait(() => downloads === 1);
    check("Episode downloads remain available from the list editor", true);
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
      .querySelector<HTMLButtonElement>(".anilist-header-actions .anilist-account-button")!
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
