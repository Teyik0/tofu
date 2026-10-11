import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { applicationHost, applicationScope } from "./host";

export const contextPlugin = new Elysia({ name: "tofu-application-context" })
  .state("applicationHost", applicationHost)
  .derive("global", ({ store, status }) => {
    const application = applicationScope.getStore();
    if (application) {
      return { application };
    }
    const { state } = store.applicationHost;
    if (state.phase !== "ready") {
      return status(503, { error: "Tofu is temporarily unavailable" });
    }
    return { application: state.application };
  });
