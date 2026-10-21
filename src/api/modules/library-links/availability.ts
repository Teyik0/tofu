import { ElysiaStatus } from "elysia";
import "@teyik0/furin/server-only";
import { normalizeTitle } from "../../lib/title";
import { parseDiscovery } from "../discovery/service";
import { releaseMetadata } from "../plugins/feeds";
import type { EnginePort } from "../torrents/service";

const PART_NUMBER = /\b(?:part|cour)\s*(\d+)\b/i;

export interface AvailabilityQuery {
  episodeOffset?: number | null;
  episodes: number[];
  infoHashes: string[];
  key: string;
  part?: number | null;
  season: number | null;
  titles: string[];
}

export interface EpisodeSource {
  episode: number | null;
  fileIndex: number;
  fileName: string;
  language: string | null;
  length: number;
  /** "infohash": same torrent as a release the requester knows; "title": parsed name match. */
  match: "infohash" | "title";
  progress: number | null;
  resolution: string | null;
  status: "playable" | "downloading" | "paused" | "unavailable";
  torrentId: string;
}

const MEDIA = /\.(?:avi|m2ts|m4v|mkv|mov|mp4|mpe?g|ogm|ts|webm|wmv)$/i;

/**
 * Finds files in this library matching episodes another server asks about. Infohashes match
 * exactly; otherwise parsed release names must share a normalized title, compatible season and
 * the episode number. Only the Playback-safe identity of each file is returned.
 */
export async function findEpisodeSources(engine: EnginePort, queries: AvailabilityQuery[]) {
  const { torrents } = engine.snapshot(null, false);
  const details = new Map<string, ReturnType<EnginePort["detail"]>>();
  const detail = (id: string) => {
    let value = details.get(id);
    if (!value) {
      value = engine.detail(id);
      details.set(id, value);
    }
    return value;
  };
  const results = await Promise.all(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Conservative matching checks all work, season, part, and episode constraints together.
    queries.map(async (query) => {
      const hashes = new Set(query.infoHashes.map((hash) => hash.toLowerCase()));
      const titles = new Set(
        query.titles.flatMap((title) => {
          const parsed = parseDiscovery(title);
          return [normalizeTitle(title), normalizeTitle(parsed.title)];
        })
      );
      const episodes = new Set(query.episodes);
      const sources: EpisodeSource[] = [];
      for (const torrent of torrents) {
        const exact = hashes.has(torrent.id);
        const named = releaseMetadata(torrent.name);
        const nameMatches =
          titles.has(normalizeTitle(named.workTitle)) ||
          titles.has(normalizeTitle(parseDiscovery(named.workTitle).title));
        if (!(exact || nameMatches)) {
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: details are cached and usually few.
        const found = await detail(torrent.id);
        if (found instanceof ElysiaStatus) {
          return found;
        }
        const { files } = found;
        for (const file of files) {
          if (!MEDIA.test(file.name)) {
            continue;
          }
          const parsed = releaseMetadata(file.name);
          const season = parsed.season ?? named.season;
          const fileTitle = normalizeTitle(parsed.workTitle);
          let episode = parsed.episode ?? (files.length === 1 ? named.episode : null);
          const explicitPart = `${file.name} ${torrent.name}`.match(PART_NUMBER)?.[1];
          let part = Number(explicitPart ?? 1);
          if (!explicitPart && (query.part ?? 1) > 1 && query.episodeOffset && episode !== null) {
            episode -= query.episodeOffset;
            part = query.part ?? 1;
          }
          const sameWork = exact || titles.has(fileTitle) || nameMatches;
          if (
            !sameWork ||
            part !== (query.part ?? 1) ||
            episode === null ||
            !episodes.has(episode) ||
            (query.season !== null && (season ?? 1) !== query.season)
          ) {
            continue;
          }
          let status: EpisodeSource["status"] = "downloading";
          if (found.storageIssue || torrent.status === "error") {
            status = "unavailable";
          } else if (file.progress === 1) {
            status = "playable";
          } else if (torrent.status === "paused") {
            status = "paused";
          }
          sources.push({
            episode,
            fileIndex: file.index,
            fileName: file.name,
            language: parsed.language ?? named.language,
            length: file.length,
            match: exact ? "infohash" : "title",
            progress: file.progress,
            resolution: parsed.resolution ?? named.resolution,
            status,
            torrentId: torrent.id,
          });
        }
      }
      return { key: query.key, sources };
    })
  );
  const failed = results.find((result) => result instanceof ElysiaStatus);
  if (failed) {
    return failed;
  }
  return results.filter((result) => !(result instanceof ElysiaStatus));
}
