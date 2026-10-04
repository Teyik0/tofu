import type { AutomationDraft, FeedRelease, SourcePluginId } from "../../types";

const feedExpression1 = /\p{M}/gu;
const feedExpression2 = /[^\p{L}\p{N}]+/gu;
const feedExpression3 = /[«"“]([^»"”]+)[»"”]/;
const feedExpression4 =
  /^(?:t[eé]l[eé]charge(?:r)?|suivre|r[eé]cup[eè]re|download)\s+(?:les\s+)?(?:nouveaux\s+)?(?:[eé]pisodes\s+(?:de\s+)?)?/i;
const feedExpression5 =
  /\s+(?:saison\s+\d+|en\s+(?:VF|VOSTFR|MULTI)|en\s+\d{3,4}p|pr[eé]f[eè]re|avec\s|sur\s)|[,;]/i;
const feedExpression6 = /\b(?:2160|1080|900|720|480)p\b/gi;
const feedExpression7 = /\b(?:VOSTFR|VF|MULTI)\b/gi;
const feedExpression8 = /tsundere(?:-raws)?/i;
const feedExpression9 = /nyaa(?:\.si)?/i;
const feedExpression10 = /c411/i;
const feedExpression11 = /\bsaison\s+(\d+)\b/i;

export function normalizeTitle(value: string) {
  return value
    .normalize("NFKD")
    .replace(feedExpression1, "")
    .toLocaleLowerCase("fr-FR")
    .replace(feedExpression2, " ")
    .trim();
}
export function interpretLocally(query: string, destinationId: string): AutomationDraft {
  const explicit = query.match(feedExpression3)?.[1];
  const title =
    explicit ?? query.replace(feedExpression4, "").split(feedExpression5)[0]?.trim() ?? query;
  const resolutions = [...new Set(query.match(feedExpression6) ?? [])].map((value) =>
    value.toLowerCase()
  );
  const languages = [...new Set(query.match(feedExpression7) ?? [])].map((value) =>
    value.toUpperCase()
  );
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
  const sources: SourcePluginId[] = listed.length ? listed : ["tsundere", "nyaa", "c411"];
  return {
    automatic: true,
    codecs: [],
    deleteReplacedFiles: false,
    destinationId,
    enabled: true,
    excludePacks: true,
    includeExisting: false,
    intervalMinutes: 15,
    languages,
    matchMode: "exact",
    paused: false,
    priority: ["language", "resolution", "source", "codec"],
    query,
    resolutions,
    season: Number(query.match(feedExpression11)?.[1]) || null,
    sources,
    title,
    waitMinutes: 0,
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
    return "Le titre ne correspond pas";
  }
  if (rule.excludePacks && release.pack) {
    return "Les packs sont exclus";
  }
  if (
    rule.afterEpisode !== undefined &&
    rule.afterEpisode > 0 &&
    (release.episode === null || release.episode <= rule.afterEpisode)
  ) {
    return "Épisode déjà regardé ou numéro inconnu";
  }
  if (rule.season !== null && release.season !== rule.season) {
    return "Saison différente ou inconnue";
  }
  if (rule.languages.length && !(release.language && rule.languages.includes(release.language))) {
    return "Langue non acceptée ou inconnue";
  }
  if (
    rule.resolutions.length &&
    !(release.resolution && rule.resolutions.includes(release.resolution))
  ) {
    return "Résolution non acceptée ou inconnue";
  }
  if (rule.codecs.length && !(release.codec && rule.codecs.includes(release.codec))) {
    return "Codec non accepté ou inconnu";
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
