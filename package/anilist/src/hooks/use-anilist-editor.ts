import { usePluginHost } from "@tofu/plugins/client";
import type { AniListEditor } from "@tofu/plugins/domain";
import { errorMessage } from "@tofu/ui/errors";
import { useEffect, useState } from "react";
import { request } from "../request";

export function useAniListEditor(authenticated: boolean, mediaId: number) {
  const { refresh } = usePluginHost();
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
