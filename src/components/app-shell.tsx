import { useRouter } from "@teyik0/furin/link";
import {
  type CSSProperties,
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useState,
} from "react";
import type { DashboardState } from "../types";
import { AutomationCenter } from "./automation-center";
import { DestinationSidebar } from "./destination-sidebar";
import { Modal, type ModalKind } from "./modal";
import { TorrentDrop } from "./torrent-drop";
import { SidebarInset, SidebarProvider } from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";
import { UpdateNotice } from "./updates";

interface DashboardContextValue {
  activeDestination: string | null;
  data: DashboardState;
  open: Dispatch<SetStateAction<ModalKind | null>>;
  refresh: () => Promise<void>;
  selectedId: string | undefined;
  setSelected: Dispatch<SetStateAction<string | null>>;
}
const DashboardContext = createContext<DashboardContextValue | null>(null);
export function useDashboard() {
  const dashboard = useContext(DashboardContext);
  if (!dashboard) {
    throw new Error("Le tableau de bord nécessite le layout Tofu");
  }
  return dashboard;
}

export function AppShell({
  children,
  dashboard,
  path,
}: {
  children: ReactNode;
  dashboard: DashboardState;
  path: string;
}) {
  const activeDestination =
    path === "/library/all"
      ? null
      : path.startsWith("/library/destinations/")
        ? decodeURIComponent(path.slice("/library/destinations/".length))
        : "default";
  const router = useRouter();
  const refresh = useCallback(async () => {
    try {
      await router.refresh();
    } catch (cause) {
      // A newer navigation or Sync refresh can supersede this request.
      if (cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError") {
        return;
      }
      throw cause;
    }
  }, [router.refresh]);
  const [selected, setSelected] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind | null>(null);
  const visible = dashboard.torrents.filter(
    (torrent) => activeDestination === null || torrent.destinationId === activeDestination
  );
  const selectedId = visible.find((torrent) => torrent.id === selected)?.id ?? visible[0]?.id;
  const done = async (id: string | null, destinationId: string | null) => {
    if (id) {
      setSelected(id);
    }
    if (modal?.type === "remove" && modal.torrent.id === selectedId) {
      setSelected(null);
    }
    if (destinationId && destinationId !== activeDestination) {
      await router.navigate({
        params: { id: destinationId },
        resetScroll: false,
        to: "/library/destinations/:id",
      });
    } else {
      await refresh();
    }
  };
  return (
    <DashboardContext.Provider
      value={{
        activeDestination,
        data: dashboard,
        open: setModal,
        refresh,
        selectedId,
        setSelected,
      }}
    >
      <TooltipProvider>
        <SidebarProvider
          className="app-shell"
          style={{ "--sidebar-width": "190px", "--sidebar-width-icon": "52px" } as CSSProperties}
        >
          <DestinationSidebar active={activeDestination} data={dashboard} open={setModal} />
          <SidebarInset className="min-w-0 overflow-hidden">
            <UpdateNotice />
            {children}
          </SidebarInset>
          <TorrentDrop />
          {modal !== null &&
            (modal.type === "plugins" || modal.type === "automation" ? (
              <AutomationCenter
                close={() => setModal(null)}
                destinationId={
                  modal.type === "automation"
                    ? modal.destinationId
                    : (activeDestination ?? "default")
                }
                initialTab={modal.type === "plugins" ? "plugins" : "automations"}
              />
            ) : (
              <Modal
                close={() => setModal(null)}
                data={dashboard}
                done={(id, destinationId) => void done(id, destinationId)}
                key={modal.type}
                modal={modal}
              />
            ))}
        </SidebarProvider>
      </TooltipProvider>
    </DashboardContext.Provider>
  );
}
