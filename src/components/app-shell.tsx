import { useRouter } from "@teyik0/furin/link";
import {
  type CSSProperties,
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useTheme } from "../hooks/use-theme";
import type { DashboardState } from "../types";
import { AutomationCenter } from "./automation-center";
import { DestinationSidebar } from "./destination-sidebar";
import { Modal, type ModalKind } from "./modal";
import { TorrentDrop } from "./torrent-drop";
import { SidebarInset, SidebarProvider } from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";

interface DashboardContextValue {
  activeDestination: string | null;
  data: DashboardState;
  open: Dispatch<SetStateAction<ModalKind | null>>;
  refresh: () => Promise<void>;
  selectedId: string | undefined;
  setSelected: Dispatch<SetStateAction<string | null>>;
  settingsBackPath: string;
}
const DashboardContext = createContext<DashboardContextValue | null>(null);
export function useDashboard() {
  const dashboard = useContext(DashboardContext);
  if (!dashboard) {
    throw new Error("The dashboard requires the Tofu layout");
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
  useTheme(dashboard.settings.theme);
  const activeDestination =
    path === "/anilist"
      ? "anilist"
      : path === "/library/all"
        ? null
        : path.startsWith("/library/destinations/")
          ? decodeURIComponent(path.slice("/library/destinations/".length))
          : "default";
  const router = useRouter();
  const [settingsBackPath, setSettingsBackPath] = useState("/library/all");
  useEffect(() => {
    if (path !== "/settings" && path !== "/plugins") {
      setSettingsBackPath(path);
    }
  }, [path]);
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
    const targetDestination =
      destinationId ??
      (modal?.type === "destination" && modal.destination?.id === activeDestination
        ? "default"
        : null);
    if (targetDestination && targetDestination !== activeDestination) {
      try {
        await router.navigate({
          params: { id: targetDestination },
          resetScroll: false,
          to: "/library/destinations/:id",
        });
      } catch (cause) {
        // A newer navigation can supersede the completed form's navigation.
        if (
          !(cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError")
        ) {
          throw cause;
        }
      }
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
        settingsBackPath,
      }}
    >
      <TooltipProvider>
        <SidebarProvider
          className="app-shell"
          style={{ "--sidebar-width": "190px", "--sidebar-width-icon": "52px" } as CSSProperties}
        >
          {path !== "/settings" && path !== "/plugins" && (
            <DestinationSidebar active={activeDestination} data={dashboard} open={setModal} />
          )}
          <SidebarInset className="min-w-0 overflow-hidden">{children}</SidebarInset>
          <TorrentDrop />
          {modal !== null &&
            (modal.type === "automation" ? (
              <AutomationCenter close={() => setModal(null)} destinationId={modal.destinationId} />
            ) : (
              <Modal
                close={() => setModal(null)}
                data={dashboard}
                done={done}
                key={modal.type}
                modal={modal}
              />
            ))}
        </SidebarProvider>
      </TooltipProvider>
    </DashboardContext.Provider>
  );
}
