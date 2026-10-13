// biome-ignore-all lint/performance/noAwaitInLoops: exercise sequential public API requests.
import { expect, test } from "bun:test";
import type { JevQuestions } from "../src/api/modules/jev/service";
import { discoveryFixture } from "./helpers/discovery";
import { expectSuccess } from "./helpers/problem";

function rss(titles: string[]) {
  return new Response(
    `<rss><channel>${titles.map((title, index) => `<item><guid>${index}</guid><title>${title}</title><link>https://nyaa.si/download/${index}.torrent</link></item>`).join("")}</channel></rss>`
  );
}
test("smart discovery retains the entered title when catalogue expansions miss Nyaa releases", async () => {
  const queries: string[] = [];
  const context = await discoveryFixture((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/jev") {
      return new Response("offline", { status: 503 });
    }
    if (url.pathname === "/anilist") {
      return Response.json({
        data: {
          Page: {
            media: [
              {
                id: 1,
                synonyms: ["ReZero"],
                title: {
                  english: "Re:ZERO -Starting Life in Another World-",
                  native: null,
                  romaji: "Re:Zero kara Hajimeru Isekai Seikatsu",
                },
              },
            ],
          },
        },
      });
    }
    const query = url.searchParams.get("q") ?? "";
    queries.push(query);
    return rss(query === "ReZero" ? ["ReZero - 09 VOSTFR 1080p"] : []);
  });
  try {
    const result = expectSuccess(
      await context.client.discover.post({ query: "ReZero ep9", sources: ["nyaa"] })
    );
    expect(result.releases.map((release) => release.title)).toEqual(["ReZero - 09 VOSTFR 1080p"]);
    expect(queries).toContain("ReZero");
  } finally {
    await context.close();
  }
});
test("smart discovery recognizes revised Nyaa episodes and bracketed release metadata", async () => {
  const context = await discoveryFixture((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/jev") {
      return new Response("offline", { status: 503 });
    }
    if (url.pathname === "/anilist") {
      return Response.json({ data: { Page: { media: [] } } });
    }
    return rss([
      "[SubsPlease] Example - 09v2 (1080p) [ABC12345].mkv",
      "[Group] Example - 08 [1080p]",
      "[Group] Example - 01-12 [1080p]",
      "[Group] Unrelated - 09 [1080p]",
    ]);
  });
  try {
    const result = expectSuccess(
      await context.client.discover.post({ query: "Example ep9", sources: ["nyaa"] })
    );
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({
      episode: 9,
      resolution: "1080p",
      workTitle: "Example",
    });
    const titleOnly = expectSuccess(
      await context.client.discover.post({ query: "Example", sources: ["nyaa"] })
    );
    expect(titleOnly.releases.find((release) => release.title.includes("01-12"))?.pack).toBe(true);
  } finally {
    await context.close();
  }
});
test("smart discovery uses Jev to extract the work and rank matching Nyaa releases in batches", async () => {
  let interpretations = 0;
  let rankings = 0;
  const queries: string[] = [];
  const context = await discoveryFixture(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/anilist") {
      return Response.json({ data: { Page: { media: [] } } });
    }
    if (url.pathname === "/jev") {
      const body = (await request.json()) as {
        questions: JevQuestions;
        state: { query: string; releases?: { title: string }[] };
      };
      expect(body.state.query).toBe("je cherche l'épisode 9 de Example en VOSTFR 1080p");
      if ("title" in body.questions && body.questions.title.type === "choice") {
        interpretations += 1;
        const selected = Object.entries(body.questions.title.criteria).find(
          ([, value]) => value === "Example"
        );
        expect(selected).toBeDefined();
        return Response.json({
          answers: { title: { choice: selected?.[0], confidence: 0.99, type: "choice" } },
          model: "test-jev",
        });
      }
      rankings += 1;
      expect(body.state.releases).toHaveLength(4);
      const probabilities = [0.82, 0.98, 0.02, 0.01];
      return Response.json({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [
            id,
            {
              noul: id.startsWith("identity_")
                ? [0.99, 0.99, 0.99, 0.01][Number(id.split("_")[1])]
                : probabilities[Number(id.split("_")[1])],
              type: "noul",
            },
          ])
        ),
        model: "test-jev",
      });
    }
    const query = url.searchParams.get("q") ?? "";
    queries.push(query);
    return rss(
      query === "Example"
        ? [
            "[Group] Example - 09 VOSTFR 1080p",
            "[Group] Example [WEB] - 09 VOSTFR 1080p",
            "[Group] Example - 09 VF 720p",
            "[Group] Unrelated - 09 VOSTFR 1080p",
            "[Group] Example - 08 VOSTFR 1080p",
          ]
        : []
    );
  });
  try {
    const query = "je cherche l'épisode 9 de Example en VOSTFR 1080p";
    const result = expectSuccess(await context.client.discover.post({ query, sources: ["nyaa"] }));
    expect(result.search).toMatchObject({ episode: 9, title: "Example", warning: null });
    expect(result.releases.map((release) => release.title)).toEqual([
      "[Group] Example [WEB] - 09 VOSTFR 1080p",
      "[Group] Example - 09 VOSTFR 1080p",
    ]);
    expect(queries).toContain("Example");
    expect(interpretations).toBe(1);
    expect(rankings).toBe(1);
    expectSuccess(await context.client.discover.post({ query, sources: ["nyaa"] }));
    expect(interpretations).toBe(1);
    expect(rankings).toBe(1);
  } finally {
    await context.close();
  }
});
