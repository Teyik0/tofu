import { array, boolean, maxLength, object, optional, pipe, string } from "valibot";
import { source } from "../automation/model";
import type { SourcePluginId } from "../plugins/model";

export const discoverySchema = object({
  query: pipe(string(), maxLength(1000)),
  sources: optional(pipe(array(source), maxLength(32))),
});

export const addReleaseSchema = object({
  destinationId: string(),
  id: pipe(string(), maxLength(4096)),
  paused: boolean(),
  sourceId: source,
});

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

export interface DiscoverySearch {
  aliases: string[];
  episode: number | null;
  queries: string[];
  resolved: boolean;
  season: number | null;
  title: string;
  warning: string | null;
}
