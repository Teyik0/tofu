// biome-ignore-all lint/performance/noBarrelFile: Preserve the host API boundary while sharing canonical workspace contracts.
import type { FormStore } from "@formisch/react";
import type { SyncRuntimeOptions } from "@teyik0/furin/sync";
import type { DrizzleSqliteSyncAdapter } from "@teyik0/furin/sync/drizzle";
import type { InferOutput } from "valibot";
import type { Options as TorrentNetworkOptions } from "webtorrent";
import type { TofuDatabase } from "./api/lib/db";
import type { AutomationService } from "./api/modules/automation/service";
import type { DesktopController } from "./api/modules/desktop/service";
import type { pluginConfigurationSchema, pluginFormSchema } from "./api/modules/plugins/model";
import type { UpdatesService } from "./api/modules/updates/service";

export type ApplicationSync = SyncRuntimeOptions<DrizzleSqliteSyncAdapter<TofuDatabase>>;
export type ApplicationInstance = InstanceConfig & { desktop: boolean };
export type NativeSdk = typeof import("electrobun/main");
export type ApplicationPlatform =
  | { kind: "server" }
  | {
      kind: "desktop";
      utils: Pick<NativeSdk["Utils"], "openFileDialog" | "openPath"> & {
        openExternal: (url: string) => boolean | Promise<boolean>;
      };
      controller: Pick<
        DesktopController,
        "snapshot" | "open" | "background" | "openDownload" | "installUpdate"
      >;
    };

export interface CoreApplication {
  readonly automation: AutomationService;
  close: () => Promise<void>;
  readonly db: TofuDatabase;
  readonly engine: EnginePort;
  readonly instance: ApplicationInstance;
  startBackground: () => void;
  readonly sync: ApplicationSync;
  readonly updates: UpdatesService;
}

export interface Application extends CoreApplication {
  readonly platform: ApplicationPlatform;
}

export type ApplicationState =
  | { phase: "starting" | "stopping" | "stopped" }
  | { phase: "ready"; application: Application };

export interface ApplicationProvider {
  readonly state: ApplicationState;
}

import type {
  DashboardState,
  Destination,
  DestinationInput,
  DestinationPresentation,
  FilePriority,
  InstanceConfig,
  PluginId,
  Settings,
  SettingsInput,
  TorrentDetail,
  TorrentSummary,
} from "@tofu/plugins/domain";

export * from "@tofu/plugins/domain";
export interface EngineOpenOptions {
  dataDir: string;
  downloadPath: string;
  network: TorrentNetworkOptions;
}

export interface TorrentAddOptions {
  destinationId?: string;
  downloadPath?: string;
  paused: boolean;
  trackers?: string[];
}

export interface EngineOperations {
  add: (input: string | Uint8Array, options: TorrentAddOptions) => Promise<{ id: string }>;
  addPeer: (id: string, peer: string) => Promise<{ ok: boolean }>;
  assertReady: () => void | Promise<void>;
  close: () => Promise<void>;
  detail: (id: string) => TorrentDetail | Promise<TorrentDetail>;
  file: (id: string, index: number) => Promise<{ name: string; path: string }>;
  pause: (id: string) => Promise<{ ok: boolean }>;
  priority: (id: string, index: number, priority: FilePriority) => Promise<{ ok: boolean }>;
  reannounce: (id: string) => { ok: boolean } | Promise<{ ok: boolean }>;
  remove: (id: string, deleteFiles: boolean) => Promise<{ ok: boolean }>;
  removeDestination: (id: string) => Promise<{ ok: boolean; removed: string }>;
  replaceTrackers: (id: string, urls: string[]) => Promise<{ ok: boolean }>;
  resume: (id: string) => Promise<{ ok: boolean }>;
  saveDestination: (id: string | null, input: DestinationInput) => Promise<Destination>;
  updateDestinationPresentation: (
    id: string,
    input: DestinationPresentation
  ) => Destination | Promise<Destination>;
  updateSettings: (settings: SettingsInput) => Promise<Settings>;
  verify: (id: string) => Promise<{ ok: boolean }>;
}

export interface EnginePort extends EngineOperations {
  mode: "desktop" | "server";
  readonly settings: Settings;
  snapshot: (selected: string | null, includeDetail?: boolean) => DashboardState;
}

export type EngineRequest =
  | {
      [Method in keyof EngineOperations]: {
        id: number;
        method: Method;
        args: Parameters<EngineOperations[Method]>;
      };
    }[keyof EngineOperations]
  | { id: number; method: "open"; args: [EngineOpenOptions] };

export type EngineMessage =
  | { type: "ready" }
  | { type: "snapshot"; state: DashboardState }
  | { type: "result"; id: number; value: unknown; state: DashboardState }
  | { type: "error"; id: number; message: string; status: number };

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
  | { type: "destination"; destination: Destination | null }
  | { type: "remove"; torrent: TorrentSummary }
  | { type: "trackers"; torrent: TorrentDetail }
  | { type: "peer"; torrent: TorrentDetail };

export type AutomationSection =
  | "inbox"
  | "rules"
  | "anilist"
  | "discover"
  | "history"
  | "preferences";
