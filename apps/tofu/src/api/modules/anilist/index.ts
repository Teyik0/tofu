import { createAniListApi } from "@tofu/anilist/api";
import { createContext, Elysia, problem } from "elysia";
import { sync } from "../../../sync";
import { rank } from "../access/grants";
import { callers } from "../access/service";
import { automationPlugin } from "../automation";
import { releaseAutomationPlugin } from "../automation/plugin";
import { anilistServicePlugin } from "./plugin";

const { anilist } = createContext(anilistServicePlugin).prototype;
const { automation } = createContext(automationPlugin).prototype;
const { releaseAutomation } = createContext(releaseAutomationPlugin).prototype;

export const anilistDependencies = {
  application: () => ({
    anilist,
    automation,
    platform: { kind: "server" as const },
    releaseAutomation,
  }),
  authorize(request: Request) {
    const caller = callers.get(request);
    if (!caller) {
      return problem(403, { detail: "This endpoint is not available during server rendering" });
    }
    if (caller.kind === "anonymous") {
      return problem(401, { detail: "Sign in to this server" });
    }
    if (caller.kind !== "owner" && rank(caller.device.role) < rank("administration")) {
      return problem(403, { detail: "This requires Administration access to this server" });
    }
    return caller;
  },
  sync,
};
export const anilistPlugin = new Elysia({ name: "tofu-anilist-mounted" })
  .use(anilistServicePlugin)
  .use(createAniListApi(anilistDependencies, ""));
