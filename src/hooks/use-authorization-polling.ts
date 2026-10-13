import { useEffect, useEffectEvent, useState } from "react";

function pollUntilStopped(check: () => Promise<void>) {
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    await check();
    if (active) {
      timer = setTimeout(poll, 1000);
    }
  };
  timer = setTimeout(poll, 1000);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

export function useAuthorizationPolling(enabled: boolean, reload: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const poll = useEffectEvent(async () => {
    try {
      await reload();
      setError(null);
    } catch {
      setError("Unable to check the connection. Return to Tofu and try again.");
    }
  });
  useEffect(() => {
    if (enabled) {
      return pollUntilStopped(poll);
    }
  }, [enabled]);
  return enabled ? error : null;
}
