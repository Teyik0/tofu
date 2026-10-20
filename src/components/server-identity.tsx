import { useAtomValue } from "jotai";
import { ServerIcon } from "lucide-react";
import { connectionAtom, sessionAtom } from "../state/workspace";

const roleLabels = {
  administration: "Administration",
  management: "Management",
  owner: "Owner",
  playback: "Playback",
} as const;

const connectionLabels = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
} as const;

/**
 * The server this workspace belongs to. Its name comes from the server itself; the native
 * window title and server picker remain the authoritative identity on desktop.
 */
export function ServerIdentity({ server }: { server: { id: string; name: string } }) {
  const session = useAtomValue(sessionAtom);
  const connection = useAtomValue(connectionAtom);
  return (
    <div className="sidebar-server" title={server.name}>
      <ServerIcon aria-hidden="true" />
      <div>
        <strong>{server.name}</strong>
        <span>
          {session?.caller.kind === "owner" ? "This computer" : "Remote server"}
          {session ? ` · ${roleLabels[session.caller.role]}` : ""}
        </span>
        <span className="sidebar-server-state" data-state={connection}>
          {connectionLabels[connection]}
        </span>
      </div>
    </div>
  );
}
