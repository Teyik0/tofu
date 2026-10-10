import { useMutation } from "@teyik0/furin/client";
import { PencilIcon, PinIcon, PinOffIcon, ShapesIcon, Trash2Icon } from "lucide-react";
import { type ReactElement, useState } from "react";
import { api } from "../lib/client";
import { useRefresh } from "../lib/navigation";
import type { Destination } from "../types";
import type { ModalKind } from "./modal";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "./ui/context-menu";

export function DestinationMenu({
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateDestination.mutateAsync({
        pinned: !destination.pinned,
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update the thread");
    } finally {
      setBusy(false);
    }
  };
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
