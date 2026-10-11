import { expect, test } from "bun:test";
import { AniListMediaInfo } from "@tofu/anilist/components/media-info";
import { renderToStaticMarkup } from "react-dom/server";
import type { AniListEntry, AniListMedia } from "../src/types";

const media: AniListMedia = {
  aliases: ["Example"],
  averageScore: 62,
  bannerImage: null,
  coverImage: null,
  episodes: 12,
  format: "TV",
  genres: ["Drama", "Romance"],
  mediaId: 10,
  season: "SPRING",
  seasonYear: 2026,
  siteUrl: null,
  studios: ["Example Studio"],
  title: "Example",
};
const now = Date.UTC(2026, 3, 1);
test.each([
  ["#e4a33a", "hsl(43,83%,55%)", "hsl(14,80%,30%)"],
  ["#a4ce5b", "hsl(86,76%,57%)", "hsl(104,62%,20%)"],
  ["#65c9e9", "hsl(199,83%,69%)", "hsl(209,61%,28%)"],
])("anime previews use the AniList cover palette for %s", (coverColor, background, foreground) => {
  const html = renderToStaticMarkup(
    <AniListMediaInfo media={{ ...media, coverColor }} now={now} />
  );
  expect(html).toContain(`--anime-media-background:${background}`);
  expect(html).toContain(`--anime-media-background-text:${foreground}`);
});
test.each([null, undefined, "invalid"])(
  "anime previews without a usable cover color retain AniList's blue fallback: %s",
  (coverColor) => {
    const html = renderToStaticMarkup(
      <AniListMediaInfo media={{ ...media, coverColor }} now={now} />
    );
    expect(html).toContain("--anime-media-background:hsl(202,57%,89%)");
    expect(html).toContain("--anime-media-text-dark:hsl(202,57%,40%)");
  }
);
test("unreleased anime previews show TBA and genres without empty statistics or watch progress", () => {
  const upcoming: AniListEntry = {
    ...media,
    airingStatus: "NOT_YET_RELEASED",
    automationId: null,
    averageScore: null,
    completedEpisodes: [],
    episodes: null,
    format: null,
    progress: 0,
    releaseDate: { day: null, month: null, year: null },
    season: null,
    seasonYear: null,
    status: "PLANNING",
    studios: [],
  };
  const html = renderToStaticMarkup(<AniListMediaInfo media={upcoming} now={now} />);
  expect(html).toContain("TBA");
  expect(html).toContain("Drama");
  expect(html).toContain("Romance");
  expect(html).not.toContain("—");
  expect(html).not.toContain("Average score");
  expect(html).not.toContain("episodes");
  expect(html).not.toContain("watched");
  expect(html).not.toContain("Plan to Watch");
});
test("anime previews show the next episode countdown from its actual airing timestamp", () => {
  const html = renderToStaticMarkup(
    <AniListMediaInfo
      media={{
        ...media,
        nextAiringEpisode: { airingAt: (now + 6 * 86_400_000) / 1000, episode: 2 },
      }}
      now={now}
    />
  );
  expect(html).toContain("Ep 2 airing in 6 days");
  expect(html).toContain("62%");
  expect(html).toContain("Example Studio");
  expect(html).toContain("12 episodes");
});
test("unreleased anime previews preserve announced schedules and omit an empty genre row", () => {
  const upcoming: AniListMedia = { ...media, airingStatus: "NOT_YET_RELEASED", genres: [] };
  const season = renderToStaticMarkup(<AniListMediaInfo media={upcoming} now={now} />);
  expect(season).toContain("Spring 2026");
  expect(season).not.toContain("TBA");
  expect(season).not.toContain("anime-preview-genres");
  expect(
    renderToStaticMarkup(
      <AniListMediaInfo
        media={{
          ...upcoming,
          releaseDate: { day: 3, month: 4, year: 2026 },
          season: null,
          seasonYear: null,
        }}
        now={now}
      />
    )
  ).toContain("Apr 3, 2026");
  expect(
    renderToStaticMarkup(
      <AniListMediaInfo
        media={{
          ...upcoming,
          nextAiringEpisode: { airingAt: (now + 6 * 86_400_000) / 1000, episode: 1 },
        }}
        now={now}
      />
    )
  ).toContain("Ep 1 airing in 6 days");
});
test("anime previews fall back to season, partial release dates, or an unknown value", () => {
  expect(renderToStaticMarkup(<AniListMediaInfo media={media} now={now} />)).toContain(
    "Spring 2026"
  );
  expect(
    renderToStaticMarkup(
      <AniListMediaInfo
        media={{ ...media, releaseDate: { day: 3, month: 4, year: 2026 }, season: null }}
        now={now}
      />
    )
  ).toContain("Apr 3, 2026");
  expect(
    renderToStaticMarkup(
      <AniListMediaInfo
        media={{
          ...media,
          averageScore: null,
          releaseDate: { day: null, month: null, year: 2025 },
          season: null,
          seasonYear: null,
        }}
        now={now}
      />
    )
  ).toContain("2025");
  const unknown = renderToStaticMarkup(
    <AniListMediaInfo
      media={{ ...media, averageScore: null, season: null, seasonYear: null }}
      now={now}
    />
  );
  expect(unknown).toContain("—");
  expect(unknown).not.toContain("Average score: 0%");
});
test.each([
  [59, "negative"],
  [60, "neutral"],
  [74, "neutral"],
  [75, "positive"],
])("anime preview score %s uses AniList's sentiment threshold", (averageScore, sentiment) => {
  const html = renderToStaticMarkup(
    <AniListMediaInfo media={{ ...media, averageScore }} now={now} />
  );
  expect(html).toContain(`data-sentiment="${sentiment}"`);
});
