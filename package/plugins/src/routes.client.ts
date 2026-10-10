import { defineRoute } from "@teyik0/furin/client";
import type { ThreadLayoutRender, ThreadLayoutRequest } from "./routes";
import type { ThreadLayoutContext } from "./ui";

export type {
  PluginRouteContext,
  PluginRouteFactory,
  ThreadLayout,
  ThreadLayoutRender,
  ThreadLayoutRequest,
} from "./routes";

/** Browser route construction retains only the host render component. */
export function createThreadLayout<Parent>(
  parent: Parent,
  resolve: (context: ThreadLayoutRequest) => ThreadLayoutContext | Promise<ThreadLayoutContext>,
  render: ThreadLayoutRender<Parent>
) {
  void parent;
  void resolve;
  return defineRoute().layout(render);
}
