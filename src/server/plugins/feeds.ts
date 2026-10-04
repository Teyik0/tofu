import type { FeedRelease, SourcePluginId } from "../../types";

const feedExpression1 = /^([\d.]+)\s*(Bytes|B|KiB|MiB|GiB|TiB|KB|MB|GB)$/i;
const feedExpression2 = /\bS(\d{1,3})E(\d{1,4})\b/i;
const feedExpression3 = /\s-\s(\d{1,4})(?:\s|\b)/;
const feedExpression4 = /\b(2160|1080|900|720|480)p\b/i;
const feedExpression5 = /\b(VOSTFR|SUBFRENCH)\b/i;
const feedExpression6 = /\bMULTI\b/i;
const feedExpression7 = /\b(VF|FRENCH|TRUEFRENCH)\b/i;
const feedExpression8 = /\b(x265|h[ .]?265|HEVC)\b/i;
const feedExpression9 = /\b(x264|h[ .]?264|AVC)\b/i;
const feedExpression10 = /\bAV1\b/i;
const feedExpression11 = /^\[[^\]]+\]\s*/;
const feedExpression12 =
  /\s+S\d+E\d+\b|\s+-\s+\d+\b|\s+(?:VOSTFR|SUBFRENCH|MULTI|VF|FRENCH|TRUEFRENCH|\d{3,4}p)\b/i;
const feedExpression13 = /\b(batch|complete|complet|integrale|pack)\b/i;
const feedExpression14 = /\bS\d+E\d+\s*[-–]\s*(?:E)?\d+\b/i;
const feedExpression15 = /^(https?:\/\/|magnet:\?)/i;
const feedExpression16 = /^[a-f\d]{40}$/i;
const feedExpression17 = /&amp;/g;
const feedExpression18 = /&quot;/g;
const feedExpression19 = /&#(?:x([a-f\d]+)|(\d+));/gi;
const feedExpression20 = /&lt;/g;
const feedExpression21 = /&gt;/g;
const feedExpression22 = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const feedExpression23 = /<a\b([^>]+)>([\s\S]*?)<\/a>/gi;
const feedExpression24 = /href=["']\/?view\/\d+["']/;
const feedExpression25 = /class=["'][^"']*comments/;
const feedExpression26 = /href=["']([^"']+)["']/;
const feedExpression27 = /title=["']([^"']+)["']/;
const feedExpression28 = /<[^>]*>/g;
const feedExpression29 = /href=["']([^"']*\/download\/\d+\.torrent)["']/;

interface XmlAttribute {
  "@name"?: string;
  "@value"?: string;
}
interface RssItem {
  enclosure?: { "@url"?: string; "@length"?: string };
  guid?: string | { "#text"?: string };
  link?: string;
  "nyaa:infoHash"?: string;
  "nyaa:seeders"?: number | string;
  "nyaa:size"?: string;
  pubDate?: string;
  size?: string;
  title?: string;
  "torznab:attr"?: XmlAttribute | XmlAttribute[];
}
interface RssDocument {
  rss?: { channel?: { item?: RssItem | RssItem[] } | "" };
}
interface TsundereEntry {
  codec?: string;
  episode?: number;
  episodeRange?: unknown;
  id?: string;
  infohash?: string | null;
  language?: string;
  publishedAt?: string;
  quality?: string;
  season?: number;
  size?: number;
  title?: string;
  torrentUrl?: string | null;
  url?: string;
}
export function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function fileSize(value: string | undefined) {
  const match = value?.match(feedExpression1);
  if (!match) {
    return null;
  }
  const powers: Record<string, number> = {
    b: 0,
    bytes: 0,
    gb: 3,
    gib: 3,
    kb: 1,
    kib: 1,
    mb: 2,
    mib: 2,
    tib: 4,
  };
  const unit = match[2]?.toLowerCase() ?? "";
  const power = powers[unit];
  return power === undefined
    ? null
    : Number(match[1]) * (unit.includes("i") ? 1024 : 1000) ** power;
}
export function releaseMetadata(title: string) {
  const seasonEpisode = title.match(feedExpression2);
  const episode = seasonEpisode?.[2] ?? title.match(feedExpression3)?.[1];
  const resolution = title.match(feedExpression4)?.[0].toLowerCase() ?? null;
  const language = detectLanguage(title);
  const codec = detectCodec(title);
  const workTitle = title.replace(feedExpression11, "").split(feedExpression12)[0]?.trim() ?? title;
  return {
    codec,
    episode: numberOrNull(episode),
    language,
    pack: feedExpression13.test(title) || feedExpression14.test(title),
    resolution,
    season: numberOrNull(seasonEpisode?.[1]),
    workTitle,
  } satisfies Partial<FeedRelease>;
}
function validDownload(value: unknown): value is string {
  return typeof value === "string" && feedExpression15.test(value);
}
function hash(value: unknown) {
  return typeof value === "string" && feedExpression16.test(value) ? value.toLowerCase() : null;
}
function date(value: string | undefined) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseRss(body: string, sourceId: SourcePluginId): FeedRelease[] {
  if (body.length > 8 * 1024 * 1024) {
    throw new Error("Invalid RSS feed");
  }
  let document: RssDocument;
  try {
    document = Bun.XML.parse(body) as RssDocument;
  } catch (cause) {
    throw new Error("Invalid RSS feed", { cause });
  }
  if (document.rss?.channel === undefined) {
    throw new Error("RSS feed missing");
  }
  if (document.rss.channel === "") {
    return [];
  }
  const items = document.rss.channel.item;
  return asArray(items).flatMap((item) => {
    const downloadUrl = item.enclosure?.["@url"] ?? item.link;
    if (typeof item.title !== "string" || !validDownload(downloadUrl)) {
      return [];
    }
    const attributes = asArray(item["torznab:attr"]);
    const attribute = (name: string) =>
      attributes.find((entry) => entry["@name"] === name)?.["@value"];
    const guid = typeof item.guid === "string" ? item.guid : item.guid?.["#text"];
    return [
      {
        ...releaseMetadata(item.title),
        downloadUrl,
        id:
          sourceId === "c411"
            ? Bun.SHA256.hash(String(guid ?? downloadUrl), "hex")
            : String(guid ?? downloadUrl),
        infoHash: hash(item["nyaa:infoHash"] ?? attribute("infohash")),
        pageUrl: guid?.startsWith("http") ? guid : null,
        publishedAt: date(item.pubDate),
        seeders: numberOrNull(item["nyaa:seeders"] ?? attribute("seeders")),
        size: numberOrNull(item.size ?? item.enclosure?.["@length"]) ?? fileSize(item["nyaa:size"]),
        sourceId,
        title: item.title,
      },
    ];
  });
}
export function parseTsundere(body: string): FeedRelease[] {
  const document = JSON.parse(body) as { entries?: TsundereEntry[] };
  if (!Array.isArray(document.entries)) {
    throw new Error("Invalid JSON feed");
  }
  return document.entries.flatMap((entry) => {
    if (typeof entry.title !== "string" || !validDownload(entry.torrentUrl)) {
      return [];
    }
    const metadata = releaseMetadata(entry.title);
    const languages: Record<string, FeedRelease["language"]> = {
      FRENCH: "VF",
      MULTI: "MULTI",
      MULTi: "MULTI",
      SUBFRENCH: "VOSTFR",
    };
    return [
      {
        ...metadata,
        codec: entry.codec ?? metadata.codec,
        downloadUrl: entry.torrentUrl,
        episode: numberOrNull(entry.episode) ?? metadata.episode,
        id: String(entry.id ?? entry.torrentUrl),
        infoHash: hash(entry.infohash),
        language: languages[entry.language ?? ""] ?? metadata.language,
        pack: Boolean(entry.episodeRange) || metadata.pack,
        pageUrl: validDownload(entry.url) ? entry.url : null,
        publishedAt: date(entry.publishedAt),
        resolution: entry.quality ?? metadata.resolution,
        season: numberOrNull(entry.season) ?? metadata.season,
        seeders: null,
        size: numberOrNull(entry.size),
        sourceId: "tsundere" as const,
        title: entry.title,
      },
    ];
  });
}
function asArray<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value !== undefined) {
    return [value];
  }
  return [];
}
function detectLanguage(title: string): FeedRelease["language"] {
  if (feedExpression5.test(title)) {
    return "VOSTFR";
  }
  if (feedExpression6.test(title)) {
    return "MULTI";
  }
  if (feedExpression7.test(title)) {
    return "VF";
  }
  return null;
}
function detectCodec(title: string) {
  if (feedExpression8.test(title)) {
    return "H.265";
  }
  if (feedExpression9.test(title)) {
    return "H.264";
  }
  if (feedExpression10.test(title)) {
    return "AV1";
  }
  return null;
}

function decodeHtml(value: string) {
  return value
    .replace(feedExpression17, "&")
    .replace(feedExpression18, '"')
    .replace(feedExpression19, (_match, hex: string | undefined, decimal: string | undefined) =>
      String.fromCodePoint(
        Math.min(0x10_ff_ff, Number.parseInt(hex ?? decimal ?? "0", hex ? 16 : 10))
      )
    )
    .replace(feedExpression20, "<")
    .replace(feedExpression21, ">");
}
export function parseNyaaHtml(body: string, base: string): FeedRelease[] {
  return [...body.matchAll(feedExpression22)].flatMap((row) => {
    const text = row[1] ?? "";
    const anchor = [...text.matchAll(feedExpression23)].find(
      (match) => feedExpression24.test(match[1] ?? "") && !feedExpression25.test(match[1] ?? "")
    );
    const href = anchor?.[1]?.match(feedExpression26)?.[1];
    const name =
      anchor?.[1]?.match(feedExpression27)?.[1] ?? anchor?.[2]?.replace(feedExpression28, "");
    const download = text.match(feedExpression29)?.[1];
    if (!(href && name && download)) {
      return [];
    }
    const title = decodeHtml(name).trim();
    return [
      {
        ...releaseMetadata(title),
        downloadUrl: new URL(download, base).href,
        id: new URL(href, base).href,
        infoHash: null,
        pageUrl: new URL(href, base).href,
        publishedAt: null,
        seeders: null,
        size: null,
        sourceId: "nyaa" as const,
        title,
      },
    ];
  });
}
