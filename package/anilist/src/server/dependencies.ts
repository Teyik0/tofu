import type { SyncRuntimeOptions, TransactionalSyncAdapter } from "@teyik0/furin/sync";
import type {
  AniListReleases,
  AutomationDecision,
  AutomationDraft,
  AutomationRule,
} from "@tofu/plugins/domain";
import type { AniListService } from "./service";
import type { DatabaseConnection } from "./storage";

export interface PreparedAutomationRule {
  baseline: AutomationDecision[];
  rule: AutomationRule;
}

export interface AniListApplication {
  automation: {
    anilist: AniListService;
    animeReleases: (mediaId: number) => Promise<AniListReleases>;
    prepareRule: (id: string | null, draft: AutomationDraft) => Promise<PreparedAutomationRule>;
    writeRule: (connection: DatabaseConnection, prepared: PreparedAutomationRule) => AutomationRule;
    refreshState: () => void;
  };
  platform:
    | { kind: "server" }
    | { kind: "desktop"; utils: { openExternal: (url: string) => boolean | Promise<boolean> } };
}

export interface AniListApiDependencies {
  application: () => AniListApplication;
  sync: SyncRuntimeOptions<TransactionalSyncAdapter<DatabaseConnection, "sync">>;
}
