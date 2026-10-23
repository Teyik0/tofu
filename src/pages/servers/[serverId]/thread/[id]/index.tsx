import { defineRoute } from "@teyik0/furin";
import { useQuery } from "@teyik0/furin/client";
import { Link } from "@teyik0/furin/link";
import { cn } from "cn";
import { t } from "elysia";
import { useAtomValue } from "jotai";
import { DestinationIcon } from "../../../../../components/destination-icon";
import { bytes, percent, torrentStatusLabel } from "../../../../../components/format";
import { SidebarToggle } from "../../../../../components/sidebar-toggle";
import { StatusGlyph } from "../../../../../components/status-glyph";
import { Progress } from "../../../../../components/ui/progress";
import { api } from "../../../../../lib/client";
import { errorMessage } from "../../../../../lib/errors";
import { sessionAtom } from "../../../../../state/workspace";
import { RemoteTorrentDetail } from "./_torrent-detail";

export const route = defineRoute("/servers/[serverId]/thread/[id]")
  .config({
    mode: "ssr",
    params: t.Object({
      id: t.String(),
      serverId: t.String({ format: "uuid" }),
    }),
    query: t.Object({ torrent: t.Optional(t.String()) }),
  })
  .head(() => ({ meta: [{ title: "Remote thread — Tofu" }] }))
  .page(({ params, query }) => {
    const session = useAtomValue(sessionAtom);
    if (!session?.capabilities.hostNative) {
      return (
        <main className="main">
          <p className="p-6" role={session ? "alert" : "status"}>
            {session
              ? "Remote threads are available in the desktop owner's window."
              : "Confirming desktop access…"}
          </p>
        </main>
      );
    }
    return (
      <RemoteThreadContents
        requested={query.torrent}
        serverId={params.serverId}
        threadId={params.id}
      />
    );
  });

function RemoteThreadContents({
  requested,
  serverId,
  threadId,
}: {
  requested: string | undefined;
  serverId: string;
  threadId: string;
}) {
  const { data, error } = useQuery(api.desktop.servers({ id: serverId }).state.get.live());
  const state = error ? null : data;
  if (state?.connection !== "ready") {
    let message = "Connecting to the server…";
    if (error) {
      message = errorMessage(error, "Unable to read this server");
    } else if (state?.connection === "unauthorized") {
      message = "Access to this server is required.";
    } else if (state?.connection === "offline") {
      message = "This server is unavailable. Other servers remain accessible.";
    }
    return (
      <main className="main">
        <p className="p-6" role={error ? "alert" : "status"}>
          {message}
        </p>
      </main>
    );
  }
  const { snapshot } = state;
  const thread = snapshot.threads.find((item) => item.id === threadId);
  if (!thread) {
    return (
      <main className="main">
        <p className="p-6" role="alert">
          This thread does not exist on {snapshot.server.name}.
        </p>
      </main>
    );
  }
  const torrents = snapshot.torrents.filter((torrent) => torrent.destinationId === thread.id);
  const selected = torrents.find((torrent) => torrent.id === requested);
  return (
    <main className="main">
      <header className="library-topbar">
        <div className="library-title">
          <SidebarToggle className="mobile-sidebar-toggle" />
          <span aria-hidden="true" className="library-glyph">
            <DestinationIcon name={thread.icon} />
          </span>
          <div className="library-heading">
            <h1>{thread.name}</h1>
            <span className="topbar-path">On {snapshot.server.name} · Read-only</span>
          </div>
        </div>
      </header>
      <div
        className={cn(
          "m-5 grid min-h-0 flex-1 gap-4 overflow-y-auto",
          requested && "lg:grid-cols-2"
        )}
      >
        <section
          aria-label={`${thread.name} torrents on ${snapshot.server.name}`}
          className="min-h-0 overflow-y-auto rounded-xl border border-border"
        >
          {torrents.length === 0 ? (
            <p className="p-6 text-muted-foreground">No torrents in this thread.</p>
          ) : (
            <ul className="divide-y divide-border">
              {torrents.map((torrent) => (
                <li key={`${serverId}:${torrent.id}`}>
                  <Link
                    aria-current={requested === torrent.id ? "true" : undefined}
                    className={cn(
                      "flex items-center gap-4 p-4 transition-colors",
                      "hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
                      requested === torrent.id && "bg-accent"
                    )}
                    params={{ id: threadId, serverId }}
                    resetScroll={false}
                    search={{ torrent: torrent.id }}
                    to="/servers/:serverId/thread/:id"
                  >
                    <StatusGlyph progress={torrent.progress} size={34} status={torrent.status} />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <strong className="block truncate text-sm" title={torrent.name}>
                        {torrent.name}
                      </strong>
                      <div className="flex flex-wrap justify-between gap-2 text-muted-foreground text-xs">
                        <span>{torrentStatusLabel(torrent)}</span>
                        <span>
                          {percent(torrent.progress)} · {bytes(torrent.length)}
                        </span>
                      </div>
                      <Progress
                        aria-label={`Transfer progress for ${torrent.name}`}
                        value={torrent.progress === null ? null : torrent.progress * 100}
                      />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        {!!requested && (
          <aside
            aria-label="Torrent details"
            className="min-h-0 overflow-y-auto rounded-xl border border-border p-5"
          >
            <Link
              className="mb-5 inline-flex text-muted-foreground text-sm underline-offset-4 hover:underline"
              params={{ id: threadId, serverId }}
              resetScroll={false}
              search={{ torrent: undefined }}
              to="/servers/:serverId/thread/:id"
            >
              Close details
            </Link>
            {selected ? (
              <RemoteTorrentDetail
                key={`${serverId}:${threadId}:${selected.id}`}
                serverId={serverId}
                threadId={threadId}
                torrentId={selected.id}
              />
            ) : (
              <p role="alert">This torrent does not exist in this thread.</p>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}
