import { useEffect, useState } from "react";
import type { AniListEditor } from "../api/modules/anilist/editor";
import { request } from "../components/api";
import { errorMessage } from "../lib/errors";
import { useRefresh } from "../lib/navigation";

export function useAniListEditor(authenticated: boolean, mediaId: number) {
  const refresh = useRefresh();
  const [editor, setEditor] = useState<AniListEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(authenticated);
  const [version, setVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the editor.
  useEffect(() => {
    if (!authenticated) {
      setEditor(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void request<AniListEditor>(
      `/anilist/entries/${mediaId}/editor`,
      "GET",
      undefined,
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setEditor(value);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause, "Unable to load your AniList entry"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [authenticated, mediaId, version]);
  const reload = async () => {
    const updated = await request<AniListEditor>(
      `/anilist/entries/${mediaId}/editor`,
      "GET",
      undefined
    );
    setEditor(updated);
    await refresh();
    return updated;
  };

  return {
    editor,
    error,
    loading,
    reload,
    retry: () => setVersion((value) => value + 1),
    setEditor,
  };
}
