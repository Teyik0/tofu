import type { AvailabilityQuery, EpisodeSource } from "../library-links/availability";
import type { NotificationsQuery, NotificationType } from "./graphql/generated";
import type { NotificationFilters } from "./model";
import { animeEpisodeOffset, localAnimeSearch } from "./releases";
import type { AniListEntry, AniListMedia } from "./types";

export const notificationTypes = {
  airing: ["AIRING"],
  all: ["AIRING", "MEDIA_DATA_CHANGE", "MEDIA_DELETION", "MEDIA_MERGE", "RELATED_MEDIA_ADDITION"],
  media: ["MEDIA_DATA_CHANGE", "MEDIA_DELETION", "MEDIA_MERGE", "RELATED_MEDIA_ADDITION"],
} satisfies Record<NotificationFilters["category"], NotificationType[]>;

type Notification = Extract<
  NonNullable<NonNullable<NonNullable<NotificationsQuery["Page"]>["notifications"]>[number]>,
  { id: number }
>;

export function notificationView(notification: Notification, sources: EpisodeSource[] = []) {
  const media = "media" in notification ? notification.media : null;
  const title =
    media?.title?.userPreferred ??
    media?.title?.english ??
    media?.title?.romaji ??
    ("deletedMediaTitle" in notification ? notification.deletedMediaTitle : null) ??
    "AniList update";
  const anime: AniListMedia | null =
    media?.type === "ANIME"
      ? {
          aliases: [
            ...new Set(
              [
                media.title?.romaji,
                media.title?.english,
                media.title?.native,
                media.title?.userPreferred,
                ...(media.synonyms ?? []),
              ].filter((name): name is string => typeof name === "string" && name.trim().length > 0)
            ),
          ].slice(0, 30),
          bannerImage: media.bannerImage ?? null,
          coverImage: media.coverImage?.large ?? null,
          episodes: media.episodes ?? null,
          format: media.format ?? null,
          genres: (media.genres ?? []).filter(
            (genre): genre is string => typeof genre === "string"
          ),
          mediaId: media.id,
          season: media.season ?? null,
          seasonYear: media.seasonYear ?? null,
          siteUrl: media.siteUrl ?? null,
          title,
        }
      : null;
  const episode = "episode" in notification ? notification.episode : null;
  const context = "context" in notification ? notification.context : null;
  const text =
    episode === null
      ? context?.trim() ||
        notification.type?.toLowerCase().replaceAll("_", " ") ||
        "New notification"
      : `Episode ${episode} is now airing.`;
  const url = media?.siteUrl ?? "https://anilist.co/notifications";
  return {
    anime,
    createdAt: notification.createdAt,
    episode,
    id: notification.id,
    image: media?.coverImage?.large ?? null,
    reason: "reason" in notification ? notification.reason : null,
    sources,
    text,
    title,
    type: notification.type,
    url,
  };
}

export type AniListNotification = ReturnType<typeof notificationView>;

export function notificationAvailabilityQueries(
  notifications: AniListNotification[],
  entries: AniListEntry[]
): AvailabilityQuery[] {
  return notifications.flatMap((notification) => {
    const { anime, episode } = notification;
    if (!anime || episode === null) {
      return [];
    }
    const entry = entries.find((item) => item.mediaId === anime.mediaId) ?? anime;
    const plan = localAnimeSearch(entry);
    return [
      {
        episodeOffset: animeEpisodeOffset(entry, entries),
        episodes: [episode],
        infoHashes: [],
        key: String(notification.id),
        part: plan.part ?? 1,
        season: plan.season ?? 1,
        titles: [...new Set([entry.title, ...entry.aliases, ...plan.seriesTitles])].slice(0, 12),
      },
    ];
  });
}
