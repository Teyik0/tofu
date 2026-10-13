import { Elysia, problem } from "elysia";
import { maxLength, object, pipe, string } from "valibot";
import type { AniListOpenResult } from "../../../types";
import { openExternalUrl } from "../../lib/native-opening";
import { runtime } from "../../lib/runtime";

const animePath = /^\/anime\/[1-9]\d*(?:\/[^/]+)?\/?$/;
export const anilistOpeningPlugin = new Elysia({
  name: "tofu-anilist-opening",
  prefix: "/anilist",
}).post(
  "/open",
  { body: object({ url: pipe(string(), maxLength(2000)) }), sync: false },
  ({ body }) => {
    const url = URL.canParse(body.url) ? new URL(body.url) : null;
    if (
      url?.origin !== "https://anilist.co" ||
      url.username ||
      url.password ||
      !(url.pathname === "/api/v2/oauth/authorize" || animePath.test(url.pathname))
    ) {
      return problem(400, { detail: "Invalid AniList URL" });
    }
    if (runtime.current.kind !== "desktop") {
      return { opened: false, url: url.href } satisfies AniListOpenResult;
    }
    const { shell } = runtime.current.desktop;
    openExternalUrl(shell, url.href, "Unable to open AniList in your browser");
    return { opened: true, url: url.href } satisfies AniListOpenResult;
  }
);
