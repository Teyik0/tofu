import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { AniListCatalogFilters } from "../api/modules/anilist/catalog";
import type { AniListCatalog } from "../api/modules/anilist/service";
import type { AniListCatalogOptions } from "../api/modules/anilist/types";
import { request } from "../components/api";
import { errorMessage } from "../lib/errors";

export function useAniListCatalog(browsing: boolean, filters: AniListCatalogFilters) {
  const [catalogReload, setCatalogReload] = useState(0);
  const [catalog, setCatalog] = useState<{ key: string; data: AniListCatalog } | null>(null);
  const [catalogError, setCatalogError] = useState<{ key: string; message: string } | null>(null);
  const [catalogOptions, setCatalogOptions] = useState<AniListCatalogOptions | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const catalogEnd = useRef<HTMLDivElement>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const catalogSearch = filters.search ?? "";
  const requestedSearch = useRef(catalogSearch);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const options = await request<AniListCatalogOptions>(
          "/anilist/catalog/options",
          "GET",
          undefined,
          controller.signal
        );
        if (!controller.signal.aborted) {
          setCatalogOptions(options);
        }
      } catch {
        // Catalog browsing remains available when filter suggestions cannot load.
      }
    };
    void load();
    return () => controller.abort();
  }, []);
  const catalogBody = JSON.stringify(filters);
  const catalogKey = `${catalogReload}:${catalogBody}`;
  const currentCatalog = catalog?.key === catalogKey ? catalog.data : null;
  const currentCatalogError =
    browsing && catalogError?.key === catalogKey ? catalogError.message : null;
  const loadingCatalog = browsing && !currentCatalog && !currentCatalogError;
  useEffect(() => {
    setLoadingMore(false);
    if (!browsing) {
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      requestedSearch.current = catalogSearch;
      try {
        const data = await request<AniListCatalog>(
          "/anilist/catalog",
          "POST",
          JSON.parse(catalogBody) as AniListCatalogFilters,
          controller.signal
        );
        if (!controller.signal.aborted) {
          setCatalog({ data, key: catalogKey });
          setCatalogError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setCatalogError({
            key: catalogKey,
            message: errorMessage(cause, "Unable to load anime catalog"),
          });
        }
      }
    };
    const timer =
      catalogSearch === requestedSearch.current ? null : setTimeout(() => void load(), 250);
    if (timer === null) {
      void load();
    }
    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      controller.abort();
      catalogRequest.current?.abort();
      catalogRequest.current = null;
    };
  }, [browsing, catalogKey, catalogBody, catalogSearch]);
  const loadMore = async () => {
    if (!(browsing && currentCatalog?.hasNextPage) || catalogRequest.current) {
      return;
    }
    const controller = new AbortController();
    catalogRequest.current = controller;
    setLoadingMore(true);
    try {
      const data = await request<AniListCatalog>(
        "/anilist/catalog",
        "POST",
        {
          ...(JSON.parse(catalogBody) as AniListCatalogFilters),
          page: currentCatalog.page + 1,
        },
        controller.signal
      );
      if (controller.signal.aborted) {
        return;
      }
      setCatalog((previous) =>
        previous?.key === catalogKey
          ? {
              data: {
                ...data,
                media: [
                  ...new Map(
                    [...previous.data.media, ...data.media].map((media) => [media.mediaId, media])
                  ).values(),
                ],
              },
              key: catalogKey,
            }
          : previous
      );
      setCatalogError(null);
    } catch (cause) {
      if (controller.signal.aborted) {
        return;
      }
      setCatalogError({
        key: catalogKey,
        message: errorMessage(cause, "Unable to load more anime"),
      });
    } finally {
      if (catalogRequest.current === controller) {
        catalogRequest.current = null;
        setLoadingMore(false);
      }
    }
  };
  const loadNextPage = useEffectEvent(loadMore);
  const catalogPage = currentCatalog?.page;
  const hasNextPage = currentCatalog?.hasNextPage;
  useEffect(() => {
    const sentinel = catalogEnd.current;
    if (
      !(browsing && hasNextPage) ||
      catalogPage === undefined ||
      loadingMore ||
      currentCatalogError ||
      !sentinel
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observations) => {
        if (observations.some((observation) => observation.isIntersecting)) {
          void loadNextPage();
        }
      },
      { rootMargin: "300px 0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [browsing, hasNextPage, loadingMore, currentCatalogError, catalogPage]);

  return {
    data: currentCatalog,
    end: catalogEnd,
    error: currentCatalogError,
    loading: loadingCatalog,
    loadingMore,
    loadMore,
    options: catalogOptions,
    reload: () => setCatalogReload((value) => value + 1),
  };
}
