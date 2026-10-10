import { defineRoute } from "@teyik0/furin";
import { route as root } from "./root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(({ redirect }) => {
    throw redirect("/library");
  })
  .page(() => null);
