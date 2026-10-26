import { useMutation } from "@teyik0/furin/client";
import { useAtomValue } from "jotai";
import {
  type ContextType,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { NotificationFilters } from "@/api/modules/anilist/model";
import type { AniListNotifications } from "@/api/modules/anilist/service";
import { useAsyncAction } from "@/hooks/use-async-action";
import { api } from "@/lib/client";
import { errorMessage } from "@/lib/errors";
import { anilistNotificationRevisionAtom, dashboardAtom } from "@/state/workspace";

import type { aniListContext } from "../_context";

export function useInbox(state: NonNullable<ContextType<typeof aniListContext>>) {
  const revision = useAtomValue(anilistNotificationRevisionAtom);
  const dashboard = useAtomValue(dashboardAtom);
  const availability = JSON.stringify(
    dashboard?.torrents.map((torrent) => [
      torrent.id,
      torrent.status,
      torrent.progress === 1,
      torrent.storageIssue,
    ])
  );
  const [category, setCategory] = useState<NotificationFilters["category"]>("all");
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [inbox, setInbox] = useState<AniListNotifications | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const actions = useAsyncAction("Unable to mark notifications as read");
  const markRead = useMutation(api.anilist.notifications.read.post);
  const readAttempt = useRef<AniListNotifications | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<ReturnType<typeof notificationScrollAnchor>>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore the visible row after React commits the refreshed inbox.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor?.row.isConnected) {
      anchor.scroller.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
    }
  }, [inbox]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Recheck on inbox changes, local torrent lifecycle changes and explicit retries, not every workspace revalidation.
  useEffect(() => {
    if (!state.anilist.authenticated) {
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      setError(null);
      try {
        const responses = await Promise.all(
          Array.from({ length: page }, (_, index) =>
            api.anilist.notifications.get({
              fetch: { signal: controller.signal },
              query: { category, page: index + 1 },
            })
          )
        );
        if (controller.signal.aborted) {
          return;
        }
        const failure = responses.find((response) => response.error)?.error;
        if (failure) {
          setError(errorMessage(failure, "Unable to load notifications"));
          return;
        }
        const pages = responses.flatMap(({ data }) => (data ? [data] : []));
        const lastPage = pages.at(-1);
        if (lastPage) {
          anchorRef.current = notificationScrollAnchor(feedRef.current);
          setInbox({
            ...lastPage,
            notifications: [
              ...new Map(
                pages
                  .flatMap((result) => result.notifications)
                  .map((notification) => [notification.id, notification])
              ).values(),
            ],
          });
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause, "Unable to load notifications"));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [state.anilist.authenticated, category, page, attempt, revision, availability]);

  const markVisibleAsRead = useEffectEvent(() => {
    if (
      !inbox?.unreadCount ||
      loading ||
      error ||
      actions.busy ||
      document.visibilityState !== "visible" ||
      readAttempt.current === inbox
    ) {
      return;
    }
    const viewedInbox = inbox;
    readAttempt.current = viewedInbox;
    actions.action(async () => {
      await markRead.mutateAsync({});
      setInbox((current) => (current === viewedInbox ? { ...current, unreadCount: 0 } : current));
    });
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Check the committed inbox again when loading or a previous read completes.
  useEffect(() => {
    markVisibleAsRead();
    document.addEventListener("visibilitychange", markVisibleAsRead);
    return () => document.removeEventListener("visibilitychange", markVisibleAsRead);
  }, [inbox, loading, error, actions.busy]);

  const inboxPage = inbox?.page;
  const hasNextPage = inbox?.hasNextPage;
  useEffect(() => {
    const sentinel = endRef.current;
    if (
      !(state.anilist.authenticated && hasNextPage) ||
      inboxPage === undefined ||
      loading ||
      error ||
      actions.busy ||
      !sentinel
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observations) => {
        if (observations.some((observation) => observation.isIntersecting)) {
          observer.disconnect();
          setLoading(true);
          setPage(inboxPage + 1);
        }
      },
      { rootMargin: "300px 0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [state.anilist.authenticated, hasNextPage, inboxPage, loading, error, actions.busy]);

  return {
    actions,
    attempt,
    category,
    endRef,
    error,
    feedRef,
    inbox,
    loading,
    page,
    setAttempt,
    setCategory,
    setInbox,
    setLoading,
    setPage,
    state,
  };
}

function notificationScrollAnchor(feed: HTMLDivElement | null) {
  if (!feed) {
    return null;
  }
  let scroller = document.scrollingElement;
  for (let parent = feed.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (
      parent.scrollHeight > parent.clientHeight &&
      (overflow === "auto" || overflow === "scroll")
    ) {
      scroller = parent;
      break;
    }
  }
  if (!scroller || scroller.scrollTop === 0) {
    return null;
  }
  const viewportTop =
    scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
  const row = [...feed.querySelectorAll<HTMLElement>(".notification-row")].find(
    (element) => element.getBoundingClientRect().bottom > viewportTop
  );
  return row ? { row, scroller, top: row.getBoundingClientRect().top } : null;
}
