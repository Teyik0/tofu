import { useRouter } from "@teyik0/furin/link";
import { useAtom } from "jotai";
import { showDestination } from "../lib/navigation";
import { modalAtom, selectedTorrentAtom } from "../state/workspace";
import type { DashboardState } from "../types";
import { AutomationCenter } from "./automation-center";
import { DeleteDestinationModal, Modal } from "./modal";

export function WorkspaceDialogs({
  dashboard,
  activeDestination,
}: {
  dashboard: DashboardState;
  activeDestination: string | null;
}) {
  const router = useRouter();
  const [modal, open] = useAtom(modalAtom);
  const [selected, setSelected] = useAtom(selectedTorrentAtom);
  const close = () => open(null);
  const done = async (id: string | null, destinationId: string | null) => {
    if (id) {
      setSelected(id);
    }
    if (modal?.type === "remove" && modal.torrent.id === selected) {
      setSelected(null);
    }
    await showDestination(router, destinationId, activeDestination);
  };

  if (modal === null) {
    return null;
  }
  if (modal.type === "automation") {
    return (
      <AutomationCenter
        close={close}
        dashboard={dashboard}
        destinationId={modal.destinationId}
        section={modal.section}
      />
    );
  }
  if (modal.type === "deleteDestination") {
    return (
      <DeleteDestinationModal
        activeDestination={activeDestination}
        cancel={close}
        close={close}
        data={dashboard}
        destination={modal.destination}
        done={done}
      />
    );
  }
  return (
    <Modal
      activeDestination={activeDestination}
      close={close}
      data={dashboard}
      done={done}
      key={modal.type}
      modal={modal}
    />
  );
}
