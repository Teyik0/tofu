import type { problem } from "elysia";
import type { Destination, DestinationInput } from "./destination-model";
import type { DashboardState, TorrentDetail } from "./torrent-types";

export type CapabilityFailure =
  | ReturnType<typeof problem<400, { readonly detail: string }>>
  | ReturnType<typeof problem<404, { readonly detail: string }>>
  | ReturnType<typeof problem<409, { readonly detail: string }>>
  | ReturnType<typeof problem<429, { readonly detail: string }>>
  | ReturnType<typeof problem<502, { readonly detail: string }>>
  | ReturnType<typeof problem<503, { readonly detail: string }>>;

export interface TorrentCapabilities {
  detail: (id: string) => Promise<TorrentDetail | CapabilityFailure>;
  saveDestination: (
    id: string | null,
    input: DestinationInput
  ) => Promise<Destination | CapabilityFailure>;
}
export interface TorrentCapabilityOptions {
  call: {
    (
      method: "detail",
      args: Parameters<TorrentCapabilities["detail"]>
    ): ReturnType<TorrentCapabilities["detail"]>;
    (
      method: "saveDestination",
      args: Parameters<TorrentCapabilities["saveDestination"]>
    ): ReturnType<TorrentCapabilities["saveDestination"]>;
  };
  snapshot: (detail: string | null, full: boolean) => DashboardState;
}
