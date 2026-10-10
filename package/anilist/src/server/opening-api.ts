import type { AniListOpenResult } from "@tofu/plugins/domain";
import { UserError } from "@tofu/plugins/server";
import { Elysia, t, ValidationError } from "elysia";

const animePath = /^\/anime\/[1-9]\d*(?:\/[^/]+)?\/?$/;

export function createAniListOpeningApi(options: {
  isDesktop: () => boolean;
  openExternal: (url: string) => Promise<boolean>;
}) {
  return new Elysia({ prefix: "/api/anilist" })
    .error(({ error, set }) => {
      set.status =
        error instanceof UserError || error instanceof ValidationError ? error.status : 500;
      return { error: error instanceof Error ? error.message : "Unable to open AniList" };
    })
    .post(
      "/open",
      { body: t.Object({ url: t.String({ maxLength: 2000 }) }), sync: false },
      async ({ body }): Promise<AniListOpenResult> => {
        const url = URL.canParse(body.url) ? new URL(body.url) : null;
        if (
          url?.origin !== "https://anilist.co" ||
          url.username ||
          url.password ||
          !(url.pathname === "/api/v2/oauth/authorize" || animePath.test(url.pathname))
        ) {
          throw new UserError("Invalid AniList URL", { status: 400 });
        }
        if (!options.isDesktop()) {
          return { opened: false, url: url.href };
        }
        if (!(await options.openExternal(url.href).catch(() => false))) {
          throw new UserError("Unable to open AniList in your browser", { status: 502 });
        }
        return { opened: true, url: url.href };
      }
    );
}
