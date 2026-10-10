export type InstanceProfile = "dev" | "release";

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

export interface Settings {
  downloadLimit: number;
  downloadPath: string;
  runInBackground: boolean;
  theme: ThemePreference;
  uploadLimit: number;
}

export interface SettingsInput extends Omit<Settings, "runInBackground" | "theme"> {
  moveFiles?: boolean;
  runInBackground?: boolean;
  theme?: ThemePreference;
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
  downloaded: number;
  index: number;
  length: number;
  name: string;
  path: string;
  priority: FilePriority;
  progress: number;
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
  downloaded: number;
  downloadSpeed: number;
  error: string | null;
  eta: number | null;
  id: string;
  length: number;
  name: string;
  peers: number;
  progress: number;
  ratio: number | null;
  received: number;
  seeds: number;
  status: TorrentStatus;
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
  verifiedPieces: number;
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

export type SourcePluginId = "nyaa" | "tsundere" | "c411";
export type PluginId = SourcePluginId | "jev" | "anilist";
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
  languages: string[];
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
  publishedAt: number | null;
  resolution: string | null;
  season: number | null;
  seeders: number | null;
  size: number | null;
  sourceId: SourcePluginId;
  title: string;
  workTitle: string;
}
export interface DiscoveryResult {
  errors: { sourceId: SourcePluginId; message: string }[];
  releases: FeedRelease[];
  search?: DiscoverySearch;
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
  languages: string[];
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
export interface AniListEntry {
  aliases: string[];
  automationId: string | null;
  bannerImage: string | null;
  completedEpisodes: number[];
  coverImage: string | null;
  episodes: number | null;
  format: string | null;
  genres: string[];
  mediaId: number;
  progress: number;
  season: AniListSeason | null;
  seasonYear: number | null;
  siteUrl: string | null;
  status: AniListStatus;
  title: string;
}
export interface AniListReleases extends DiscoveryResult {
  torrents: TorrentSummary[];
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
  redirectUri: string;
  selections: { mediaId: number; enabled: boolean }[];
  subscriptions: AniListSubscription[];
  userName: string;
  visibleStatuses: AniListStatus[];
}
export interface AutomationRule extends AutomationDraft {
  createdAt: number;
  error: string | null;
  id: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  status: "active" | "paused" | "source-disabled" | "running" | "error";
}
export interface AutomationDecision {
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
