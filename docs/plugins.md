# Plugins and automation

Open **Plugins** in the sidebar to enable integrations. All plugins start disabled. C411 and Jev require personal API keys. Credentials stay on the Bun side and are excluded from public state; they are stored locally without encryption.

## Sources

- **Nyaa** searches RSS and falls back to the HTML catalogue when the RSS request fails.
- **Tsundere-Raws** reads the latest 250 torrent releases from the official JSON feed, using Nyaa as the provider. File-hosting links are excluded. Search filters this feed locally; it is not a complete archive.
- **C411** uses its authenticated Torznab API. Search requests are spaced by 4.1 seconds, and torrent files with private URL parameters are fetched on the server.

In discovery, enabled sources are selected by default. Uncheck a source to exclude it from a search without disabling its plugin.

## Jev and natural language search

Without a configured Jev plugin, discovery sends your literal keywords to each selected source. It does not interpret seasons or episodes or resolve title aliases.

With Jev enabled, requests such as `re zero S04E09` can resolve English, romanized Japanese, and Japanese aliases from the public AniList catalogue. This does not require an AniList account or its tracking plugin. Searches merge duplicate releases and filter by title, season, and episode. Unknown episode information is not treated as a match. If the catalogue is unavailable, Tofu continues with the entered title and reports the issue.

Jev interprets requests and checks release identity and requirements. Your ordered preferences still determine ranking. Evaluations are cached for 24 hours, and a daily call limit is configurable.

## Download rules

Open automation from a destination tab, describe what you want, then prepare and review the rule before creating it. For example:

> Download new episodes of Ao Ashi, prefer 1080p then 720p, and use Tsundere-Raws before Nyaa.

Review the title, sources, language, quality, and destination; reorder preferences and preview matches. Without Jev, use an exact title or an explicit regular expression. Disabling Jev falls back to exact-title matching; an outage defers verification.

A single language or resolution is a requirement. Multiple values are allowed fallbacks in the listed order. An optional waiting period gives better releases time to arrive. Uncertain Jev matches require approval from history.

After downloading a fallback, Tofu keeps looking for a strictly better release. Equal quality and changing peer counts do not trigger replacement. Once an ideal version is found, monitoring continues for new episodes. Releases you deliberately remove or ignore stay excluded.

The original torrent stays available until its replacement finishes downloading. Old files are deleted only if the rule's explicit deletion option is enabled; it is off by default. Pending downloads and replacements survive restarts.

Rules follow destination IDs through renames and folder changes. Catch-up is limited to releases still available from each source; a recent RSS feed is not a full archive.

## AniList

For a public list, an account name is enough. For OAuth, configure a client ID, client secret, and callback URL matching AniList's developer settings. The callback port must be available. Connect in your browser, return to Tofu, and refresh. An existing OAuth token can also be supplied directly.

Load Watching and/or Plan to Watch, then explicitly select titles allowed to download. Each new title needs validation. Unchecking a title stops its Tofu rules without changing AniList or deleting downloads. Watched episodes are skipped, and titles removed from the selected lists are paused.

Choose either:

- **One destination per anime** — preview folders under a shared root, such as `/video/one-piece`. Edit proposed names and paths or reuse existing destinations.
- **One shared destination** — keep all selected anime in the same tab, with a separate rule for each title.

Previewing creates no folders. Initial source preferences use Nyaa and remain editable. Create tracking only after reviewing titles and destinations. Choices persist across synchronization and restarts. Disabling AniList or removing tracking stops its rules while preserving downloaded data. Tofu never writes status or progress back to AniList.
