import { useRouter } from "@teyik0/furin/link";
import { useAtom } from "jotai";
import { showDestination, showTorrent } from "../lib/navigation";
import { modalAtom } from "../state/workspace";
import type { FormModalKind, LiveState } from "../types";
import { AutomationCenter } from "./automation-center";
import { DeleteDestinationModal, Modal } from "./modal";

function operationKey(modal: FormModalKind) {
  if ("torrent" in modal) {
    return `${modal.type}:${modal.torrent.id}`;
  }
  if (modal.type === "destination") {
    return `destination:${modal.destination?.id ?? "new"}`;
  }
  if (modal.type === "add") {
    return `add:${modal.destinationId}`;
  }
  return `drop:${modal.files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|")}`;
}

export function WorkspaceDialogs({
  dashboard,
  activeDestination,
}: {
  dashboard: LiveState;
  activeDestination: string | null;
}) {
  const router = useRouter();
  const [modal, open] = useAtom(modalAtom);
  const close = () => open(null);
  const done = async (id: string | null, destinationId: string | null) => {
    if (id) {
      await showTorrent(router, destinationId ?? activeDestination, id);
    } else if (modal?.type === "remove" && modal.torrent.id === router.search.torrent) {
      await showTorrent(router, activeDestination, undefined);
    } else {
      await showDestination(router, destinationId, activeDestination);
    }
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
        key={`${modal.destinationId}:${modal.section}`}
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
      key={operationKey(modal)}
      modal={modal}
    />
  );
}
