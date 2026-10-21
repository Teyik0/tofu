import { useMutation } from "@teyik0/furin/client";
import { PencilIcon, PinIcon, PinOffIcon, ShapesIcon, Trash2Icon } from "lucide-react";
import type { ReactElement } from "react";
import type { Destination } from "../api/modules/destinations/model";
import { useAsyncAction } from "../hooks/use-async-action";
import { api } from "../lib/client";
import { useRefresh } from "../lib/navigation";
import type { ModalKind } from "../state/workspace";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "./ui/context-menu";

/** Thread actions for administrators; other viewers get the plain thread link. */
export function DestinationMenu({
  children,
  destination,
  open,
  deletable,
}: {
  children: ReactElement;
  destination: Destination | undefined;
  open: (modal: ModalKind) => void;
  deletable: boolean;
}) {
  return destination ? (
    <DestinationContextMenu deletable={deletable} destination={destination} open={open}>
      {children}
    </DestinationContextMenu>
  ) : (
    children
  );
}

function DestinationContextMenu({
  children,
  destination,
  open,
  deletable,
}: {
  children: ReactElement;
  destination: Destination;
  open: (modal: ModalKind) => void;
  deletable: boolean;
}) {
  const refresh = useRefresh();
  const updateDestination = useMutation(api.destinations({ id: destination.id }).patch);
  const { busy, error, run } = useAsyncAction("Unable to update the thread");
  const toggle = () =>
    run(async () => {
      await updateDestination.mutateAsync({
        pinned: !destination.pinned,
      });
      await refresh();
    });
  const edit = () => open({ destination, type: "destination" });
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={children} />
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuLabel>{destination.name}</ContextMenuLabel>
            <ContextMenuItem disabled={busy} onClick={toggle}>
              {destination.pinned ? <PinOffIcon /> : <PinIcon />}
              {destination.pinned ? "Unpin thread" : "Pin thread"}
            </ContextMenuItem>
            <ContextMenuItem onClick={edit}>
              <ShapesIcon />
              Change icon…
            </ContextMenuItem>
            <ContextMenuItem onClick={edit}>
              <PencilIcon />
              Edit thread…
            </ContextMenuItem>
            {deletable === true && (
              <ContextMenuItem
                onClick={() => open({ destination, type: "deleteDestination" })}
                variant="destructive"
              >
                <Trash2Icon />
                Delete thread…
              </ContextMenuItem>
            )}
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
      {error !== null && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
