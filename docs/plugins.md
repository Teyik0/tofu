# Plugins and automation

Open **Plugins** in the sidebar to enable integrations. All plugins start disabled. C411 and Jev require personal API keys. Credentials stay on the Bun side and are excluded from public state; they are stored locally without encryption.

Installed plugins are listed at `/plugins`. Sources, Intelligence and Integrations have separate pages at `/plugins/sources`, `/plugins/intelligence` and `/plugins/integrations`. The navigation stays in place while each page mounts only its plugin cards. Unsaved credentials remain in memory across section changes and are discarded when leaving Plugins.

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

Anime rules search the romaji title first, then the English title on each searchable source if no release passes the rule's requirements and matching checks. AniList rules reuse their saved aliases; Jev rules without aliases resolve canonical titles through the public catalogue and keep the entered title if it is unavailable. Tsundere's recent feed is fetched once. Previews, initial release exclusion, and scheduled checks use the same search behavior.

A single language or resolution is a requirement. Multiple values are allowed fallbacks in the listed order. An optional waiting period gives better releases time to arrive. Jev matches below 75% are excluded from previews and automation decisions. Scores from 75% to below 95% require approval from history; scores of at least 95% can download automatically when the rule allows it. The score is the lower of the identity and requirements evaluations.

After downloading a fallback, Tofu keeps looking for a strictly better release. Equal quality and changing peer counts do not trigger replacement. Once an ideal version is found, monitoring continues for new episodes. Releases you deliberately remove or ignore stay excluded.

The original torrent stays available until its replacement finishes downloading. Old files are deleted only if the rule's explicit deletion option is enabled; it is off by default. Pending downloads and replacements survive restarts.

Rules follow destination IDs through renames and folder changes. Catch-up is limited to releases still available from each source; a recent RSS feed is not a full archive.

## AniList

Open **AniList** in the sidebar for a cover grid using the active Furin theme. Watching and Plan to Watch are visible by default; the visible-status filter is saved locally and can include any AniList list status. Search matches titles and aliases. Click a cover to open its episode modal.

Click **Connect AniList**, then sign in and authorize Tofu in your browser. Tofu verifies your account, enables the AniList plugin, and loads your lists automatically. No API key or client secret is required. The release uses AniList's implicit grant with public client ID `9037` and the registered callback `tofu://oauth/anilist`. AniList takes the callback from its developer settings; Tofu does not pass a `redirect_uri` parameter in the implicit authorization URL. The browser returns to the native app without a callback port. Tofu checks the callback scheme, path and one-time state before verifying and storing the token. This avoids embedding a shared client secret or operating a separate OAuth exchange server.

macOS registers the scheme through the app bundle. Windows and Linux register a per-user handler on first launch; their packaged Bun helper forwards the callback to the matching running instance through its existing loopback API. Development registers only `tofu-dev://oauth/anilist` and needs a separate AniList client. Reconnect if the app was quit during authorization: pending attempts expire after ten minutes and are not restored after restarting. Custom local HTTP callbacks remain supported for existing API clients.

**Use a public account name instead** reads a public list without authorization. Watched-episode updates require a connected account. Existing saved tokens, account names, and custom OAuth clients remain supported through the API. For a custom client, its callback URL must exactly match its AniList developer settings.

The episode modal searches enabled torrent sources, shows release variants and real download progress, and lets you choose a destination. Packs and releases without episode numbers are shown separately. Missing counts and release statistics remain unknown. Previously discovered releases stay available in the local catalogue.

Marking an episode **Completed** requires an authenticated AniList account. Tofu stores individual episode marks per account, including episodes watched out of order, and writes only consecutive progress to AniList. For example, marking episode 2 first leaves progress at 0; marking episode 1 then sends progress 2. Unmarking an earlier episode lowers the consecutive progress while preserving later marks. Progress changes do not change the anime's list status. A failed write leaves the previous marks intact.

The **Automation** tab edits the rule for this anime. Sources, quality, language, destination, automatic approval, and replacement preferences override the default tracking template and survive synchronization. Saving a rule makes it available to the existing automation scheduler; **Run now** checks immediately. Replaced files are preserved unless you enable the explicit deletion option.

Load Watching and/or Plan to Watch, then explicitly select titles allowed to download. Each new title needs validation. Unchecking a title stops its Tofu rules without changing AniList or deleting downloads. Watched episodes are skipped, and titles removed from the selected lists are paused.

Choose either:

- **One destination per anime** — preview folders under a shared root, such as `/video/one-piece`. Edit proposed names and paths or reuse existing destinations.
- **One shared destination** — keep all selected anime in the same tab, with a separate rule for each title.

Previewing creates no folders. Initial source preferences use Nyaa and remain editable. Create tracking only after reviewing titles and destinations. Choices persist across synchronization and restarts. Disabling AniList or removing list tracking stops its linked rules while preserving downloaded data. Independently saved anime rules can be paused in their Automation tab or the automation center.

The library is a Furin page backed by the existing Bun AniList and automation services. This keeps credentials, release discovery, progress writes, and downloads on the server. Embedding AniList's website would not provide Tofu's download state or episode controls.
