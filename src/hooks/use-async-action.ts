import { useRef, useState } from "react";
import { errorMessage } from "../lib/errors";

/** Runs one user action at a time, including calls before React commits the pending state. */
export function useAsyncAction(fallback: string) {
  const running = useRef<boolean>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (task: () => Promise<unknown>) => {
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(errorMessage(cause, fallback));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const action = (task: () => Promise<unknown>) => void run(task);
  return { action, busy, error, run, setError };
}

export type AsyncAction = ReturnType<typeof useAsyncAction>["action"];
