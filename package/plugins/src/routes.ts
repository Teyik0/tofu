import type { ThreadLayoutContext } from "./ui";

export interface ThreadLayoutRequest {
  path: string;
}
type ThreadLayoutData = { [Key in keyof ThreadLayoutContext]: ThreadLayoutContext[Key] };
export interface ThreadLayout {
  __type: "FURIN_ROUTE";
  mode: "ssr";
}
type PublicThreadLayout = ThreadLayout & {
  loader: (...args: never[]) => ThreadLayoutData | Promise<ThreadLayoutData>;
};

// Furin resolves runtime paths from the host tree; this key supplies the portable parent data.
declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/__tofu_plugin": {
      kind: "page";
      parent: PublicThreadLayout;
      pathParams: Record<never, never>;
    };
  }
}

export interface PluginRouteContext {
  threadLayout: ThreadLayout;
}
export type PluginRouteFactory<Route> = (context: PluginRouteContext) => Route;
