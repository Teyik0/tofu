interface OpeningServices {
  isDesktop: () => boolean;
  openExternal: (url: string) => boolean | Promise<boolean>;
}

interface AniListOpenResult {
  opened: boolean;
  url: string;
}

import { Elysia, problem } from "elysia";
import { maxLength, object, pipe, string } from "valibot";

const animePath = /^\/anime\/[1-9]\d*(?:\/[^/]+)?\/?$/;
export function createAniListOpeningApi<const Prefix extends string>(
  dependencies: OpeningServices,
  prefix: Prefix
) {
  return new Elysia({
    name: "tofu-anilist-opening",
    prefix: `${prefix}/anilist`,
  }).post("/open", { body: object({ url: pipe(string(), maxLength(2000)) }) }, async ({ body }) => {
    const url = URL.canParse(body.url) ? new URL(body.url) : null;
    if (
      url?.origin !== "https://anilist.co" ||
      url.username ||
      url.password ||
      !(url.pathname === "/api/v2/oauth/authorize" || animePath.test(url.pathname))
    ) {
      return problem(400, { detail: "Invalid AniList URL" });
    }
    if (!dependencies.isDesktop()) {
      return { opened: false, url: url.href } satisfies AniListOpenResult;
    }
    let opened: boolean;
    try {
      opened = await dependencies.openExternal(url.href);
    } catch {
      opened = false;
    }
    if (!opened) {
      return problem(502, { detail: "Unable to open AniList in your browser" });
    }
    return { opened: true, url: url.href } satisfies AniListOpenResult;
  });
}
