import { defineRoute } from "@teyik0/furin";
import { GeneralPreferences } from "../../components/general-preferences";
import { readData } from "../../lib/api-data";
import { api } from "../../lib/client";
import { route as options } from "./_route";

export const route = defineRoute()
  .config({ layout: options, mode: "ssr" })
  .loader(async () => ({ initialPreferences: readData(await api.automation.get()).preferences }))
  .head(() => ({ meta: [{ title: "General preferences — Tofu" }] }))
  .page(({ initialPreferences }) => <GeneralPreferences initialPreferences={initialPreferences} />);
