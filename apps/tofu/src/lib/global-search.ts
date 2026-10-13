import type { FeedRelease, SearchReleaseGroup, TorrentSummary } from "../types";

const queryWords = /\s+/;

export function searchTorrents(torrents: TorrentSummary[], query: string) {
  const words = query.trim().toLocaleLowerCase("en-US").split(queryWords);
  return torrents
    .filter((torrent) => {
      const name = torrent.name.toLocaleLowerCase("en-US");
      return words.every((word) => name.includes(word));
    })
    .sort((first, second) => second.addedAt - first.addedAt);
}

export function groupSearchReleases(releases: FeedRelease[]): SearchReleaseGroup[] {
  const groups = new Map<string, SearchReleaseGroup>();
  for (const release of releases) {
    const key = release.infoHash?.toLowerCase() ?? `${release.sourceId}:${release.id}`;
    const group = groups.get(key);
    if (group) {
      group.releases.push(release);
    } else {
      groups.set(key, { key, releases: [release] });
    }
  }
  return [...groups.values()];
}
