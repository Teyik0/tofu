import { defineRoute } from "@teyik0/furin";
import { useAtomValue } from "jotai";
import { AccessRequired, SettingsSkeleton } from "../../components/access-required";
import { sessionAtom } from "../../state/workspace";
import { TransmissionWorkspace } from "./_workspace";

export const route = defineRoute("/transmission")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "Transmission — Tofu" }] }))
  .page(() => {
    const session = useAtomValue(sessionAtom);
    if (!session) {
      return (
        <main className="p-6">
          <SettingsSkeleton label="Checking your session" />
        </main>
      );
    }
    if (!session.capabilities.manage) {
      return (
        <main className="p-6">
          <AccessRequired
            description={`Transmission torrents on ${session.server.name} are managed by its managers.`}
            title="Management access required"
          />
        </main>
      );
    }
    return <TransmissionWorkspace />;
  });
