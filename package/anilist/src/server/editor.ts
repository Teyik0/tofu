import type { AniListEditor, AniListListEntry, AniListListUpdate } from "@tofu/plugins/domain";
import { HTTPError } from "elysia";
import { aniListScoreScales } from "../lib/anilist-score";
import type { AniListListEntryFragment, EditorQuery } from "./graphql/generated";
import { isAniListStatus } from "./service";

function jsonEntries(value: unknown): [string, unknown][] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
}

export function listEntry(entry: AniListListEntryFragment): AniListListEntry {
  if (!(isAniListStatus(entry.status) && entry.progress !== null)) {
    throw new (HTTPError.id("BAD_GATEWAY", 502))("Invalid AniList list entry");
  }
  return {
    ...entry,
    advancedScores: jsonEntries(entry.advancedScores).flatMap(([name, score]) =>
      typeof score === "number" ? [{ name, score }] : []
    ),
    customLists: Array.isArray(entry.customLists)
      ? entry.customLists.filter((name): name is string => typeof name === "string")
      : jsonEntries(entry.customLists).flatMap(([name, selected]) =>
          selected === true ? [name] : []
        ),
    progress: entry.progress,
    status: entry.status,
  };
}

export function editorState(result: EditorQuery, mediaId: number): AniListEditor {
  if (!result.Media || result.Media.id !== mediaId) {
    throw new (HTTPError.id("NOT_FOUND", 404))("Anime not found on AniList");
  }
  const options = result.Viewer?.mediaListOptions;
  return {
    entry: result.Media.mediaListEntry ? listEntry(result.Media.mediaListEntry) : null,
    isFavourite: typeof result.Media.isFavourite === "boolean" ? result.Media.isFavourite : null,
    isFavouriteBlocked:
      typeof result.Media.isFavouriteBlocked === "boolean" ? result.Media.isFavouriteBlocked : null,
    options: {
      advancedScoring: (options?.animeList?.advancedScoring ?? []).filter(
        (name): name is string => name !== null
      ),
      advancedScoringEnabled: options?.animeList?.advancedScoringEnabled ?? false,
      customLists: (options?.animeList?.customLists ?? []).filter(
        (name): name is string => name !== null
      ),
      scoreFormat: options?.scoreFormat ?? null,
    },
  };
}

export function validateEntryUpdate(
  body: AniListListUpdate,
  editor: AniListEditor,
  episodes: number | null
) {
  const { options } = editor;
  if (body.score !== undefined) {
    const scale = options.scoreFormat ? aniListScoreScales[options.scoreFormat] : null;
    if (
      !scale ||
      body.score > scale.max ||
      Math.abs(body.score / scale.step - Math.round(body.score / scale.step)) > 1e-8
    ) {
      throw new (HTTPError.id("BAD_REQUEST", 400))(
        "Score does not match your AniList scoring format"
      );
    }
  }
  if (body.progress !== undefined && episodes !== null && body.progress > episodes) {
    throw new (HTTPError.id("BAD_REQUEST", 400))("Progress exceeds the anime episode count");
  }
  const customLists = new Set(options.customLists);
  if (body.customLists?.some((name) => !customLists.has(name))) {
    throw new (HTTPError.id("BAD_REQUEST", 400))("Choose an existing AniList custom list");
  }
  if (
    body.advancedScores &&
    (!options.advancedScoringEnabled ||
      body.advancedScores.length !== options.advancedScoring.length)
  ) {
    throw new (HTTPError.id("BAD_REQUEST", 400))(
      "Advanced scores do not match your AniList settings"
    );
  }
}
