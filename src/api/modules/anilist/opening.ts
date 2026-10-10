import { Elysia } from "elysia";
import { maxLength, object, pipe, string } from "valibot";
import type { AniListOpenResult } from "../../../types";
import { contextPlugin } from "../../lib/context";
import { UserError } from "../../lib/errors";

const animePath = /^\/anime\/[1-9]\d*(?:\/[^/]+)?\/?$/;

export const anilistOpeningPlugin = new Elysia({ name: "tofu-anilist-opening", prefix: "/anilist" })
  .use(contextPlugin)
  .post(
    "/open",
    { body: object({ url: pipe(string(), maxLength(2000)) }), sync: false },
    async ({ application, body }): Promise<AniListOpenResult> => {
      const url = URL.canParse(body.url) ? new URL(body.url) : null;
      if (
        url?.origin !== "https://anilist.co" ||
        url.username ||
        url.password ||
        !(url.pathname === "/api/v2/oauth/authorize" || animePath.test(url.pathname))
      ) {
        throw new UserError("Invalid AniList URL", { status: 400 });
      }
      if (application.platform.kind !== "desktop") {
        return { opened: false, url: url.href };
      }
      if (
        !(await Promise.resolve(application.platform.utils.openExternal(url.href)).catch(
          () => false
        ))
      ) {
        throw new UserError("Unable to open AniList in your browser", { status: 502 });
      }
      return { opened: true, url: url.href };
    }
  );
