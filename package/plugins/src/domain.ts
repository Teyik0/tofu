// biome-ignore-all lint/performance/noBarrelFile: Public SDK data contracts.
import type { AutomationDraft } from "./automation-model";
import type { DiscoveryResult } from "./discovery-model";
import type { TorrentSummary } from "./torrent-types";

export * from "./automation-model";
export * from "./destination-model";
export * from "./discovery-model";
export * from "./plugin-model";
export * from "./settings-model";
export * from "./torrent-types";
export type AniListStatus =
  | "CURRENT"
  | "PLANNING"
  | "COMPLETED"
  | "PAUSED"
  | "DROPPED"
  | "REPEATING";
export type AniListSeason = "WINTER" | "SPRING" | "SUMMER" | "FALL";
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
export interface AniListDate {
  day: number | null;
  month: number | null;
  year: number | null;
}
export interface AniListEntry extends AniListMedia {
  automationId: string | null;
  completedEpisodes: number[];
  progress: number;
  status: AniListStatus;
}
export type AniListScoreFormat =
  | "POINT_100"
  | "POINT_10_DECIMAL"
  | "POINT_10"
  | "POINT_5"
  | "POINT_3";
export interface AniListListEntry {
  advancedScores: { name: string; score: number }[];
  completedAt: AniListDate | null;
  customLists: string[];
  hiddenFromStatusLists: boolean | null;
  id: number;
  mediaId: number;
  notes: string | null;
  priority: number | null;
  private: boolean | null;
  progress: number;
  repeat: number | null;
  score: number | null;
  startedAt: AniListDate | null;
  status: AniListStatus;
}
export interface AniListEditor {
  entry: AniListListEntry | null;
  isFavourite: boolean | null;
  isFavouriteBlocked: boolean | null;
  options: {
    scoreFormat: AniListScoreFormat | null;
    customLists: string[];
    advancedScoring: string[];
    advancedScoringEnabled: boolean;
  };
}
export interface AniListListUpdate {
  advancedScores?: number[];
  completedAt?: AniListDate;
  customLists?: string[];
  hiddenFromStatusLists?: boolean;
  notes?: string;
  priority?: number;
  private?: boolean;
  progress?: number;
  repeat?: number;
  score?: number;
  startedAt?: AniListDate;
  status?: AniListStatus;
}
export interface AniListCatalog {
  hasNextPage: boolean;
  media: AniListMedia[];
  page: number;
}
export type AniListCatalogSort =
  | "title"
  | "popularity"
  | "score"
  | "trending"
  | "favourites"
  | "added"
  | "released";
export interface AniListCatalogFilters {
  airingStatus?: string;
  countryOfOrigin?: string;
  doujin?: "any" | "only" | "exclude";
  durationMax?: number;
  durationMin?: number;
  episodesMax?: number;
  episodesMin?: number;
  excludedGenres?: string[];
  excludedTags?: string[];
  format?: string;
  formats?: string[];
  genres?: string[];
  page?: number;
  search?: string;
  season?: AniListSeason;
  sort?: AniListCatalogSort;
  source?: string;
  streamingOn?: number;
  tags?: string[];
  year?: number;
  yearMax?: number;
  yearMin?: number;
}
export interface AniListCatalogOptions {
  genres: string[];
  streaming: { id: number; name: string }[];
  tags: { name: string; category: string; isAdult: boolean }[];
}
export interface AniListReleases extends DiscoveryResult {
  torrents: TorrentSummary[];
}
export interface AniListReleaseSearchPlan {
  entry: AniListMedia;
  part: number | null;
  season: number | null;
  seriesTitles: string[];
  titles: string[];
  warning: string | null;
}
export interface AniListThreadProposal {
  destinationId: string | null;
  downloadPath: string;
  mediaId: number;
  name: string;
}
export type AniListOrganization =
  | { mode: "shared" }
  | { mode: "per-anime"; basePath: string; overrides: AniListThreadProposal[] };
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
export interface AniListClient {
  clientId: string;
  redirectUri: string;
}
