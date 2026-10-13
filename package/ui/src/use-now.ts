import { useEffect, useState } from "react";

/** Refreshes relative dates and countdowns while the view is mounted. */
export function useNow(interval: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}
