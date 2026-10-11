// biome-ignore-all lint/style/noNonNullAssertion: Missing native UI targets must fail this smoke test.
// biome-ignore-all lint/performance/noAwaitInLoops: Each preview must render before checking its colors.
export async function anilistColorsWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!condition()) {
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
  const samples = [
    {
      accent: "hsl(14,80%,70%)",
      background: "rgb(235, 182, 45)",
      color: "#e4a33a",
      score: 86,
      sentiment: "rgb(123, 213, 85)",
      title: "Native Gold",
    },
    {
      accent: "hsl(104,80%,70%)",
      background: "rgb(156, 229, 62)",
      color: "#a4ce5b",
      score: 60,
      sentiment: "rgb(247, 154, 99)",
      title: "Native Green",
    },
    {
      accent: "hsl(209,80%,70%)",
      background: "rgb(110, 200, 242)",
      color: "#65c9e9",
      score: 73,
      sentiment: "rgb(247, 154, 99)",
      title: "Native Blue",
    },
  ];
  const media: import("../src/types").AniListMedia[] = samples.map((sample, index) => ({
    airingStatus: "RELEASING",
    aliases: [sample.title],
    averageScore: sample.score,
    bannerImage: null,
    coverColor: sample.color,
    coverImage: null,
    episodes: 12,
    format: "TV",
    genres: ["Action", "Adventure", "Comedy"],
    mediaId: 99 + index,
    nextAiringEpisode: { airingAt: Math.floor(Date.now() / 1000) + 6 * 86_400, episode: 3 },
    season: "SPRING",
    seasonYear: 2026,
    siteUrl: null,
    studios: ["Native Studio"],
    title: sample.title,
  }));
  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  window.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      const path = new URL(target, location.origin).pathname;
      if (path === "/api/anilist/catalog") {
        return Promise.resolve(Response.json({ hasNextPage: false, media, page: 1 }));
      }
      if (path === "/api/anilist/catalog/options") {
        return Promise.resolve(
          Response.json({ genres: ["Action", "Adventure", "Comedy"], streaming: [], tags: [] })
        );
      }
      return nativeFetch(input, init);
    },
    { preconnect: nativeFetch.preconnect }
  );
  const originalTheme = document.documentElement.dataset.theme;
  try {
    await wait(() => !!document.querySelector('a[href="/anilist"]'));
    document.querySelector<HTMLAnchorElement>('a[href="/anilist"]')!.click();
    await wait(() => !!document.querySelector(".anilist-status-filter"));
    const lists = document.querySelector<HTMLButtonElement>(".anilist-status-filter")!;
    lists.focus();
    lists.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    await wait(() => !!document.querySelector('[role="menuitem"]'));
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.includes("None · Browse"))!
      .click();
    await wait(
      () => !!document.querySelector('button[aria-label="View episodes for Native Gold"]')
    );
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      for (const sample of samples) {
        const card = document.querySelector<HTMLButtonElement>(
          `button[aria-label="View episodes for ${sample.title}"]`
        )!;
        card.focus();
        card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        await wait(() => !!document.querySelector(".anime-preview"));
        const preview = document.querySelector<HTMLElement>(".anime-preview")!;
        const studio = preview.querySelector<HTMLElement>(".anime-preview-details > strong")!;
        const title = card.querySelector<HTMLElement>("strong")!;
        await wait(() => getComputedStyle(title).color === getComputedStyle(studio).color);
        check(
          `${sample.title} uses the exact AniList genre color in ${theme} mode`,
          getComputedStyle(preview.querySelector("[data-slot='badge']")!).backgroundColor ===
            sample.background
        );
        check(
          `${sample.title} matches title and studio accents in ${theme} mode`,
          getComputedStyle(title).color === getComputedStyle(studio).color &&
            (theme === "light" ||
              preview.style.getPropertyValue("--anime-media-text-dark") === sample.accent)
        );
        check(
          `${sample.title} uses the score color independently of its cover`,
          getComputedStyle(preview.querySelector(".anime-preview-score svg")!).color ===
            sample.sentiment
        );
        check(
          `The ${theme} preview uses the green Tofu surface`,
          getComputedStyle(document.querySelector(".anime-preview-popup")!).backgroundColor ===
            (theme === "dark" ? "rgb(38, 52, 32)" : "rgb(237, 244, 234)")
        );
        card.blur();
        card.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
        window.dispatchEvent(new Event("scroll"));
        await wait(() => !document.querySelector(".anime-preview"));
      }
    }
    await fetch(config.reportUrl, {
      body: JSON.stringify({ checks, passed: true }),
      method: "POST",
    });
  } catch (error) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        cards: Array.from(document.querySelectorAll(".anime-card")).map((card) => card.outerHTML),
        checks,
        colors: Array.from(
          document.querySelectorAll(".anime-card > strong, .anime-preview-details > strong")
        ).map((element) => ({
          color: getComputedStyle(element).color,
          content: element.textContent,
          text: getComputedStyle(element).getPropertyValue("--anime-media-text"),
        })),
        error: String(error),
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  } finally {
    window.fetch = originalFetch;
    document.documentElement.dataset.theme = originalTheme;
  }
}
