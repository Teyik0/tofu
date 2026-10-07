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
import { DeleteDestinationModal, Modal, type ModalKind } from "./modal";
import { PluginsPage } from "./plugins-page";
import { TorrentDrop } from "./torrent-drop";
import { SidebarInset, SidebarProvider } from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";

interface DashboardContextValue {
  activeDestination: string | null;
  closePlugins: () => void;
  data: DashboardState;
  open: Dispatch<SetStateAction<ModalKind | null>>;
  openPlugins: () => void;
  pluginsNavigationError: string | null;
  refresh: () => Promise<void>;
  selectedId: string | undefined;
  setSelected: Dispatch<SetStateAction<string | null>>;
  settingsBackPath: string;
  showDestination: (destinationId: string | null) => Promise<void>;
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
  const [pluginsOrigin, setPluginsOrigin] = useState<string | null>(null);
  const [pluginsNavigationError, setPluginsNavigationError] = useState<string | null>(null);
  const showingPlugins = path === "/plugins" || pluginsOrigin === path;
  const openPlugins = () => {
    setPluginsOrigin(path);
    setPluginsNavigationError(null);
    void router.navigate({ to: "/plugins" }).catch((cause) => {
      if (cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError") {
        return;
      }
      setPluginsNavigationError(cause instanceof Error ? cause.message : "Unable to open plugins");
    });
  };
  const closePlugins = () => {
    setPluginsOrigin(null);
    setPluginsNavigationError(null);
  };
  useEffect(() => {
    if (path === "/plugins") {
      setPluginsOrigin(null);
    }
  }, [path]);
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
  const showDestination = async (destinationId: string | null) => {
    if (destinationId && destinationId !== activeDestination) {
      try {
        await router.navigate({
          params: { id: destinationId },
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
  const done = async (id: string | null, destinationId: string | null) => {
    if (id) {
      setSelected(id);
    }
    if (modal?.type === "remove" && modal.torrent.id === selectedId) {
      setSelected(null);
    }
    await showDestination(destinationId);
  };
  const page = showingPlugins ? <PluginsPage /> : children;
  return (
    <DashboardContext.Provider
      value={{
        activeDestination,
        closePlugins,
        data: dashboard,
        open: setModal,
        openPlugins,
        pluginsNavigationError,
        refresh,
        selectedId,
        setSelected,
        settingsBackPath,
        showDestination,
      }}
    >
      <TooltipProvider>
        <SidebarProvider
          className="app-shell"
          style={{ "--sidebar-width": "190px", "--sidebar-width-icon": "52px" } as CSSProperties}
        >
          {path !== "/settings" && !showingPlugins && (
            <DestinationSidebar active={activeDestination} data={dashboard} open={setModal} />
          )}
          <SidebarInset className="min-w-0 overflow-hidden">{page}</SidebarInset>
          <TorrentDrop />
          {modal !== null &&
            (modal.type === "automation" ? (
              <AutomationCenter close={() => setModal(null)} destinationId={modal.destinationId} />
            ) : modal.type === "deleteDestination" ? (
              <DeleteDestinationModal
                cancel={() => setModal(null)}
                close={() => setModal(null)}
                destination={modal.destination}
                done={done}
              />
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
