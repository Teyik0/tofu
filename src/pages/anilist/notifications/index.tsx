import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { useAtomValue } from "jotai";
import { BellIcon } from "lucide-react";
import { Fragment, useContext, useState } from "react";
import { type NotificationFilters, notificationCategories } from "@/api/modules/anilist/model";
import type { AniListNotification } from "@/api/modules/anilist/notifications";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNow } from "@/hooks/use-now";
import { dashboardAtom } from "@/state/workspace";
import { aniListContext } from "../_context";
import { AniListEpisodeModal } from "../_episode-modal";
import { NotificationRow } from "./_notification-row";
import { useInbox } from "./_use-inbox";

export const route = defineRoute("/anilist/notifications")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "Notifications · AniList — Tofu" }] }))
  .page(() => {
    const state = useContext(aniListContext);
    return state ? <NotificationsPage state={state} /> : null;
  });

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function NotificationsPage({
  state,
}: {
  state: NonNullable<React.ContextType<typeof aniListContext>>;
}) {
  const dashboard = useAtomValue(dashboardAtom);
  const model = useInbox(state);
  const {
    category,
    setCategory,
    setPage,
    setAttempt,
    inbox,
    setInbox,
    setLoading,
    loading,
    error,
    feedRef,
    endRef,
    actions,
  } = model;
  const [selected, setSelected] = useState<AniListNotification | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const now = useNow(60_000);

  const notifications = inbox?.notifications ?? [];
  const selectedAnime = selected?.anime;
  return (
    <>
      <div className="anilist-page-body anilist-notifications">
        {error || actions.error ? (
          <Alert>
            <AlertDescription>
              {error ?? actions.error}{" "}
              <Button
                onClick={() => {
                  setLoading(true);
                  setAttempt((value) => value + 1);
                }}
                size="sm"
                variant="link"
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {state && !state.anilist.authenticated ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellIcon />
              </EmptyMedia>
              <EmptyTitle>Connect your AniList account</EmptyTitle>
              <EmptyDescription>
                Notifications are private. Connect AniList in your library settings to see your
                inbox.
              </EmptyDescription>
            </EmptyHeader>
            <Button render={<Link to="/anilist" />} variant="outline">
              Open AniList library
            </Button>
          </Empty>
        ) : (
          <Tabs
            onValueChange={(value) => {
              setEditing(null);
              setLoading(true);
              setCategory(value as NotificationFilters["category"]);
              setPage(1);
              setInbox(null);
            }}
            value={category}
          >
            <div className="notification-toolbar">
              <div className="notification-tabs">
                <TabsList aria-label="Notification categories" variant="line">
                  {notificationCategories.map((value) => (
                    <TabsTrigger key={value} value={value}>
                      {value.charAt(0).toUpperCase() + value.slice(1)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            </div>
            <TabsContent aria-busy={loading} value={category}>
              <div className="notification-feed" ref={feedRef}>
                {notifications.map((notification, index) => {
                  const entry =
                    state.anilist.entries.find(
                      (item) => item.mediaId === notification.anime?.mediaId
                    ) ?? notification.anime;
                  const rule =
                    entry && "automationId" in entry
                      ? state.automation.automations.find((item) => item.id === entry.automationId)
                      : undefined;
                  const day = notification.createdAt
                    ? dayFormatter.format(notification.createdAt * 1000)
                    : "Earlier";
                  const previous = notifications[index - 1]?.createdAt;
                  const previousDay = previous ? dayFormatter.format(previous * 1000) : "Earlier";
                  return (
                    <Fragment key={notification.id}>
                      {index === 0 || day !== previousDay ? (
                        <h3 className="notification-day">{day}</h3>
                      ) : null}
                      <NotificationRow
                        automation={state.automation}
                        dashboard={dashboard}
                        entry={entry}
                        expanded={editing === notification.id}
                        notification={notification}
                        now={now}
                        openEpisode={setSelected}
                        rule={rule}
                        toggleAutomation={() =>
                          setEditing((current) =>
                            current === notification.id ? null : notification.id
                          )
                        }
                        torrents={dashboard?.torrents ?? []}
                      />
                    </Fragment>
                  );
                })}
                {loading ? (
                  <div
                    aria-label="Loading notifications"
                    className="notification-skeletons"
                    role="status"
                  >
                    {[1, 2, 3].map((item) => (
                      <Skeleton className="h-28" key={item} />
                    ))}
                  </div>
                ) : null}
                {loading || notifications.length || error ? null : (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <BellIcon />
                      </EmptyMedia>
                      <EmptyTitle>You're all caught up</EmptyTitle>
                      <EmptyDescription>No notifications in this category yet.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </div>
              {inbox?.hasNextPage ? <div aria-hidden="true" className="h-10" ref={endRef} /> : null}
            </TabsContent>
          </Tabs>
        )}
      </div>
      {selectedAnime && state && dashboard ? (
        <AniListEpisodeModal
          authenticated={state.anilist.authenticated}
          automation={state.automation}
          close={() => setSelected(null)}
          dashboard={dashboard}
          entry={
            state.anilist.entries.find((entry) => entry.mediaId === selectedAnime.mediaId) ??
            selectedAnime
          }
          episode={selected?.episode ?? undefined}
          key={`${selected?.id}`}
          localSources={selected?.sources}
        />
      ) : null}
    </>
  );
}
