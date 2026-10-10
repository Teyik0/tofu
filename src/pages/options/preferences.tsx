import { defineRoute } from "@teyik0/furin";
import { GeneralPreferences } from "../../components/general-preferences";
import { api } from "../../lib/client";
import { route as options } from "./_route";

export const route = defineRoute()
  .config({ layout: options, mode: "ssr" })
  .loader(async () => {
    const { data, error } = await api.automation.get();
    if (error || !(data && "preferences" in data)) {
      throw new Error("Unable to load preferences");
    }
    return { initialPreferences: data.preferences };
  })
  .head(() => ({ meta: [{ title: "General preferences — Tofu" }] }))
  .page(({ initialPreferences }) => <GeneralPreferences initialPreferences={initialPreferences} />);
