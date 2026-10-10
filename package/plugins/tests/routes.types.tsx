import { defineRootRoute, defineRoute } from "@teyik0/furin";
import type { DashboardState, Destination, Settings, ThemePreference } from "../src/domain";
import type { PluginRouteContext } from "../src/routes";
import { createThreadLayout } from "../src/routes";

const root = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(() => ({ theme: "system" as ThemePreference }))
  .layout(({ children }) => children);

export function createExampleLayout(dashboard: DashboardState, thread: Destination) {
  const threadLayout = createThreadLayout(
    root,
    () => ({ dashboard, settings: dashboard.settings, thread }),
    ({ children, theme, dashboard: loadedDashboard, thread: loadedThread, settings }) => {
      const ancestorTheme: ThemePreference = theme;
      const currentDashboard: DashboardState = loadedDashboard;
      const currentThread: Destination | null = loadedThread;
      const currentSettings: Settings = settings;
      // @ts-expect-error Host layout fields retain their precise types.
      const wrongTheme: number = theme;
      void [ancestorTheme, currentDashboard, currentThread, currentSettings, wrongTheme];
      return children;
    }
  );
  const pluginContext: PluginRouteContext = { threadLayout };
  void pluginContext;
  return defineRoute()
    .config({ layout: threadLayout, mode: "ssr" })
    .loader(async ({ dashboard: inheritedDashboard, thread: inheritedThread, settings, theme }) => {
      const promisedDashboard: Promise<DashboardState> = inheritedDashboard;
      const promisedThread: Promise<Destination | null> = inheritedThread;
      const promisedSettings: Promise<Settings> = settings;
      const promisedTheme: Promise<ThemePreference> = theme;
      // @ts-expect-error Promised parent fields do not become unrelated types.
      const wrongThread: Promise<string> = inheritedThread;
      void [promisedDashboard, promisedThread, promisedSettings, promisedTheme, wrongThread];
      return { threadName: (await inheritedThread)?.name ?? "All threads" };
    })
    .head(({ threadName }) => ({ meta: [{ title: threadName }] }))
    .page(({ threadName }) => <div>{threadName}</div>);
}

/** The minimal public route context also retains promised thread/dashboard/settings. */
export function createPluginExample({ threadLayout }: PluginRouteContext) {
  return defineRoute()
    .config({ layout: threadLayout, mode: "ssr" })
    .loader(async ({ dashboard, thread, settings }) => {
      const promisedDashboard: Promise<DashboardState> = dashboard;
      const promisedThread: Promise<Destination | null> = thread;
      const promisedSettings: Promise<Settings> = settings;
      void [promisedDashboard, promisedThread, promisedSettings];
      return { threadName: (await thread)?.name ?? "All threads" };
    })
    .page(({ threadName }) => <div>{threadName}</div>);
}
