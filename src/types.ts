import type { FormStore } from "@formisch/react";
import type { ApplicationRuntime } from "@teyik0/furin-electrobun/host";
import type { InferOutput } from "valibot";
import type { Options as TorrentNetworkOptions } from "webtorrent";
import type { pluginConfigurationSchema, pluginFormSchema } from "./api/modules/plugins/model";
import type { TorrentEngine } from "./api/modules/torrents/service";
import type { WorkerTorrentEngine } from "./api/modules/torrents/worker-client";

export type ApplicationInstance = InstanceConfig & { desktop: boolean };
export type ApplicationPlatform = ApplicationRuntime;

export type InstanceProfile = "dev" | "release";

export type DeviceRole = "playback" | "management" | "administration";
/** server: another Tofu server using this one as a playback source for its own AniList. */
export type DeviceKind = "browser" | "desktop" | "server";
/**
 * browser: cookie of a browser device; native: desktop bearer credential; window: desktop WebView
 * cookie; link: bearer credential of a linked server.
 */
export type SessionKind = "browser" | "native" | "window" | "link";

export interface ServerInfo {
  /** Private native session; stored only in the owner's descriptor. */
  cookie?: string;
  mode: "desktop" | "server";
  pid: number;
  profile: InstanceProfile;
  url: string;
}

export interface DesktopTarget {
  arch: "arm64" | "x64";
  platform: "macos" | "win" | "linux";
}

export interface InstanceConfig {
  dataDir: string;
  downloadPath: string;
  identifier: string;
  name: string;
  port: number;
  profile: InstanceProfile;
}

export type TorrentStatus =
  | "metadata"
  | "checking"
  | "moving"
  | "downloading"
  | "seeding"
  | "paused"
  | "idle"
  | "error";
export type FilePriority = "skip" | "normal" | "high";
export type ThemePreference = "system" | "light" | "dark";
export type SeedingConnectionMode = "balanced" | "incoming-only";

export interface Settings {
  deleteTorrentFileAfterAdd: boolean;
  downloadLimit: number;
  downloadPath: string;
  runInBackground: boolean;
  seedingConnectionMode: SeedingConnectionMode;
  theme: ThemePreference;
  uploadLimit: number;
}

export interface SettingsInput extends Partial<Settings> {
  moveFiles?: boolean;
}

export interface UpdateState {
  automatic: boolean;
  checkedAt: number | null;
  currentVersion: string;
  downloadName: string | null;
  error: string | null;
  latestVersion: string | null;
  progress: number | null;
  releaseUrl: string | null;
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "restarting"
    | "current"
    | "no-release"
    | "error";
}

export interface DesktopState {
  background: boolean;
  trayVisible: boolean;
  webviews: number;
  windows: number;
}

export interface AniListOpenResult {
  opened: boolean;
  url: string;
}

export interface TorrentDefaults {
  magnet: string | null;
  torrent: string | null;
}

export const destinationIconNames = [
  "folder",
  "film",
  "tv",
  "music",
  "book",
  "gamepad",
  "code",
  "archive",
  "star",
  "heart",
  "cloud",
  "flame",
] as const;
export type DestinationIconName = (typeof destinationIconNames)[number];

export interface Destination {
  /** New .torrent files in the folder since this time are added automatically; null disables it. */
  autoAddTorrentFilesSince: number | null;
  /** Overrides the global setting for this thread; null follows the global setting. */
  deleteTorrentFileAfterAdd: boolean | null;
  downloadPath: string;
  icon: DestinationIconName;
  id: string;
  name: string;
  pinned: boolean;
}

export interface DestinationPresentation {
  icon?: DestinationIconName;
  pinned?: boolean;
}

export interface DestinationInput extends DestinationPresentation {
  autoAddTorrentFiles?: boolean;
  deleteTorrentFileAfterAdd?: boolean | null;
  downloadPath: string;
  moveFiles?: boolean;
  name: string;
}

export interface TrackerStats {
  interval: number | null;
  lastAnnounce: number | null;
  leeches: number | null;
  message: string | null;
  seeds: number | null;
  status: "waiting" | "announcing" | "working" | "error" | "paused";
  url: string;
}

export interface FileStats {
  downloaded: number | null;
  index: number;
  length: number;
  name: string;
  path: string;
  priority: FilePriority;
  progress: number | null;
}

export interface TorrentStorageIssue {
  detectedAt: number;
  kind:
    | "missing-files"
    | "modified-files"
    | "storage-unavailable"
    | "permission-denied"
    | "no-space"
    | "invalid-path"
    | "io-error";
  message: string;
  paths: string[];
}

export interface PeerStats {
  address: string;
  client: string;
  downloaded: number;
  downloadSpeed: number;
  flags: string;
  id: string;
  progress: number | null;
  transport: string;
  uploaded: number;
  uploadSpeed: number;
}

export interface TorrentSummary {
  addedAt: number;
  completedAt: number | null;
  destinationId: string;
  downloaded: number | null;
  downloadSpeed: number;
  error: string | null;
  eta: number | null;
  id: string;
  length: number;
  name: string;
  peers: number;
  progress: number | null;
  ratio: number | null;
  received: number;
  seeds: number;
  status: TorrentStatus;
  storageIssue: TorrentStorageIssue | null;
  swarmPeers: number | null;
  swarmSeeds: number | null;
  uploaded: number;
  uploadSpeed: number;
}

export interface TorrentDetail extends TorrentSummary {
  activeSeconds: number;
  comment: string;
  createdBy: string;
  files: FileStats[];
  lastTransferAt: number | null;
  magnet: string;
  peerList: PeerStats[];
  pieceLength: number;
  pieceMap: number[];
  pieces: number;
  private: boolean;
  savePath: string;
  seedSeconds: number;
  trackers: TrackerStats[];
  verifiedPieces: number | null;
}

export interface SpeedSample {
  download: number;
  time: number;
  upload: number;
}

export interface SessionStats {
  active: number;
  dhtNodes: number;
  downloadSpeed: number;
  engine: string;
  freeSpace: number | null;
  mode: "desktop" | "server";
  peers: number;
  port: number;
  received: number;
  startedAt: number;
  uploaded: number;
  uploadSpeed: number;
}

export interface DashboardState {
  destinations: Destination[];
  detail: TorrentDetail | null;
  history: SpeedSample[];
  session: SessionStats;
  settings: Settings;
  torrents: TorrentSummary[];
}

/** Destination shown to every authenticated viewer; never carries host paths. */
export interface LibraryDestination {
  icon: DestinationIconName;
  id: string;
  name: string;
  pinned: boolean;
}

export interface LibraryStorageIssue {
  detectedAt: number;
  kind: TorrentStorageIssue["kind"];
}

/** Torrent summary safe for every authenticated viewer. */
export interface LibraryTorrent {
  addedAt: number;
  completedAt: number | null;
  destinationId: string;
  downloaded: number | null;
  downloadSpeed: number;
  /** Engine error with host paths removed. */
  error: string | null;
  eta: number | null;
  id: string;
  length: number;
  name: string;
  peers: number;
  progress: number | null;
  ratio: number | null;
  received: number;
  seeds: number;
  status: TorrentStatus;
  storageIssue: LibraryStorageIssue | null;
  swarmPeers: number | null;
  swarmSeeds: number | null;
  uploaded: number;
  uploadSpeed: number;
}

export interface LibraryFile {
  downloaded: number | null;
  index: number;
  length: number;
  name: string;
  priority: FilePriority;
  progress: number | null;
}

export interface LibraryTorrentDetail extends LibraryTorrent {
  activeSeconds: number;
  comment: string;
  createdBy: string;
  files: LibraryFile[];
  lastTransferAt: number | null;
  pieceLength: number;
  pieceMap: number[];
  pieces: number;
  private: boolean;
  seedSeconds: number;
  verifiedPieces: number | null;
}

export interface LibrarySession {
  active: number;
  downloadSpeed: number;
  freeSpace: number | null;
  peers: number;
  received: number;
  startedAt: number;
  uploaded: number;
  uploadSpeed: number;
}

/** Library snapshot identical for every authenticated viewer, including server rendering. */
export interface LibraryState {
  appearance: { theme: ThemePreference };
  destinations: LibraryDestination[];
  detail: LibraryTorrentDetail | null;
  history: SpeedSample[];
  server: { id: string; name: string };
  session: LibrarySession;
  torrents: LibraryTorrent[];
}

/** Host configuration and diagnostics, sent only to Administration and the owner. */
export interface HostState {
  destinations: Destination[];
  session: SessionStats;
  settings: Settings;
}

/** Torrent internals that reveal host paths, peers or tracker credentials. */
export interface TorrentHostDetail {
  files: { index: number; path: string }[];
  id: string;
  magnet: string;
  peerList: PeerStats[];
  savePath: string;
  storageIssue: TorrentStorageIssue | null;
  trackers: TrackerStats[];
}

/** Live workspace state: the shared library plus host details the caller may see. */
export interface LiveState extends LibraryState {
  detailHost: TorrentHostDetail | null;
  host: HostState | null;
}

export type SourcePluginId = string;
export type PluginId = SourcePluginId | "jev" | "anilist";
export type CredentialPluginId = "c411" | "jev";
export interface PluginCredentialPage {
  opened: boolean;
  url: string;
}
export interface StoredPlugin extends PluginState {
  apiKey: string;
  callsDay: string;
}

export interface PluginState {
  callsToday: number;
  checkedAt: number | null;
  dailyLimit: number;
  description: string;
  enabled: boolean;
  error: string | null;
  hasApiKey: boolean;
  id: PluginId;
  name: string;
}
export interface AutomationState {
  automations: AutomationRule[];
  decisions: AutomationDecision[];
  plugins: PluginState[];
  preferences: AutomationPreferences;
  updatedAt: number;
}
/** Defaults copied into every new rule; each rule can still override them. */
export interface AutomationPreferences {
  automatic: boolean;
  codecs: string[];
  deleteReplacedFiles: boolean;
  excludePacks: boolean;
  intervalMinutes: number;
  languages: NonNullable<FeedRelease["language"]>[];
  paused: boolean;
  priority: AutomationCriterion[];
  resolutions: string[];
  sources: SourcePluginId[];
  waitMinutes: number;
}

export interface FeedRelease {
  codec: string | null;
  downloadUrl: string;
  episode: number | null;
  id: string;
  infoHash: string | null;
  language: "VF" | "VOSTFR" | "MULTI" | null;
  pack: boolean;
  pageUrl: string | null;
  privateDownload?: boolean;
  publishedAt: number | null;
  resolution: string | null;
  season: number | null;
  seeders: number | null;
  size: number | null;
  /** Original numbering when a release is mapped to an AniList part's episodes. */
  sourceEpisode?: number;
  sourceId: SourcePluginId;
  title: string;
  workTitle: string;
}
export interface DiscoveryResult {
  errors: { sourceId: SourcePluginId; message: string }[];
  releases: FeedRelease[];
  search?: DiscoverySearch;
}
export interface SearchReleaseGroup {
  key: string;
  releases: FeedRelease[];
}
export type GlobalSearchScope = "all" | "torrents" | "sources";
export interface SourceSearchState {
  error: string | null;
  loading: boolean;
  releases: FeedRelease[];
  sourceId: SourcePluginId;
  warning: string | null;
}
export interface DiscoverySearch {
  aliases: string[];
  episode: number | null;
  queries: string[];
  resolved: boolean;
  season: number | null;
  title: string;
  warning: string | null;
}

export type AutomationCriterion = "language" | "resolution" | "source" | "codec";
export interface AutomationDraft {
  afterEpisode?: number;
  aliases?: string[];
  automatic: boolean;
  codecs: string[];
  deleteReplacedFiles?: boolean;
  destinationId: string;
  enabled: boolean;
  excludePacks: boolean;
  includeExisting: boolean;
  intervalMinutes: number;
  languages: NonNullable<FeedRelease["language"]>[];
  matchMode: "exact" | "pattern" | "jev";
  paused: boolean;
  priority: AutomationCriterion[];
  query: string;
  resolutions: string[];
  season: number | null;
  sources: SourcePluginId[];
  title: string;
  waitMinutes: number;
}

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
export interface AutomationRule extends AutomationDraft {
  createdAt: number;
  error: string | null;
  executorId?: string;
  id: string;
  key?: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  ownerId?: string;
  revision: number;
  status: "active" | "paused" | "source-disabled" | "running" | "error";
}
export interface AutomationDecision {
  approved?: boolean;
  automationId: string;
  contentKey: string;
  createdAt: number;
  deadline: number | null;
  id: string;
  probability: number | null;
  reason: string;
  release: FeedRelease;
  status: "waiting" | "review" | "adding" | "added" | "ignored" | "error";
  supersedes?: { release: FeedRelease; torrentId: string } | null;
  torrentId: string | null;
}
export interface AniListClient {
  clientId: string;
  redirectUri: string;
}

export interface EngineOpenOptions {
  connectionPolicy?: ConnectionPolicy;
  cryptoDiagnostics?: boolean;
  dataDir: string;
  downloadPath: string;
  network: TorrentNetworkOptions;
}

export interface ConnectionPolicy {
  attemptsPerSecond: number;
  burst: number;
  cooldownTtlMs: number;
  maxConnections: number;
  maxConnectionsPerTorrent: number;
  maxCooldownEntries: number;
  maxPending: number;
  retryDelaysMs: readonly number[];
  seedAttemptsPerSecond: number;
  seedBurst: number;
  seedIntervalMs: number;
  stableConnectionMs: number;
}

export interface ConnectionDiagnostics {
  connectedIncoming: number;
  connectedOutgoing: number;
  crypto: CryptoDiagnostics | null;
  deferredByCapacity: number;
  deferredByCooldown: number;
  deferredByRate: number;
  incomingHandshakes: number;
  outgoingAttempts: number;
  outgoingHandshakes: number;
  outgoingRetries: number;
  pendingOutgoing: number;
  queuedOutgoing: number;
}

export interface CryptoDiagnostics {
  attempts: number;
  failures: number;
  maxConstructorMilliseconds: number;
  totalConstructorMilliseconds: number;
}

export interface EngineSnapshot {
  sampledAt: number;
  state: DashboardState;
  stateRevision: number;
  telemetryRevision: number;
}

export interface EngineChange {
  kind: "state" | "telemetry";
  stateRevision: number;
  telemetryRevision: number;
}

/** A magnet link or .torrent file opened from the system, waiting for the user to add it. */
export interface OpenedTorrent {
  /** Thread whose folder contains the opened file, suggested as its destination. */
  destinationId: string | null;
  /** Set when the torrent is already in the library; it is shown instead of added again. */
  existing: { destinationId: string } | null;
  fileCount: number | null;
  id: string;
  infoHash: string;
  length: number | null;
  name: string;
}

export interface TorrentAddOptions {
  destinationId?: string;
  downloadPath?: string;
  operationKey?: string;
  paused: boolean;
  trackers?: string[];
}

export type EngineOperations = Pick<
  TorrentEngine,
  | "add"
  | "addPeer"
  | "assertReady"
  | "waitForRange"
  | "cancelRange"
  | "cancelRanges"
  | "close"
  | "connectionDiagnostics"
  | "detail"
  | "file"
  | "locate"
  | "pause"
  | "priority"
  | "reannounce"
  | "refreshSnapshot"
  | "remove"
  | "removeDestination"
  | "repair"
  | "replaceTrackers"
  | "resume"
  | "saveDestination"
  | "setObserved"
  | "updateDestinationPresentation"
  | "updateSettings"
  | "verify"
>;
export type EnginePort = TorrentEngine | WorkerTorrentEngine;

export type EngineRequest =
  | {
      [Method in keyof EngineOperations]: {
        id: number;
        method: Method;
        args: Parameters<EngineOperations[Method]>;
      };
    }[keyof EngineOperations]
  | { id: number; method: "open"; args: [EngineOpenOptions] };

export type EngineFailure =
  | { kind: "http"; code: string; message: string; status: number }
  | { kind: "internal"; message: string };

type EngineReturnedStatus = Extract<
  Awaited<ReturnType<EngineOperations[keyof EngineOperations]>>,
  { status: number; response: unknown }
>;

export type EngineMessage =
  | { type: "log"; line: string }
  | { type: "ready" }
  | { type: "snapshot"; snapshot: EngineSnapshot }
  | { type: "result"; id: number; value: unknown; snapshot: EngineSnapshot | null }
  | { type: "error"; id: number; failure: EngineFailure }
  | {
      type: "failure";
      id: number;
      status: EngineReturnedStatus["status"];
      body: EngineReturnedStatus["response"];
      headers: EngineReturnedStatus["headers"];
    };

export type PluginForm = FormStore<typeof pluginFormSchema>;
export type PluginConfiguration = InferOutput<typeof pluginConfigurationSchema>;
export type PluginForms = Record<PluginId, PluginForm>;

export type ModalKind =
  | FormModalKind
  | { type: "automation"; destinationId: string; section: AutomationSection }
  | { type: "deleteDestination"; destination: Destination };
export type FormModalKind =
  | { type: "add"; destinationId: string }
  | { type: "drop"; files: File[] }
  | { type: "open"; torrent: OpenedTorrent }
  | { type: "destination"; destination: Destination | null }
  | { type: "remove"; torrent: LibraryTorrent }
  | { type: "trackers"; torrent: LibraryTorrentDetail }
  | { type: "locate"; torrent: LibraryTorrentDetail }
  | { type: "peer"; torrent: LibraryTorrentDetail };

export type AutomationSection =
  | "inbox"
  | "rules"
  | "anilist"
  | "discover"
  | "history"
  | "preferences";

export type AsyncAction = (task: () => Promise<unknown>) => void;
