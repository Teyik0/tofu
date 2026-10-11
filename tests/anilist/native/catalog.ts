// biome-ignore-all lint/style/noNonNullAssertion: Missing native UI targets must fail the smoke test.
// biome-ignore-all lint/performance/noAwaitInLoops: Native interactions must settle before continuing.
import {
  collectNativeErrors,
  createNativeCheck,
  createNativeWait,
} from "../../../scripts/native-browser";
export async function catalogWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const { errors } = collectNativeErrors("exceptions");
  const wait = createNativeWait({ interval: 30, timeout: 15_000 });
  const check = createNativeCheck(checks, `${config.reportUrl}/progress`);
  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  const visiblePreviews = () =>
    Array.from(document.querySelectorAll<HTMLElement>(".anime-preview-popup")).filter(
      (preview) => getComputedStyle(preview).visibility !== "hidden"
    );
  const checkHoverDismissal = async (card: HTMLButtonElement) => {
    const cardBounds = card.getBoundingClientRect();
    const leaveDetails = {
      clientX: cardBounds.right,
      clientY: cardBounds.top + cardBounds.height / 2,
      relatedTarget: document.querySelector(".anime-preview-popup"),
    };
    card.dispatchEvent(new MouseEvent("mouseleave", { ...leaveDetails, bubbles: false }));
    card.dispatchEvent(new MouseEvent("mouseout", { ...leaveDetails, bubbles: true }));
    check(
      "Leaving a card immediately removes its preview, even when moving towards the details",
      visiblePreviews().length === 0
    );
    card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await wait(() => visiblePreviews().length === 1);
    document.querySelector(".anilist-library")!.dispatchEvent(new Event("scroll"));
    check(
      "Scrolling immediately removes the preview without waiting for mouse movement",
      visiblePreviews().length === 0
    );
  };
  const media: import("../../../src/types").AniListMedia = {
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
  const catalogRequests: import("../../../src/types").AniListCatalogFilters[] = [];
  const releaseRequests: string[] = [];
  const nextPage = Promise.withResolvers<void>();
  const downloadRequests: {
    destinationId: string;
    id: string;
    paused: boolean;
    sourceId: import("../../../src/types").SourcePluginId;
  }[] = [];
  let externalOpens = 0;
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
      if (path === "/api/anilist/open") {
        externalOpens += 1;
        return Response.json({ opened: true });
      }
      if (path === "/api/anilist/entries/99/releases") {
        releaseRequests.push(path);
        return Response.json({
          errors: [],
          releases: [
            {
              codec: null,
              downloadUrl: `magnet:?xt=urn:btih:${"1".repeat(40)}`,
              episode: 1,
              id: "catalog-release",
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
              title: "Native Catalog - 01 VOSTFR 1080p",
              workTitle: "Native Catalog",
            },
          ],
          torrents: [],
        } satisfies import("../../../src/types").AniListReleases);
      }
      if (path === "/api/discover/add") {
        downloadRequests.push(JSON.parse(String(init?.body)));
        return Response.json({});
      }
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
        ) as import("../../../src/types").AniListCatalogFilters;
        catalogRequests.push(filters);
        const page = filters.page ?? 1;
        if (page > 1) {
          await nextPage.promise;
        }
        return Response.json({
          hasNextPage: page === 1,
          media:
            page === 1
              ? Array.from({ length: 25 }, (_, index) => ({
                  ...media,
                  ...(index === 1
                    ? {
                        airingStatus: "NOT_YET_RELEASED",
                        averageScore: null,
                        episodes: null,
                        format: null,
                        nextAiringEpisode: null,
                        season: null,
                        seasonYear: null,
                        studios: [],
                      }
                    : {}),
                  mediaId: 99 + index,
                  title: index === 0 ? "Native Catalog" : `Catalog Title ${index}`,
                }))
              : [media, { ...media, mediaId: 124, title: "Next Page" }],
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
    await wait(() => trigger.getAttribute("aria-expanded") === "true");
  };
  const checkCatalogFilters = async () => {
    const currentFilters = () => catalogRequests.findLast((filters) => (filters.page ?? 1) === 1);
    await openMenu('button[aria-labelledby^="anilist-genres-label"]');
    const genreOption = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')
    ).find((element) => element.textContent?.trim() === "Drama")!;
    genreOption.click();
    await wait(() => currentFilters()?.genres?.includes("Drama") === true);
    check(
      "Selected genres appear beside the tag icon directly below the filters",
      !!document.querySelector(".anilist-active-filters > .anilist-filter-tag") &&
        document
          .querySelector('.anilist-filter-chip[aria-label="Remove filter Drama"]')
          ?.textContent?.trim() === "Drama"
    );
    check(
      "The genre menu stays open for multiple selections",
      !!document.querySelector('[role="menu"]')
    );
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
      .find((element) => element.textContent?.trim() === "Action")!
      .click();
    await wait(() => currentFilters()?.genres?.length === 2);
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
      .find((element) => element.textContent?.trim() === "Space")!
      .click();
    await wait(() => currentFilters()?.tags?.includes("Space") === true);
    check(
      "Genres and tags append separate chips and the field summarizes every selection",
      Array.from(document.querySelectorAll(".anilist-filter-chip:not(.anilist-clear-filters)"))
        .map((element) => element.textContent?.trim())
        .join(",") === "Drama,Action,Space" &&
        document.querySelector(".anilist-genre-count")?.textContent === "+2" &&
        document.getElementById("anilist-genres-value")?.textContent === "Drama, Action, Space" &&
        document.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"]').length === 3
    );
    const genreTrigger = document.querySelector<HTMLButtonElement>(
      'button[aria-labelledby^="anilist-genres-label"]'
    )!;
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
      );
    await wait(() => genreTrigger.getAttribute("aria-expanded") === "false");
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove filter Drama"]')!.click();
    await wait(() => currentFilters()?.genres?.join(",") === "Action");
    check(
      "Removing one genre preserves the other genre and tag",
      currentFilters()?.tags?.includes("Space") === true &&
        document.querySelector(".anilist-genre-count")?.textContent === "+1"
    );
    await openMenu("#anilist-year");
    const yearOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (element) => element.textContent?.trim() === "2025"
    )!;
    yearOption.focus();
    yearOption.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
    yearOption.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter" })
    );
    await wait(() => currentFilters()?.year === 2025);
    check(
      "Year selections join the genre and tag chips",
      !!document.querySelector('button[aria-label="Remove filter 2025"]') &&
        !!document.querySelector('button[aria-label="Clear year"]')
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Clear year"]')!.click();
    await wait(() => currentFilters()?.year === undefined);
    check(
      "Clearing the year preserves the selected genre and tag",
      document.querySelector("#anilist-year")?.textContent?.trim() === "Any" &&
        currentFilters()?.genres?.join(",") === "Action" &&
        currentFilters()?.tags?.join(",") === "Space"
    );
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Clear genres and tags"]')!
      .click();
    await wait(
      () => currentFilters()?.genres?.length === 0 && currentFilters()?.tags?.length === 0
    );
    check(
      "Clearing genres and tags restores Any and removes their chips",
      document.getElementById("anilist-genres-value")?.textContent === "Any" &&
        document.querySelectorAll(".anilist-filter-chip").length === 0
    );
    await openMenu("#anilist-format");
    for (const label of ["Movie", "TV Show"]) {
      const choice = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')
      ).find((element) => element.textContent?.trim() === label)!;
      choice.click();
      await wait(() => choice.getAttribute("aria-checked") === "true");
    }
    await wait(() => currentFilters()?.formats?.length === 2);
    check(
      "Multiple formats reach the catalog request and keep the menu open",
      currentFilters()?.formats?.join(",") === "MOVIE,TV" &&
        document.querySelector("#anilist-format")?.getAttribute("aria-label") ===
          "Format: Movie, TV Show" &&
        !!document.querySelector('[role="menu"]')
    );
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
      );
    await wait(() => !document.querySelector('[role="menu"]'));
    const movieChip = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove filter Movie"]'
    )!;
    movieChip.focus();
    await wait(() => getComputedStyle(movieChip.querySelector("svg")!).width === "12px");
    check(
      "The remove icon appears inside the focused filter badge",
      getComputedStyle(movieChip.querySelector("svg")!).position !== "absolute"
    );
    const clearFilters = document.querySelector<HTMLButtonElement>(".anilist-clear-filters")!;
    await wait(() => getComputedStyle(clearFilters).opacity === "1");
    check("Clear All appears when the filter row has keyboard focus", true);
    movieChip.click();
    await wait(() => currentFilters()?.formats?.join(",") === "TV");
    clearFilters.click();
    await wait(() => currentFilters()?.formats?.length === 0);
    check(
      "Clear All restores Any and removes every filter badge",
      document.querySelector("#anilist-format")?.getAttribute("aria-label") === "Format: Any" &&
        !document.querySelector(".anilist-filter-chip")
    );
  };
  try {
    await wait(() => !!document.querySelector('a[href="/anilist"]'));
    document.querySelector<HTMLAnchorElement>('a[href="/anilist"]')!.click();
    await wait(() => !!document.querySelector(".anilist-status-filter"));
    await wait(
      () => !!document.querySelector('button[aria-label="View episodes for Native Library"]')
    );
    await openMenu(".anilist-status-filter");
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
      .find((element) => element.textContent?.trim() === "None")!
      .click();
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
      );
    await wait(() => !document.querySelector('[role="menu"]'));
    await wait(
      () => !!document.querySelector('button[aria-label="View episodes for Native Catalog"]')
    );
    check(
      "None loads the trending catalog",
      document.querySelector(".anilist-sort")?.textContent?.includes("Trending") === true &&
        catalogRequests.at(-1)?.sort === "trending"
    );
    await checkCatalogFilters();
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
      () => !!document.querySelector('button[aria-label="View episodes for Native Catalog"]')
    );
    const card = document.querySelector<HTMLButtonElement>(
      'button[aria-label="View episodes for Native Catalog"]'
    )!;
    const hoverStarted = performance.now();
    card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await wait(() => !!document.querySelector(".anime-preview"));
    const previewStyle = getComputedStyle(document.querySelector(".anime-preview-popup")!);
    const hoverLatency = performance.now() - hoverStarted;
    check(
      `Hover preview appears immediately without moving the card or animating the details (${Math.round(hoverLatency)} ms)`,
      hoverLatency < 100 &&
        previewStyle.opacity === "1" &&
        previewStyle.transform === "none" &&
        previewStyle.animationName === "none" &&
        getComputedStyle(card).transform === "none" &&
        getComputedStyle(card).translate === "none"
    );
    check(
      "Hover preview shows episode, score, studio and genres",
      document.querySelector(".anime-preview")?.textContent?.includes("Ep 2 airing in") === true &&
        document.querySelector(".anime-preview")?.textContent?.includes("62%") === true &&
        document.querySelector(".anime-preview")?.textContent?.includes("Native Studio") === true
    );
    await checkHoverDismissal(card);
    const upcomingCard = document.querySelector<HTMLButtonElement>(
      'button[aria-label="View episodes for Catalog Title 1"]'
    )!;
    upcomingCard.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await wait(() => !!document.querySelector(".anime-preview"));
    const upcomingPreview = document.querySelector(".anime-preview")!;
    check(
      "Unreleased catalog previews show TBA and genres without empty metadata",
      upcomingPreview.textContent?.includes("TBA") === true &&
        upcomingPreview.textContent?.includes("Drama") === true &&
        !upcomingPreview.textContent?.includes("—") &&
        !upcomingPreview.querySelector(
          ".anime-preview-score, .anime-preview-details, .anime-preview-library"
        )
    );
    document.querySelector(".anilist-library")!.dispatchEvent(new Event("scroll"));
    await wait(() => !document.querySelector(".anime-preview"));
    check(
      "Catalog waits until scrolling near the bottom",
      catalogRequests.at(-1)?.page === undefined &&
        document.querySelectorAll(".anime-card").length === 25
    );
    document.querySelectorAll(".anime-card")[24]!.scrollIntoView({ block: "end" });
    await wait(() => catalogRequests.at(-1)?.page === 2);
    await wait(
      () =>
        document.querySelector('.anilist-library [role="status"]')?.textContent ===
        "Loading more anime…"
    );
    check(
      "Pagination announces loading while keeping the existing titles",
      document.querySelectorAll(".anime-card").length === 25 &&
        document.querySelector('.anilist-library [role="status"]')?.textContent ===
          "Loading more anime…"
    );
    nextPage.resolve();
    await wait(() => !!document.querySelector('button[aria-label="View episodes for Next Page"]'));
    check(
      "Scrolling appends titles without duplicates or a load-more button",
      document.querySelectorAll(".anime-card").length === 26 &&
        catalogRequests.at(-1)?.page === 2 &&
        !Array.from(document.querySelectorAll("button")).some(
          (element) => element.textContent?.trim() === "Load more anime"
        )
    );
    document.querySelectorAll(".anime-card")[25]!.scrollIntoView({ block: "end" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    check(
      "Pagination requests each page once and stops at the last page",
      catalogRequests.filter((filters) => filters.page === 2).length === 1 &&
        !catalogRequests.some((filters) => (filters.page ?? 1) > 2) &&
        document.querySelector(".anilist-title-count")?.textContent?.trim() === "26 titles"
    );
    card.scrollIntoView({ block: "start" });
    for (const layout of ["Large cards", "Compact cards", "List"]) {
      document.querySelector<HTMLButtonElement>(`button[aria-label="${layout}"]`)!.click();
      document
        .querySelector<HTMLButtonElement>('button[aria-label="View episodes for Native Catalog"]')!
        .click();
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((element) => element.textContent?.trim() === "Episodes")!
        .click();
      await wait(() => document.querySelectorAll(".anime-episode-row").length === 12);
      await wait(
        () =>
          !!Array.from(document.querySelectorAll(".anime-modal button")).find(
            (element) => element.textContent?.trim() === "Download"
          )
      );
      check(
        `${layout} opens catalog episodes with downloads inside Tofu`,
        document.querySelector('[data-slot="dialog-title"]')?.textContent === "Native Catalog" &&
          externalOpens === 0 &&
          location.pathname === "/anilist"
      );
      check(
        "Catalog does not invent watched progress or enable list-only actions",
        document
          .querySelector('[data-slot="dialog-description"]')
          ?.textContent?.includes("— / 12") === true &&
          document.querySelector<HTMLInputElement>("#anime-episode-1")!.disabled
      );
      if (layout === "Large cards") {
        Array.from(document.querySelectorAll<HTMLButtonElement>(".anime-modal button"))
          .find((element) => element.textContent?.trim() === "Download")!
          .click();
        await wait(() => downloadRequests.length === 1);
        check(
          "Catalog downloads use the selected destination and release",
          JSON.stringify(downloadRequests[0]) ===
            JSON.stringify({
              destinationId: "default",
              id: "catalog-release",
              paused: false,
              sourceId: "nyaa",
            })
        );
      }
      document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
      await wait(() => !document.querySelector(".anime-modal"));
    }
    check("Each catalog opening searches releases", releaseRequests.length === 3);
    document.querySelector<HTMLButtonElement>('button[aria-label="Large cards"]')!.click();
    await openMenu(".anilist-status-filter");
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
      .find((element) => element.textContent?.trim() === "Watching")!
      .click();
    await wait(
      () => !!document.querySelector('button[aria-label="View episodes for Native Library"]')
    );
    check(
      "Returning to a list preserves personal progress",
      document.querySelector(".anime-card")?.getAttribute("aria-description") ===
        "Watching · 3 / 12 watched" &&
        document.querySelector('.anime-card [role="img"][aria-label="Watching"]') !== null
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
