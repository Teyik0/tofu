import { useEffect, useRef, useState } from "react";

interface ResourceHints extends Navigator {
  connection?: { saveData?: boolean };
  deviceMemory?: number;
}

export function Swarm() {
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const element = container.current;
    const hints = navigator as ResourceHints;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (
      !element ||
      motion.matches ||
      hints.connection?.saveData ||
      (hints.deviceMemory !== undefined && hints.deviceMemory <= 2)
    ) {
      return;
    }
    let cancelled = false;
    let dispose: (() => void) | undefined;
    import("./swarm-scene")
      .then(({ createSwarmScene }) => {
        if (cancelled) {
          return;
        }
        try {
          dispose = createSwarmScene(element, () => setReady(false));
          setReady(true);
        } catch {
          setReady(false);
        }
      })
      .catch(() => setReady(false));
    const reduceMotion = () => {
      if (motion.matches) {
        cancelled = true;
        dispose?.();
        dispose = undefined;
        setReady(false);
      }
    };
    motion.addEventListener("change", reduceMotion);
    return () => {
      cancelled = true;
      motion.removeEventListener("change", reduceMotion);
      dispose?.();
    };
  }, []);

  return (
    <div aria-hidden="true" className={ready ? "swarm swarm-ready" : "swarm"}>
      <div className="swarm-fallback">
        <div className="fallback-orbit" />
        <div className="fallback-orbit second" />
        <div className="fallback-cube">
          <span />
          <span />
          <span />
        </div>
        <i className="peer peer-one" />
        <i className="peer peer-two" />
        <i className="peer peer-three" />
      </div>
      <div className="swarm-canvas" ref={container} />
    </div>
  );
}
