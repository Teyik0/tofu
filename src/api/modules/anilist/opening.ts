import { furinSync } from "@teyik0/furin/sync";
import { Elysia, problem } from "elysia";
import { maxLength, object, pipe, string } from "valibot";
import { sync } from "../../../sync";

import { openExternalUrl } from "../../lib/native-opening";
import { runtime } from "../../lib/runtime";
import { accessPlugin } from "../access/plugin";

const animePath = /^\/anime\/[1-9]\d*(?:\/[^/]+)?\/?$/;
export const anilistOpeningPlugin = new Elysia({
  name: "tofu-anilist-opening",
  prefix: "/anilist",
})
  .use(accessPlugin)
  .use(furinSync(sync))
  .post(
    "/open",
    { body: object({ url: pipe(string(), maxLength(2000)) }), idempotent: false, personal: true },
    ({ body, caller }) => {
      const url = URL.canParse(body.url) ? new URL(body.url) : null;
      if (
        url?.origin !== "https://anilist.co" ||
        url.username ||
        url.password ||
        !(url.pathname === "/api/v2/oauth/authorize" || animePath.test(url.pathname))
      ) {
        return problem(400, { detail: "Invalid AniList URL" });
      }
      // Only the host's own window opens the host browser; remote callers open it themselves.
      if (caller.kind !== "owner" || runtime.current.kind !== "desktop") {
        return { opened: false, url: url.href };
      }
      const { shell } = runtime.current.desktop;
      const failed = openExternalUrl(shell, url.href, "Unable to open AniList in your browser");
      if (failed) {
        return failed;
      }
      return { opened: true, url: url.href };
    }
  );
