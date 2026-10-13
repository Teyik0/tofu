import { createAniListApi } from "@tofu/anilist/api";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { runtime } from "../../lib/runtime";
import { automation } from "../automation";
import { releaseAutomation } from "../automation/plugin";
import { anilist, anilistServicePlugin } from "./plugin";

export const anilistDependencies = {
  application: () => ({
    anilist,
    automation,
    platform:
      runtime.current.kind === "desktop"
        ? {
            kind: "desktop" as const,
            openExternal: runtime.current.desktop.shell.openExternal.bind(
              runtime.current.desktop.shell
            ),
          }
        : { kind: "server" as const },
    releaseAutomation,
  }),
  sync,
};
export const anilistPlugin = new Elysia({ name: "tofu-anilist-mounted" })
  .use(anilistServicePlugin)
  .use(createAniListApi(anilistDependencies, ""));
