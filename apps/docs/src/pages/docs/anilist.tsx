import { defineRoute } from "@teyik0/furin";
import { Callout, DocTitle } from "../../components/docs";

export const route = defineRoute("/docs/anilist")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
  .page(() => (
    <>
      <DocTitle
        description="Your anime library, episode progress, and release automations. The official plugin also shows what the SDK can do."
        label="Official plugin"
        title="Keep up with your list."
      />
      <h2>Connect your library</h2>
      <p>
        Open AniList in the sidebar and choose <strong>Connect AniList</strong>. Authorize Tofu in
        your browser; the native callback returns you to the app. Watching and Plan to Watch appear
        by default. A public account name can load a public list without authorization, but
        watched-episode updates need a connected account.
      </p>
      <p>
        Open a cover to find releases, inspect real download progress, choose a thread, or mark an
        episode completed. Tofu preserves marks made out of order and writes consecutive progress to
        AniList.
      </p>
      <h2>Choose what can download</h2>
      <p>
        Select the titles you want to track and review their destination folders and preferences.
        You can use one thread per anime or a shared thread. Previewing makes no folders; titles
        need your validation before tracking starts.
      </p>
      <p>
        Unchecking a title pauses its Tofu rules without changing AniList or deleting downloads.
        Replacement files are deleted only when the explicit deletion option is enabled.
      </p>
      <h2>A real plugin, the same SDK</h2>
      <p>
        Its library declares <code>availableWhenDisabled: true</code>, so you can reach the account
        controls while tracking is disabled. The page stays accessible without enabling its
        background features.
      </p>
      <p>
        <code>package/anilist</code> exports <code>createAniListPlugin</code>. It uses one{" "}
        <code>definePlugin</code> with its Elysia API, native page contribution, custom
        authentication declaration, and lifecycle cleanup. Its route factory receives the same{" "}
        <code>threadLayout</code> as third-party plugins.
      </p>
      <p>
        The package owns its service, GraphQL operations, persistent cache, and Drizzle table. The
        host injects typed <code>AniListOptions</code>: database-backed automation operations,
        discovery, release scheduling and execution, engine access, and local episode availability.
        Core automation persists rules and decisions; <code>releaseAutomation</code> collects and
        executes releases. AniList state and rules share a database transaction. The package never
        imports the desktop app. Its client calls typed AniList and core Elysia APIs inside Tofu’s
        native shell.
      </p>
      <p>
        Shared DTOs come from <code>@tofu/plugins/domain</code>. The package also uses the SDK’s{" "}
        <code>/automation-rules</code>, <code>/title</code>, <code>/source-queries</code>,{" "}
        <code>/releases</code>, <code>/discovery-query</code>, and <code>/availability</code> entry
        points for release matching, query interpretation, and episode availability. This keeps
        common domain logic independent of desktop startup and routing.
      </p>
      <p>
        Its disposer suspends linked automations when the plugin’s scope ends. This makes the
        official plugin a working example of the lifecycle contract while preserving the existing
        service and persisted data.
      </p>
      <Callout>
        <p>
          AniList uses a custom adapter for its established implicit OAuth flow and
          authorization-code flow for a configured client with a secret. Release callbacks use{" "}
          <code>tofu://oauth/anilist</code>; development callbacks use{" "}
          <code>tofu-dev://oauth/anilist</code>. A generic OAuth 2 declaration is not a drop-in
          replacement for those provider semantics.
        </p>
      </Callout>
      <h2>Read the implementation</h2>
      <p>
        Start with <code>package/anilist/src/index.ts</code> for the definition and{" "}
        <code>src/ui.tsx</code> for the native page. The <code>src/server</code> directory contains
        its API and service boundaries; <code>src/components</code> contains the library and episode
        interface.
      </p>
      <p>
        See the <a href="/docs/plugin-api">plugin API guide</a> for the complete tracking and
        automation workflow.
      </p>
    </>
  ));
