import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@tofu/ui/context-menu";
import { PencilIcon, PinIcon, PinOffIcon, ShapesIcon, Trash2Icon } from "lucide-react";
import { type ReactElement, useState } from "react";
import type { Destination } from "../types";
import { request } from "./api";
import { useDashboard } from "./app-shell";
import type { ModalKind } from "./modal";

export function DestinationMenu({
  children,
  destination,
  open,
}: {
  children: ReactElement;
  destination: Destination;
  open: (modal: ModalKind) => void;
}) {
  const { data, refresh } = useDashboard();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await request<Destination>(`/destinations/${destination.id}`, "PATCH", {
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
            {data.destinations.length > 1 && (
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
