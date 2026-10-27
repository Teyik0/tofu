import type { FurinSyncOptions } from "@teyik0/furin/sync";
import type { AnimeMapping } from "@tofu/plugins/anime-mapping";
import type {
  AutomationDecision,
  AutomationDraft,
  AutomationRule,
  AutomationState,
} from "@tofu/plugins/automation-model";
import type { AvailabilityQuery, EpisodeSource } from "@tofu/plugins/availability";
import type { DiscoveryResult, FeedRelease } from "@tofu/plugins/discovery-model";
import type { StoredPlugin } from "@tofu/plugins/plugin-model";
import type {
  CapabilityFailure,
  TorrentCapabilityOptions,
} from "@tofu/plugins/torrent-capabilities";
import { Context, type Effect } from "effect";
import type { problem } from "elysia";
import type { AniListClient } from "./client";
import type { AniListService } from "./service";
import type { DatabaseConnection, DatabaseTransaction, TofuDatabase } from "./storage";

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

// The host supplies typed capabilities; this package never imports an application.
export interface AniListOptions {
  automation: {
    snapshot: () => Omit<AutomationState, "plugins">;
    ruleSnapshot: (id: string) => AutomationRule | undefined;
    enableRule: (id: string, enabled: boolean, connection?: DatabaseConnection) => void;
    refreshState: () => void;
  };
  client?: AniListClient;
  db: TofuDatabase;
  discovery: {
    cachedReleases: () => FeedRelease[];
    animeMapping: (mediaId: number) => Effect.Effect<AnimeMapping | null>;
    search: (
      query: string,
      sources: string[],
      cachedSearch?: boolean
    ) => Effect.Effect<DiscoveryResult>;
  };
  endpoint: string;
  engine: TorrentCapabilityOptions;
  episodeSources: (
    queries: AvailabilityQuery[]
  ) => Promise<{ key: string; sources: EpisodeSource[] }[] | CapabilityFailure>;
  now: () => number;
  plugins: {
    plugin: (id: string) => StoredPlugin;
    configure: (
      id: string,
      input: { enabled: boolean; apiKey?: string; dailyLimit?: number }
    ) => import("@tofu/plugins/plugin-model").PluginState[] | CapabilityFailure;
  };
  releaseAutomation: {
    prepareRule: (
      id: string | null,
      draft: AutomationDraft,
      ownership?: RuleOwnership
    ) => Effect.Effect<PreparedAutomationRule | CapabilityFailure>;
    writeRule: (
      connection: DatabaseTransaction,
      prepared: PreparedAutomationRule
    ) => AutomationRule | CapabilityFailure;
    save: (
      id: string | null,
      draft: AutomationDraft,
      ownership?: RuleOwnership
    ) => Effect.Effect<AutomationRule | CapabilityFailure>;
    run: (id: string) => Effect.Effect<AutomationState | CapabilityFailure>;
  };
  tokenEndpoint: string;
}

export class AniListCapabilities extends Context.Service<AniListCapabilities, AniListOptions>()(
  "tofu/anilist-capabilities"
) {}

export interface AniListApplication {
  anilist: AniListService;
  automation: AniListOptions["automation"];
  caller:
    | { kind: "owner" | "anonymous" }
    | { kind: "device"; device: { id: string; kind: string } };
  platform: { kind: "server" } | { kind: "desktop"; openExternal: (url: string) => boolean };
  releaseAutomation: AniListOptions["releaseAutomation"];
}
export interface AniListApiDependencies {
  application: () => Omit<AniListApplication, "caller">;
  authorize: (
    request: Request
  ) =>
    | { kind: "owner" }
    | { kind: "device"; device: { id: string; kind: string } }
    | ReturnType<typeof problem<401, { readonly detail: string }>>
    | ReturnType<typeof problem<403, { readonly detail: string }>>;
  sync: FurinSyncOptions;
}
