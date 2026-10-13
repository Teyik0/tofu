// biome-ignore-all lint/performance/noAwaitInLoops: Native UI interactions must settle before continuing.
export function createNativeWait(options: { timeout: number; interval: number }) {
  return async (ready: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + options.timeout;
    while (!(await ready())) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out: ${ready.toString()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, options.interval));
    }
  };
}

export function createNativeCheck(
  checks: { name: string; passed: boolean }[],
  progressUrl: string | null
) {
  return (name: string, passed: boolean) => {
    checks.push({ name, passed });
    if (progressUrl) {
      void fetch(progressUrl, { body: JSON.stringify({ name, passed }), method: "POST" });
    }
    if (!passed) {
      throw new Error(name);
    }
  };
}

export function nativeButton(label: string) {
  const button = Array.from(
    document.querySelectorAll<HTMLElement>('button, a, [role="menuitem"]')
  ).find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.trim() === label
  );
  if (!button) {
    throw new Error(`Action missing: ${label}`);
  }
  return button;
}

export function nativeClick(labelOrElement: string | HTMLElement) {
  const target = typeof labelOrElement === "string" ? nativeButton(labelOrElement) : labelOrElement;
  target.focus();
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  target.click();
}

export function nativeActivateOption(target: HTMLElement) {
  target.focus();
  target.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
  );
  target.dispatchEvent(
    new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter" })
  );
}

export async function nativeSelectOption(
  trigger: HTMLElement,
  label: string,
  wait: ReturnType<typeof createNativeWait>
) {
  trigger.focus();
  trigger.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })
  );
  trigger.dispatchEvent(
    new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "ArrowDown" })
  );
  const selector = '[data-slot="select-content"][data-open] [role="option"]';
  await wait(() => !!document.querySelector(selector));
  const option = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
    (item) => item.textContent?.trim() === label
  );
  if (!option) {
    throw new Error(`Option missing: ${label}`);
  }
  nativeActivateOption(option);
  await wait(() => trigger.getAttribute("aria-expanded") === "false");
}

export function nativeSetInput(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string
) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(
    element,
    value
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export function collectNativeErrors(mode: "all" | "exceptions" | "layout-aware") {
  const errors: string[] = [];
  const layoutWarnings: string[] = [];
  window.addEventListener("error", (event) => {
    if (mode === "exceptions" && !event.error) {
      return;
    }
    if (
      mode === "layout-aware" &&
      !event.error &&
      event.message === "ResizeObserver loop completed with undelivered notifications."
    ) {
      layoutWarnings.push(event.message);
    } else {
      errors.push(event.error ? String(event.error) : event.message);
    }
  });
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  return { errors, layoutWarnings };
}
