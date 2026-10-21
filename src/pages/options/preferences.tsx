import { defineRoute } from "@teyik0/furin";
import { useQuery } from "@teyik0/furin/client";
import { useAtomValue } from "jotai";
import { AccessRequired, SettingsSkeleton } from "../../components/access-required";
import { GeneralPreferences } from "../../components/general-preferences";
import { api } from "../../lib/client";
import { sessionAtom } from "../../state/workspace";

export const route = defineRoute("/options/preferences")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "General preferences — Tofu" }] }))
  .page(() => {
    const session = useAtomValue(sessionAtom);
    // Automation preferences belong to the server; authorized browsers read them after mount.
    const { data } = useQuery(api.automation.get.live());
    if (session && !session.capabilities.administer) {
      return (
        <AccessRequired
          description={`Release preferences apply to ${session.server.name} and are managed by its administrators.`}
          title="Administration access required"
        />
      );
    }
    if (!(session && data && "preferences" in data)) {
      return <SettingsSkeleton label="Loading preferences" />;
    }
    return <GeneralPreferences initialPreferences={data.preferences} />;
  });
