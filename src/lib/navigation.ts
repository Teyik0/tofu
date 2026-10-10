import { useRouter } from "@teyik0/furin/link";
import { useCallback } from "react";

type Router = ReturnType<typeof useRouter>;

export function isPreferencesPath(path: string) {
  return (
    path === "/options" ||
    path.startsWith("/options/") ||
    path === "/plugins" ||
    path.startsWith("/plugins/")
  );
}

export function destinationFromPath(path: string) {
  if (path === "/anilist") {
    return "anilist";
  }
  try {
    return path.startsWith("/thread/") ? decodeURIComponent(path.slice("/thread/".length)) : null;
  } catch {
    return null;
  }
}

export function isSupersededNavigation(cause: unknown) {
  return Boolean(
    cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError"
  );
}

async function ignoreSuperseded(task: Promise<void>) {
  try {
    await task;
  } catch (cause) {
    if (!isSupersededNavigation(cause)) {
      throw cause;
    }
  }
}

export function useRefresh() {
  const router = useRouter();
  return useCallback(() => ignoreSuperseded(router.refresh()), [router.refresh]);
}

export async function showDestination(
  router: Router,
  destinationId: string | null,
  activeDestination: string | null
) {
  if (destinationId && destinationId !== activeDestination) {
    await ignoreSuperseded(
      router.navigate({ params: { id: destinationId }, resetScroll: false, to: "/thread/:id" })
    );
  } else {
    await ignoreSuperseded(router.refresh());
  }
}

export function backToWorkspace(router: Router, path: string) {
  const destination = destinationFromPath(path);
  return ignoreSuperseded(
    path.startsWith("/thread/") && destination !== null
      ? router.navigate({
          params: { id: destination },
          resetScroll: false,
          to: "/thread/:id",
        })
      : router.navigate({ resetScroll: false, to: path === "/anilist" ? "/anilist" : "/" })
  );
}
