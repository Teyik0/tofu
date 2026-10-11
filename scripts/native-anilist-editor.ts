// biome-ignore-all lint/style/noNonNullAssertion: Missing native UI targets must fail this smoke test.
// biome-ignore-all lint/performance/noAwaitInLoops: Native UI changes must settle before the next interaction.
export async function anilistEditorWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  const wait = async (ready: () => boolean) => {
    const until = Date.now() + 15_000;
    while (!ready()) {
      if (Date.now() >= until) {
        throw new Error(`Timed out: ${ready.toString()}`);
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
  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label
    )!;
  const click = (label: string) => {
    const target = button(label);
    target.focus();
    target.click();
  };
  const set = (id: string, value: string) => {
    const target = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")!.set!.call(
      target,
      value
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const pick = async (id: string, label: string) => {
    const trigger = document.getElementById(id)!;
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    await wait(() => !!document.querySelector('[role="option"]'));
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent?.trim() === label
    )!;
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    option.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    await wait(() => trigger.getAttribute("aria-expanded") === "false");
  };
  const library = (await (
    await nativeFetch("/api/anilist")
  ).json()) as import("../src/types").AniListState;
  const media = library.entries[0]!;
  const editor: import("../src/types").AniListEditor = {
    entry: {
      advancedScores: [],
      completedAt: null,
      customLists: ["Weekend"],
      hiddenFromStatusLists: false,
      id: 100,
      mediaId: media.mediaId,
      notes: "Original notes",
      priority: 0,
      private: false,
      progress: media.progress,
      repeat: 0,
      score: 3,
      startedAt: { day: null, month: 10, year: 2026 },
      status: media.status,
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
  const writes: import("../src/types").AniListListUpdate[] = [];
  let downloads = 0;
  const apiFixture = (path: string, init: RequestInit | undefined): Response | null => {
    if (path.endsWith(`/entries/${media.mediaId}/editor`)) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as import("../src/types").AniListListUpdate;
        writes.push(body);
        Object.assign(editor.entry!, body);
        Object.assign(library.entries[0]!, {
          progress: editor.entry!.progress,
          status: editor.entry!.status,
        });
        return Response.json(library);
      }
      return Response.json(editor);
    }
    if (path.endsWith(`/entries/${media.mediaId}/favourite`)) {
      editor.isFavourite = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
      return Response.json({ isFavourite: editor.isFavourite });
    }
    if (path.endsWith(`/entries/${media.mediaId}/releases`)) {
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
            title: "Native Library - 01 VOSTFR 1080p",
            workTitle: media.title,
          },
        ],
        torrents: [],
      } satisfies import("../src/types").AniListReleases);
    }
    if (path === "/api/discover/add") {
      downloads += 1;
      return Response.json({});
    }
    return null;
  };
  window.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      const url = new URL(target, location.origin);
      const fixture = apiFixture(url.pathname, init);
      if (fixture) {
        return fixture;
      }
      const response = await nativeFetch(input, init);
      if (url.pathname === "/_furin/data" && url.searchParams.get("path") === "/anilist") {
        const patched = await nativeFetch(`${config.reportUrl}/anilist-loader`, {
          body: JSON.stringify({ anilist: library, payload: await response.json() }),
          method: "POST",
        });
        return new Response(`${await patched.text()}\n`, {
          headers: response.headers,
          status: response.status,
        });
      }
      return response;
    },
    { preconnect: nativeFetch.preconnect }
  );
  try {
    await wait(() => !!document.querySelector('a[href="/anilist"]'));
    document.querySelector<HTMLAnchorElement>('a[href="/anilist"]')!.click();
    await wait(() => !!button(`View episodes for ${media.title}`));
    click(`View episodes for ${media.title}`);
    await wait(() => !!document.getElementById("anime-list-status"));
    check(
      "Clicking a card opens the native list editor",
      document.getElementById("anime-list-status")?.textContent?.trim() === "Watching"
    );
    click("Add to favourites");
    await wait(() => button("Remove from favourites")?.disabled === false);
    click("Remove from favourites");
    await wait(() => button("Add to favourites")?.disabled === false);
    check("Favourites sync in both directions", editor.isFavourite === false);
    await pick("anime-list-status", "Completed");
    click("Neutral");
    set("anime-list-progress", "12");
    set("anime-list-notes", "A beautiful journey");
    document
      .getElementById("anime-list-private")!
      .closest('[data-slot="field"]')!
      .querySelector<HTMLElement>('[role="checkbox"]')!
      .click();
    click("Episodes");
    await wait(() => !!document.querySelector(".anime-episode-row"));
    check(
      "Episode downloads remain available from the same card",
      document.querySelectorAll(".anime-episode-row").length === 12
    );
    click("Download");
    await wait(() => downloads === 1);
    click("My list");
    await wait(() => !!document.getElementById("anime-list-notes"));
    check(
      "Switching tabs preserves list edits",
      (document.getElementById("anime-list-notes") as HTMLTextAreaElement).value ===
        "A beautiful journey"
    );
    await wait(
      () =>
        !!document.querySelector('.anime-save-state[data-status="saved"]') &&
        "private" in Object.assign({}, ...writes)
    );
    const saved = Object.assign({}, ...writes) as import("../src/types").AniListListUpdate;
    check(
      "The editor saves status, score, progress, notes and privacy without a save button",
      [
        !button("Save to AniList"),
        saved.status === "COMPLETED",
        saved.score === 2,
        saved.progress === 12,
        saved.notes === "A beautiful journey",
        saved.private === true,
      ].every(Boolean)
    );
    check(
      "Autosave preserves untouched partial dates and custom lists",
      editor.entry!.startedAt?.day === null &&
        editor.entry!.customLists[0] === "Weekend" &&
        writes.every((write) => write.startedAt === undefined && write.customLists === undefined)
    );
    await nativeFetch(config.reportUrl, {
      body: JSON.stringify({ checks, passed: true }),
      method: "POST",
    });
  } catch (cause) {
    await nativeFetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(cause),
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  } finally {
    window.fetch = originalFetch;
  }
}
