import type { AutomationDraft } from "../automation/model";
import type { MediaListStatus, MediaSeason, ScoreFormat } from "./graphql/generated";
import type { AniListDate, AniListOrganization } from "./model";

export type AniListStatus = MediaListStatus;

export type AniListSeason = MediaSeason;

export interface AniListMedia {
  airingStatus?: string | null;
  aliases: string[];
  averageScore?: number | null;
  bannerImage: string | null;
  countryOfOrigin?: string | null;
  coverColor?: string | null;
  coverImage: string | null;
  duration?: number | null;
  endDate?: AniListDate | null;
  episodes: number | null;
  favourites?: number | null;
  format: string | null;
  genres: string[];
  isAdult?: boolean | null;
  isLicensed?: boolean | null;
  mediaId: number;
  nextAiringEpisode?: { episode: number; airingAt: number } | null;
  popularity?: number | null;
  releaseDate?: AniListDate | null;
  season: AniListSeason | null;
  seasonYear: number | null;
  siteUrl: string | null;
  source?: string | null;
  startDate?: number | null;
  streamingOn?: number[];
  studios?: string[];
  tags?: { name: string; rank: number; isAdult: boolean }[];
  title: string;
  trending?: number | null;
}

export interface AniListEntry extends AniListMedia {
  automationId: string | null;
  completedEpisodes: number[];
  progress: number;
  status: AniListStatus;
}

export type AniListScoreFormat = ScoreFormat;

export interface AniListCatalogOptions {
  genres: string[];
  streaming: { id: number; name: string }[];
  tags: { name: string; category: string; isAdult: boolean }[];
}

export interface AniListSubscription {
  bindings: { mediaId: number; ruleId: string; active: boolean }[];
  enabled: boolean;
  error: string | null;
  id: string;
  intervalMinutes: number;
  lastSyncAt: number | null;
  nextSyncAt: number | null;
  organization?: AniListOrganization;
  statuses: AniListStatus[];
  template: AutomationDraft;
  userId?: number;
}

export interface AniListState {
  accountId: number | null;
  authenticated: boolean;
  authorizationError: string | null;
  authorizationPending: boolean;
  clientId: string;
  connectedUser: string | null;
  entries: AniListEntry[];
  hasClientSecret: boolean;
  lastSyncedAt: number | null;
  redirectUri: string;
  refreshError: string | null;
  refreshing: boolean;
  selections: { mediaId: number; enabled: boolean }[];
  subscriptions: AniListSubscription[];
  userName: string;
  visibleStatuses: AniListStatus[];
}
