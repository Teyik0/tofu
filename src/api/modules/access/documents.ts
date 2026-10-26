import { Elysia } from "elysia";
import { version } from "../../../../package.json";
import { accessPlugin } from "./plugin";

/** Public discovery stays outside the API prefix for other Tofu installations. */
export const publicDocumentsPlugin = new Elysia({ name: "tofu-public-documents" })
  .use(accessPlugin)
  .get("/.well-known/tofu", { public: true }, ({ access, set }) => {
    set.headers["cache-control"] = "no-store";
    return access.descriptor(version);
  });
