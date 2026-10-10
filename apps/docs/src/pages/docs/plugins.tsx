import { defineRoute } from "@teyik0/furin";
import { Callout, Code, DocTitle } from "../../components/docs";
import { route as docs } from "./_route";

export const route = defineRoute()
  .config({ layout: docs, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Build a plugin — Tofu" }] }))
  .page(() => (
    <>
      <DocTitle
        description="Add a thread action, a custom page, or a connection to something you love. Keep the host doing the heavy lifting."
        label="Experimental SDK · 0.0.0"
        title="A space for your ideas."
      />
      <Callout>
        <p>
          This SDK is an experimental local workspace package. The commands below use this checkout,
          not a published package. API compatibility and native page compilation can change.
        </p>
      </Callout>
      <h2>Create your plugin</h2>
      <p>From the repository root, generate a new directory outside the workspace:</p>
      <Code>{`bun run apps/scaffolder/src/cli.ts ../my-plugin
cd ../my-plugin
bun install
bun run tscheck
bun run build
bun test
bun run dev`}</Code>
      <p>
        The scaffolder refuses existing destinations and never installs dependencies or executes
        package scripts for you. <code>--name my-plugin</code> sets a different ID.{" "}
        <code>--sdk</code> and <code>--furin</code> select compatible local SDK sources and a Furin
        archive; use <code>--help</code> for the exact options.
      </p>
      <p>
        The generated project contains a portable SDK snapshot in <code>.tofu-sdk</code>, the pinned
        Furin archive in <code>.tofu-vendor</code>, and a developer preview at{" "}
        <code>http://127.0.0.1:3000</code>. Its fixture dashboard is explicitly empty. It creates no
        torrent engine.
      </p>
      <h2>One definition, two entries</h2>
      <p>
        The server entry exports a factory receiving the host core. A single{" "}
        <code>definePlugin</code> holds the API, UI, settings, authentication declaration, and setup
        hook. Browser code lives in the client entry.
      </p>
      <Code>{`import { definePlugin } from "@tofu/plugins";
import type { PluginContext } from "@tofu/plugins";
import { createPluginApi } from "@tofu/plugins/server";
import type { PluginCore } from "@tofu/plugins/server";
import { Type } from "typebox";
import { ui } from "../client";

const schema = Type.Object({ greeting: Type.String() });
const settingsQuery = { id: "my-plugin.settings", scope: {} };

export function createAPI(core: PluginCore, context: PluginContext<typeof schema>) {
  const { settings } = context;
  return createPluginApi(context)
    .use(core)
    .get("/settings", {
      query: Type.Object({ threadId: Type.Optional(Type.String()) }),
      sync: settingsQuery,
    }, ({ query }) => settings.get(query.threadId))
    .patch("/settings", {
      body: Type.Partial(schema),
      query: Type.Object({ threadId: Type.Optional(Type.String()) }),
      sync: { invalidate: settingsQuery },
    }, ({ body, query }) => settings.update(body, query.threadId));
}

export function createPlugin(core: PluginCore) {
  return definePlugin({
    id: "my-plugin",
    name: "My plugin",
    version: "0.0.0",
    settings: { schema, defaults: { greeting: "Hello" } },
    api: (context: PluginContext<typeof schema>) => createAPI(core, context),
    ui,
  });
}`}</Code>
      <p>
        <code>PluginCore</code> describes the route-free host facade. <code>.use(core)</code>
        supplies typed capabilities without copying the host router into your API.
        <code>createPluginApi(context)</code> uses the host’s actual Furin Sync options. The GET
        declares a query identity; the PATCH explicitly invalidates that same identity so native
        Furin queries refresh after saving.
      </p>
      <h2>Add a native page</h2>
      <p>
        A page contribution is a route factory. The host injects its real <code>threadLayout</code>,
        including the shell and the current thread data. Import <code>defineRoute</code> directly
        from Furin so its compiler recognizes the route.
      </p>
      <Code>{`import { defineRoute } from "@teyik0/furin";
import type { PluginRouteContext } from "@tofu/plugins/routes";

function createPage({ threadLayout }: PluginRouteContext) {
  return defineRoute()
    .config({ layout: threadLayout, mode: "ssr" })
    .loader(async ({ thread, dashboard, settings }) => {
      const [currentThread, state, preferences] = await Promise.all([
        thread, dashboard, settings,
      ]);
      return {
        title: currentThread?.name ?? "All threads",
        count: state.destinations.length,
        downloadPath: preferences.downloadPath,
      };
    })
    .page(({ title, count }) => <h1>{title}: {count} threads</h1>);
}

export const ui = {
  pages: [{
    id: "greeting", title: "Greeting", path: "greeting",
    pinnable: true, route: createPage,
  }],
} as const;`}</Code>
      <p>
        The loader fields are promises of the parent data; resolve them before use. The public
        layout type exposes <code>dashboard</code>, <code>settings</code>, and <code>thread</code>{" "}
        while keeping the host’s private render props out of your plugin.
      </p>
      <p>
        Account or configuration pages can explicitly set <code>availableWhenDisabled: true</code>
        in their page contribution. This keeps that page accessible while active plugin features
        remain disabled. AniList uses this for connecting an account before enabling tracking.
      </p>
      <h2>Try it in Tofu</h2>
      <p>
        Build and test the generated project, then follow{" "}
        <a href="/docs/trust">Installation & trust</a> to install it into your development host. New
        pages require generated route adapters and a rebuild or restart.
      </p>
      <div className="doc-links">
        <a href="/docs/plugin-api">
          <strong>The plugin API →</strong>
          <span>Actions, settings, typed clients, auth, and lifecycle.</span>
        </a>
        <a href="/docs/anilist">
          <strong>Learn from AniList →</strong>
          <span>The official plugin uses the same contracts.</span>
        </a>
      </div>
    </>
  ));
