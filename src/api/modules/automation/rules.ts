import { normalizeTitle } from "../../lib/title";
import type { FeedRelease } from "../discovery/model";
import type { SourcePluginId } from "../plugins/model";
import type { AutomationDraft, AutomationPreferences } from "./model";

const feedExpression3 = /[«"“]([^»"”]+)[»"”]/;
const feedExpression4 =
  /^(?:(?:t[eé]l[eé]charge(?:r)?|suivre|r[eé]cup[eè]re|download|follow)\s+(?:les\s+|the\s+)?(?:nouveaux?\s+|new\s+)?(?:episodes?\s+(?:of\s+|de\s+)?|[eé]pisodes?\s+(?:de\s+)?)?|(?:les\s+|the\s+)?(?:nouveaux?\s+|new\s+)?(?:episodes?\s+(?:of\s+|de\s+)?|[eé]pisodes?\s+(?:de\s+)?))/i;
const feedExpression5 =
  /\s+(?:(?:saison|season)\s+\d+|s\d+\b|(?:en|with|in)\s+(?:VF|VOSTFR|MULTI)|(?:en|with|in)\s+\d{3,4}p|(?:(?:en|with|in)\s+)?(?:x26[45]|h[ .]?26[45]|HEVC|AVC|AV1)\b|pr[eé]f[eè]re|prefer|avec\s|with\s|sur\s|on\s)|[,;]/i;
const feedExpression6 = /\b(?:2160|1080|900|720|480)p\b/gi;
const feedExpression7 = /\b(?:VOSTFR|VF|MULTI)\b/gi;
const feedExpression8 = /tsundere(?:-raws)?/i;
const feedExpression9 = /nyaa(?:\.si)?/i;
const feedExpression10 = /c411/i;
const feedExpression11 = /\b(?:(?:saison|season)\s+|s)(\d+)\b/i;
const codecExpression = /\b(?:x26[45]|h[ .]?26[45]|HEVC|AVC|AV1)\b/gi;
const unrestrictedLanguages =
  /\b(?:(?:any|all|every)\s+languages?|no\s+language\s+restrictions?|(?:toutes?\s+(?:les\s+)?)langues?|sans\s+restriction\s+de\s+langue)\b/i;
const unrestrictedResolutions =
  /\b(?:(?:any|all|every)\s+resolutions?|no\s+resolution\s+restrictions?|(?:toutes?\s+(?:les\s+)?)r[eé]solutions?|sans\s+restriction\s+de\s+r[eé]solution)\b/i;

export const defaultAutomationPreferences: AutomationPreferences = {
  automatic: true,
  codecs: ["H.265", "H.264"],
  deleteReplacedFiles: false,
  excludePacks: true,
  intervalMinutes: 15,
  languages: ["VOSTFR", "MULTI"],
  paused: false,
  priority: ["language", "resolution", "source", "codec"],
  resolutions: ["1080p", "720p"],
  sources: ["tsundere", "nyaa", "c411"],
  waitMinutes: 0,
};
/** Formats and sources named in the request win over the general preferences. */
export function interpretLocally(
  query: string,
  destinationId: string,
  preferences: AutomationPreferences
): AutomationDraft {
  const explicit = query.match(feedExpression3)?.[1];
  const title =
    explicit ?? query.replace(feedExpression4, "").split(feedExpression5)[0]?.trim() ?? query;
  const resolutions = [...new Set(query.match(feedExpression6) ?? [])].map((value) =>
    value.toLowerCase()
  );
  const languages = [...new Set(query.match(feedExpression7) ?? [])]
    .map((value) => value.toUpperCase())
    .filter(
      (value): value is NonNullable<FeedRelease["language"]> =>
        value === "VF" || value === "VOSTFR" || value === "MULTI"
    );
  const codecs = [
    ...new Set(
      (query.match(codecExpression) ?? []).map((value) => {
        const token = value.toUpperCase();
        if (token === "AV1") {
          return "AV1";
        }
        return token === "HEVC" || token.endsWith("265") ? "H.265" : "H.264";
      })
    ),
  ];
  const known: { id: SourcePluginId; expression: RegExp }[] = [
    { expression: feedExpression8, id: "tsundere" },
    { expression: feedExpression9, id: "nyaa" },
    { expression: feedExpression10, id: "c411" },
  ];
  const listed = known
    .map((source) => ({ id: source.id, index: query.search(source.expression) }))
    .filter((source) => source.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((source) => source.id);
  const season = query.match(feedExpression11)?.[1];
  const acceptedLanguages = languages.length ? languages : preferences.languages;
  const acceptedResolutions = resolutions.length ? resolutions : preferences.resolutions;
  return {
    ...preferences,
    codecs: codecs.length ? codecs : preferences.codecs,
    destinationId,
    enabled: true,
    includeExisting: false,
    languages: unrestrictedLanguages.test(query) ? [] : acceptedLanguages,
    matchMode: "exact",
    query,
    resolutions: unrestrictedResolutions.test(query) ? [] : acceptedResolutions,
    season: season === undefined ? null : Number(season),
    sources: listed.length ? listed : preferences.sources,
    title,
  };
}
export function localMatch(rule: AutomationDraft, release: FeedRelease) {
  const matches =
    rule.matchMode === "pattern"
      ? new RegExp(rule.title, "iu").test(release.title)
      : [rule.title, ...(rule.aliases ?? [])].some(
          (title) => normalizeTitle(release.workTitle) === normalizeTitle(title)
        );
  if (!matches && rule.matchMode !== "jev") {
    return "The title does not match";
  }
  if (rule.excludePacks && release.pack) {
    return "Packs are excluded";
  }
  if (
    rule.afterEpisode !== undefined &&
    rule.afterEpisode > 0 &&
    (release.episode === null || release.episode <= rule.afterEpisode)
  ) {
    return "Episode already watched or number unknown";
  }
  if (rule.season !== null && release.season !== rule.season) {
    return "Season differs or is unknown";
  }
  if (rule.languages.length && !(release.language && rule.languages.includes(release.language))) {
    return "Language not accepted or unknown";
  }
  if (
    rule.resolutions.length &&
    !(release.resolution && rule.resolutions.includes(release.resolution))
  ) {
    return "Resolution not accepted or unknown";
  }
  if (rule.codecs.length && !(release.codec && rule.codecs.includes(release.codec))) {
    return "Codec not accepted or unknown";
  }
  return null;
}
function position(values: string[], value: string | null) {
  const index = value === null ? -1 : values.indexOf(value);
  return index < 0 ? values.length : index;
}
export function compareQuality(rule: AutomationDraft, a: FeedRelease, b: FeedRelease) {
  for (const criterion of rule.priority) {
    const dimension = {
      codec: [rule.codecs, a.codec, b.codec],
      language: [rule.languages, a.language, b.language],
      resolution: [rule.resolutions, a.resolution, b.resolution],
      source: [rule.sources, a.sourceId, b.sourceId],
    } satisfies Record<
      AutomationDraft["priority"][number],
      [string[], string | null, string | null]
    >;
    const [values, first, second] = dimension[criterion];
    const difference = position(values, first) - position(values, second);
    if (difference) {
      return difference;
    }
  }
  return 0;
}
export function compareReleases(rule: AutomationDraft, a: FeedRelease, b: FeedRelease) {
  return (
    compareQuality(rule, a, b) || (b.seeders ?? -1) - (a.seeders ?? -1) || a.id.localeCompare(b.id)
  );
}
export function contentKey(release: FeedRelease) {
  return release.episode === null
    ? `release:${release.infoHash ?? normalizeTitle(release.workTitle)}`
    : `episode:${release.season ?? "unknown"}:${release.episode}`;
}
export function preferred(rule: AutomationDraft, release: FeedRelease) {
  return (
    (!rule.languages.length || release.language === rule.languages[0]) &&
    (!rule.resolutions.length || release.resolution === rule.resolutions[0]) &&
    (!rule.codecs.length || release.codec === rule.codecs[0]) &&
    release.sourceId === rule.sources[0]
  );
}
