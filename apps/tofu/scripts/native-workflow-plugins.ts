// biome-ignore-all lint/style/noNonNullAssertion: Missing native UI targets must fail the smoke test.
// biome-ignore-all lint/performance/noAwaitInLoops: Native interactions must settle before continuing.
import {
  collectNativeErrors,
  createNativeCheck,
  createNativeWait,
  nativeClick,
  nativeSetInput,
} from "./native-browser";
export async function pluginsWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const { errors } = collectNativeErrors("all");
  const nativeFetch = window.fetch;
  let started = false;
  const release = Promise.withResolvers<void>();
  let rejectConfiguration = false;
  let rejectionStarted = false;
  const rejection = Promise.withResolvers<void>();
  let keySaveStarted = false;
  let rejectKey = false;
  const keySave = Promise.withResolvers<void>();
  let connectionStarted = false;
  const connection = Promise.withResolvers<void>();
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    if (url.pathname === "/api/plugins/nyaa" && init?.method === "PUT") {
      started = true;
      await release.promise;
    }
    if (url.pathname === "/api/plugins/tsundere" && init?.method === "PUT" && rejectConfiguration) {
      rejectionStarted = true;
      await rejection.promise;
      return nativeFetch(input, {
        ...init,
        body: JSON.stringify({ ...JSON.parse(String(init.body)), dailyLimit: 0 }),
      });
    }
    if (url.pathname === "/api/plugins/jev/connect" && init?.method === "POST") {
      keySaveStarted = true;
      await keySave.promise;
      if (rejectKey) {
        return Response.json(
          {
            detail: "TypeSafe rejected this API key. Generate a new key and try again.",
            status: 400,
            title: "Bad Request",
            type: "about:blank",
          },
          { status: 400 }
        );
      }
      return nativeFetch("/api/plugins/jev", { ...init, method: "PUT" });
    }
    if (url.pathname === "/api/plugins/nyaa/test" && init?.method === "POST") {
      connectionStarted = true;
      await connection.promise;
    }
    return nativeFetch(input, init);
  }, nativeFetch);
  const wait = createNativeWait({ interval: 30, timeout: 15_000 });
  const check = createNativeCheck(checks, null);
  const state = async () =>
    (await (await nativeFetch("/api/automation")).json()) as import("../src/types").AutomationState;
  const toggle = (id: string) => document.querySelector<HTMLButtonElement>(`#plugin-${id}`)!;
  const click = nativeClick;
  const set = (selector: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    nativeSetInput(input, value);
  };
  try {
    if (location.pathname !== "/plugins") {
      await wait(
        () => document.querySelector<HTMLButtonElement>(".add-button")?.disabled === false
      );
      document.querySelector<HTMLButtonElement>('button[aria-label="Plugins"]')!.click();
    }
    await wait(() => location.pathname === "/plugins" && !!document.querySelector("#plugin-nyaa"));
    check(
      "C411 and TypeSafe credential links open a new browser tab",
      ["https://c411.org/user/integrations", "https://console.typesafe.ai/keys"].every((url) => {
        const link = document.querySelector<HTMLAnchorElement>(`a[href="${url}"]`);
        return (
          link?.target === "_blank" &&
          link.relList.contains("noopener") &&
          link.relList.contains("noreferrer")
        );
      })
    );
    toggle("nyaa").click();
    await wait(() => started);
    await wait(
      () =>
        toggle("nyaa").getAttribute("aria-checked") === "true" &&
        toggle("nyaa").closest("article")?.querySelector('[data-slot="badge"]')?.textContent ===
          "Enabled"
    );
    check(
      "Enabling a plugin updates its switch and badge before the request completes",
      toggle("nyaa").getAttribute("aria-checked") === "true" &&
        toggle("nyaa").closest("article")!.querySelector('[data-slot="badge"]')?.textContent ===
          "Enabled" &&
        (await state()).plugins.find((plugin) => plugin.id === "nyaa")?.enabled === false
    );
    check("An in-flight plugin does not disable another plugin", !toggle("tsundere").disabled);
    toggle("tsundere").click();
    await wait(async () =>
      (await state()).plugins.some((plugin) => plugin.id === "tsundere" && plugin.enabled)
    );
    check(
      "Another plugin saves before the previous request completes",
      (await state()).plugins.some((plugin) => plugin.id === "tsundere" && plugin.enabled) &&
        (await state()).plugins.some((plugin) => plugin.id === "nyaa" && !plugin.enabled)
    );
    release.resolve();
    await wait(() => !(toggle("nyaa").disabled || toggle("tsundere").disabled));
    check(
      "Concurrent plugin writes converge to their confirmed states",
      toggle("nyaa").getAttribute("aria-checked") === "true" &&
        toggle("tsundere").getAttribute("aria-checked") === "true"
    );
    rejectConfiguration = true;
    toggle("tsundere").click();
    await wait(() => rejectionStarted);
    check(
      "A pending disable is optimistic and leaves other plugins usable",
      toggle("tsundere").getAttribute("aria-checked") === "false" &&
        !toggle("nyaa").disabled &&
        (await state()).plugins.some((plugin) => plugin.id === "tsundere" && plugin.enabled)
    );
    rejection.resolve();
    await wait(() => !!toggle("tsundere").closest("article")!.querySelector('[role="alert"]'));
    check(
      "An API rejection restores the confirmed switch and keeps its error on its own card",
      toggle("tsundere").getAttribute("aria-checked") === "true" &&
        !toggle("nyaa").closest("article")!.querySelector('[role="alert"]')
    );
    rejectConfiguration = false;
    toggle("tsundere").click();
    await wait(() => !toggle("tsundere").disabled);
    check(
      "Retrying a rejected action saves and clears its error",
      toggle("tsundere").getAttribute("aria-checked") === "false" &&
        !toggle("tsundere").closest("article")!.querySelector('[role="alert"]')
    );
    toggle("jev").click();
    await wait(() => document.querySelector("#key-jev")?.getAttribute("aria-invalid") === "true");
    check(
      "Missing credentials focus the key field without starting a mutation",
      document.activeElement?.id === "key-jev" &&
        !keySaveStarted &&
        toggle("jev").getAttribute("aria-checked") === "false"
    );
    set("#key-jev", "submitted-native-key");
    set("#jev-daily-limit", "0");
    document.querySelector<HTMLFormElement>("#plugin-form-jev")!.requestSubmit();
    await wait(
      () => document.querySelector("#jev-daily-limit")?.getAttribute("aria-invalid") === "true"
    );
    check(
      "Invalid limits stay in the form without sending a configuration request",
      !keySaveStarted &&
        document.querySelector<HTMLInputElement>("#key-jev")!.value === "submitted-native-key"
    );
    set("#jev-daily-limit", "42");
    await wait(
      () =>
        toggle("jev").closest("article")!.querySelector<HTMLButtonElement>(".plugins-save")
          ?.disabled === false
    );
    document.querySelector<HTMLFormElement>("#plugin-form-jev")!.requestSubmit();
    await wait(() => keySaveStarted);
    click("Intelligence");
    await wait(
      () => location.pathname === "/plugins/intelligence" && !!document.querySelector("#key-jev")
    );
    check(
      "Section navigation remains available during a save and preserves its draft",
      document.querySelector<HTMLInputElement>("#key-jev")!.value === "submitted-native-key" &&
        document.querySelector<HTMLInputElement>("#jev-daily-limit")!.value === "42"
    );
    set("#key-jev", "new-unsaved-native-key");
    set("#jev-daily-limit", "43");
    keySave.resolve();
    await wait(async () =>
      (await state()).plugins.some((plugin) => plugin.id === "jev" && plugin.hasApiKey)
    );
    await wait(
      () =>
        document.querySelector<HTMLInputElement>("#key-jev")?.placeholder ===
        "Saved · type to replace"
    );
    check(
      "A completed save keeps credentials edited after navigating away",
      document.querySelector<HTMLInputElement>("#key-jev")!.value === "new-unsaved-native-key"
    );
    check(
      "A completed save keeps limits edited while the submitted limit reaches the API",
      document.querySelector<HTMLInputElement>("#jev-daily-limit")!.value === "43" &&
        (await state()).plugins.find((plugin) => plugin.id === "jev")?.dailyLimit === 42
    );
    click("Sources");
    await wait(
      () => location.pathname === "/plugins/sources" && !!document.querySelector("#plugin-nyaa")
    );
    const previousCheck = toggle("nyaa")
      .closest("article")!
      .querySelector(".automation-caption")?.textContent;
    const previousCheckedAt = (await state()).plugins.find(
      (plugin) => plugin.id === "nyaa"
    )?.checkedAt;
    toggle("nyaa")
      .closest("article")!
      .querySelector<HTMLButtonElement>(".plugins-plugin-actions button")!
      .click();
    await wait(() => connectionStarted);
    check(
      "A connection test keeps other plugins usable and does not invent a check timestamp",
      !toggle("tsundere").disabled &&
        toggle("nyaa").closest("article")!.querySelector(".automation-caption")?.textContent ===
          previousCheck
    );
    toggle("tsundere").click();
    await wait(async () =>
      (await state()).plugins.some((plugin) => plugin.id === "tsundere" && plugin.enabled)
    );
    connection.resolve();
    const connectionConfirmed = async () => {
      const plugin = (await state()).plugins.find((item) => item.id === "nyaa");
      return (
        plugin?.checkedAt !== null &&
        plugin?.checkedAt !== undefined &&
        plugin.checkedAt !== previousCheckedAt &&
        toggle("nyaa")
          .closest("article")!
          .querySelector(".automation-caption")
          ?.textContent?.includes(new Date(plugin.checkedAt).toLocaleTimeString("en-US")) === true
      );
    };
    await wait(connectionConfirmed);
    check("Connection results are shown after the API confirms them", await connectionConfirmed());
    click("Intelligence");
    await wait(
      () => location.pathname === "/plugins/intelligence" && !!document.querySelector("#key-jev")
    );
    check(
      "Unsaved credentials survive multiple section changes",
      document.querySelector<HTMLInputElement>("#key-jev")!.value === "new-unsaved-native-key"
    );
    document.querySelector<HTMLFormElement>("#plugin-form-jev")!.requestSubmit();
    await wait(() => document.querySelector<HTMLInputElement>("#key-jev")?.value === "");
    check(
      "A successful form action clears the submitted credential",
      document.querySelector<HTMLInputElement>("#key-jev")?.value === ""
    );
    check(
      "The next save persists the edited limit",
      (await state()).plugins.find((plugin) => plugin.id === "jev")?.dailyLimit === 43
    );
    rejectKey = true;
    set("#key-jev", "rejected-native-key");
    set("#jev-daily-limit", "44");
    document.querySelector<HTMLFormElement>("#plugin-form-jev")!.requestSubmit();
    await wait(() => document.querySelector("#key-jev")?.getAttribute("aria-invalid") === "true");
    check(
      "Rejected credentials show a readable error and preserve the draft and saved configuration",
      toggle("jev").closest("article")!.querySelector('[role="alert"]')?.textContent ===
        "TypeSafe rejected this API key. Generate a new key and try again." &&
        document.querySelector<HTMLInputElement>("#key-jev")?.value === "rejected-native-key" &&
        (await state()).plugins.find((plugin) => plugin.id === "jev")?.dailyLimit === 43
    );
    check("No JavaScript errors", errors.length === 0);
    await nativeFetch(config.reportUrl, {
      body: JSON.stringify({ checks, errors, passed: true }),
      method: "POST",
    });
  } catch (error) {
    await nativeFetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        errors,
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  } finally {
    release.resolve();
    rejection.resolve();
    keySave.resolve();
    connection.resolve();
    window.fetch = nativeFetch;
  }
}
