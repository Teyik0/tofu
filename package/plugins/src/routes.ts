import { defineRoute } from "@teyik0/furin";
import type { ThreadLayoutContext } from "./ui";

export interface ThreadLayoutRequest {
  path: string;
  request: Request;
}

function configureThreadLayout<Parent>(
  parent: Parent,
  resolve: (context: ThreadLayoutRequest) => ThreadLayoutContext | Promise<ThreadLayoutContext>
) {
  return defineRoute()
    .config({ layout: parent, mode: "ssr" })
    .loader(async (context) => {
      const { dashboard, settings, thread } = await resolve(context);
      return { dashboard, settings, thread };
    });
}

export type ThreadLayoutRender<Parent> = Parameters<
  ReturnType<typeof configureThreadLayout<Parent>>["layout"]
>[0];

/** The host supplies its real parent document route, loader and shell. */
export function createThreadLayout<Parent>(
  parent: Parent,
  resolve: (context: ThreadLayoutRequest) => ThreadLayoutContext | Promise<ThreadLayoutContext>,
  render: ThreadLayoutRender<Parent>
) {
  return configureThreadLayout(parent, resolve).layout(render);
}

/** Public data contract hides the host's private shell props and ancestor fields. */
type ThreadLayoutData = { [Key in keyof ThreadLayoutContext]: ThreadLayoutContext[Key] };

export type ThreadLayout = Pick<ReturnType<typeof createThreadLayout>, "__type" | "mode"> & {
  loader: (...args: never[]) => ThreadLayoutData | Promise<ThreadLayoutData>;
};

/** A route factory receives a real host layout; Furin performs parent-data inference. */
export interface PluginRouteContext {
  threadLayout: ThreadLayout;
}

export type PluginRouteFactory<Route> = (context: PluginRouteContext) => Route;
