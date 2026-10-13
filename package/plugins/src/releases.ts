import type { FeedRelease } from "./domain";

export function publicRelease(release: FeedRelease) {
  return release.sourceId === "c411" || release.privateDownload
    ? {
        ...release,
        downloadUrl: `private:${release.sourceId}:${release.id}`,
        pageUrl:
          release.privateDownload || release.pageUrl?.includes("apikey=") ? null : release.pageUrl,
      }
    : release;
}
