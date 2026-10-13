import type { SyncRuntimeOptions, TransactionalSyncAdapter } from "@teyik0/furin/sync";
import type {
  AniListClient,
  AutomationDecision,
  AutomationDraft,
  AutomationRule,
  AutomationState,
  DashboardState,
  Destination,
  DestinationInput,
  DiscoveryResult,
  DiscoverySearch,
  FeedRelease,
  PluginState,
  SourcePluginId,
} from "@tofu/plugins/domain";
import type { JevQuestions, JevResult } from "@tofu/plugins/jev-questions";
import type { AniListService } from "./service";
import type { DatabaseConnection } from "./storage";

export interface PreparedAutomationRule {
  baseline: AutomationDecision[];
  expectedRevision: number | null;
  rule: AutomationRule;
}
export interface RuleOwnership {
  executorId?: string;
  key: string;
  ownerId: string;
}
// These are injected plugin capabilities; the package never loads the desktop application.
export interface AniListOptions {
  automation: {
    snapshot: () => Omit<AutomationState, "plugins">;
    ruleSnapshot: (id: string) => AutomationRule | undefined;
    enableRule: (id: string, enabled: boolean, connection?: DatabaseConnection) => unknown;
    writeRule: (connection: DatabaseConnection, prepared: PreparedAutomationRule) => AutomationRule;
    refreshState: () => void;
  };
  client?: AniListClient;
  discovery: {
    cachedReleases: () => FeedRelease[];
    search: (query: string, sources: SourcePluginId[]) => Promise<DiscoveryResult>;
    rank: (
      query: string,
      search: DiscoverySearch,
      candidates: FeedRelease[],
      matches: (release: FeedRelease) => boolean
    ) => Promise<FeedRelease[]>;
  };
  endpoint: string;
  engine: {
    snapshot: (detail: string | null, full: boolean) => DashboardState;
    saveDestination: (id: string | null, input: DestinationInput) => Promise<Destination>;
  };
  jev: { evaluate: (state: object, questions: JevQuestions) => Promise<JevResult | null> };
  now: () => number;
  plugins: {
    plugin: (id: string) => PluginState & { apiKey: string; callsDay: string };
    configure: (
      id: string,
      configuration: { enabled: boolean; apiKey?: string; dailyLimit?: number }
    ) => unknown;
  };
  releaseAutomation: {
    prepareRule: (
      id: string | null,
      draft: AutomationDraft,
      ownership?: RuleOwnership
    ) => Promise<PreparedAutomationRule>;
    save: (
      id: string | null,
      draft: AutomationDraft,
      ownership?: RuleOwnership
    ) => Promise<AutomationRule>;
    run: (id: string) => Promise<AutomationState>;
  };
  tokenEndpoint: string;
}
export interface AniListApplication {
  anilist: AniListService;
  automation: AniListOptions["automation"];
  platform: { kind: "server" } | { kind: "desktop"; openExternal: (url: string) => boolean };
  releaseAutomation: AniListOptions["releaseAutomation"];
}
export interface AniListApiDependencies {
  application: () => AniListApplication;
  sync: SyncRuntimeOptions<TransactionalSyncAdapter<DatabaseConnection, "sync">>;
}
