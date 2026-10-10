import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  use,
  useEffect,
  useState,
} from "react";
import { isPreferencesPath } from "../lib/navigation";
import type { ModalKind } from "./modal";

interface WorkspaceState {
  modal: ModalKind | null;
  open: Dispatch<SetStateAction<ModalKind | null>>;
  selected: string | null;
  setSelected: Dispatch<SetStateAction<string | null>>;
  settingsBackPath: string;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useWorkspace() {
  const workspace = use(WorkspaceContext);
  if (!workspace) {
    throw new Error("Workspace controls require the root layout");
  }
  return workspace;
}

export function WorkspaceProvider({ children, path }: { children: ReactNode; path: string }) {
  const [modal, open] = useState<ModalKind | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsBackPath, setSettingsBackPath] = useState("/");
  useEffect(() => {
    if (!isPreferencesPath(path)) {
      setSettingsBackPath(path);
    }
  }, [path]);

  return (
    <WorkspaceContext value={{ modal, open, selected, setSelected, settingsBackPath }}>
      {children}
    </WorkspaceContext>
  );
}
