import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AniListMediaInfo } from "../src/components/anilist/media-info";
import type { AniListMedia } from "../src/types";

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
  expect(unknown).not.toContain("0%");
});
