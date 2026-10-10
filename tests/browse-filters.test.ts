import { expect, test } from "bun:test";
import { browseRequest, noBrowseFilters } from "../src/components/anilist/browse-filters";

test("zero numeric bounds remain present in catalog requests", () => {
  const request = browseRequest({
    ...noBrowseFilters,
    durationMax: "0",
    episodesMax: "0",
    yearMax: "0",
  });
  expect(request.durationMax).toBe(0);
  expect(request.episodesMax).toBe(0);
  expect(request.yearMax).toBe(0);
  expect(request.durationMin).toBeUndefined();
  expect(request.episodesMin).toBeUndefined();
  expect(request.yearMin).toBeUndefined();
});
