import { usePluginHost } from "@tofu/plugins/client";

export function useRefresh() {
  return usePluginHost().refresh;
}

export function useSoundCue() {
  const host = usePluginHost();
  return (cue: "added") => host.playSound?.(cue);
}
