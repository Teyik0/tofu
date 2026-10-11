import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CatalogMultiSelectFilter,
  GenreTagFilter,
  noBrowseFilters,
} from "../src/components/anilist/browse-filters";

test("genre selections have a compact summary, announce every value and offer a dedicated clear action", () => {
  const html = renderToStaticMarkup(
    <GenreTagFilter
      filters={{ ...noBrowseFilters, genres: ["Drama", "Comedy"], tags: ["Space"] }}
      genres={["Comedy", "Drama"]}
      options={null}
      update={() => undefined}
    />
  );
  expect(html).toContain('id="anilist-genres-value"');
  expect(html).toContain("Drama, Comedy, Space");
  expect(html).toContain(">+2</span>");
  expect(html).toContain('aria-label="Clear genres and tags"');
});

test("multiple formats are announced together and can be cleared", () => {
  const html = renderToStaticMarkup(
    <CatalogMultiSelectFilter
      id="anilist-format"
      label="Format"
      onValueChange={() => undefined}
      options={[
        { label: "Movie", value: "MOVIE" },
        { label: "TV Show", value: "TV" },
      ]}
      value={["MOVIE", "TV"]}
    />
  );
  expect(html).toContain('id="anilist-format"');
  expect(html).toContain("Movie, TV Show");
  expect(html).toContain('aria-label="Clear format"');
});
