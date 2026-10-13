import { defineRoute } from "@teyik0/furin";
import { Callout, Code, DocTitle } from "../../components/docs";
import { route as docs } from "./_route";

export const route = defineRoute()
  .config({ layout: docs, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Installation & trust — Tofu" }] }))
  .page(() => (
    <>
      <DocTitle
        description="Review the source, grant trust explicitly, and compile it into your development host."
        label="Local installation"
        title="Know what you invite in."
      />
      <h2>Trusted code in your app</h2>
      <p>
        Plugins run in the host process and use the same React, Furin, and SDK instances. They are
        trusted code with the host’s filesystem and network access. There is no iframe, sandbox, or
        separate plugin process.
      </p>
      <p>
        This gives plugin pages normal native routing, inherited loaders, and a shared interface.
        Process isolation would require a different capability and UI bridge; it is not part of this
        experimental SDK.
      </p>
      <h2>Package metadata</h2>
      <p>
        Your ESM package declares its plugin ID, compatibility version, compiled server entry, and
        source client entry:
      </p>
      <Code>{`{
  "name": "tofu-plugin-my-plugin",
  "version": "0.0.0",
  "type": "module",
  "tofuPlugin": {
    "id": "my-plugin",
    "apiVersion": "0.0.0",
    "server": "./dist/server/index.js",
    "client": "./src/client/index.tsx"
  }
}`}</Code>
      <p>
        <code>inspectPluginPackage</code> validates metadata and entry paths, checks API
        compatibility, rejects escaping paths and symlinks, and computes a SHA-256 integrity value.
        Inspection only reads package files. It does not import the plugin, install dependencies, or
        run scripts.
      </p>
      <Callout>
        <p>
          Integrity pins the reviewed package contents; it does not prove the code is safe. Review
          the code and dependencies before granting trust.
        </p>
      </Callout>
      <h2>Install into a source host</h2>
      <p>Build and test your plugin first. From the Tofu repository root:</p>
      <Code>{`bun run plugin:install ../my-plugin --trust
bun run dev

# Or rebuild the native app
bun run build:desktop
bun run desktop`}</Code>
      <p>
        The explicit <code>--trust</code> option authorizes loading the reviewed local package. The
        host copies it into the ignored <code>.tofu-plugins</code> cache and records its integrity.
        Installation does not execute package scripts. The shared host dependencies remain linked to
        the host.
      </p>
      <p>
        Trusted local plugins start enabled after installation. Manage their enablement in{" "}
        <strong>Plugins</strong>. Their custom page is mounted under{" "}
        <code>/extensions/&lt;plugin-id&gt;/&lt;page-id&gt;</code>. The host controls that path and
        supplies its thread layout.
      </p>
      <h2>Pages need compilation</h2>
      <p>
        The pinned Furin preview compiles a fixed route graph. The host generates normal physical
        page adapters from plugin route factories before development or builds. Restart the
        development server or rebuild the native app after adding or removing page contributions.
      </p>
      <Code>{`# Regenerate native route adapters explicitly
bun run plugin:generate

# Remove the installed package from the host registry
bun run plugin:uninstall my-plugin`}</Code>
      <p>
        Disabling a plugin removes its active API and UI contributions and cleans up its lifecycle
        scope. Uninstalling removes the registration. These operations do not delete downloaded
        data.
      </p>
      <h2>Current limits</h2>
      <ul>
        <li>No plugin marketplace or published stable SDK distribution.</li>
        <li>
          No arbitrary browser route loading after installation; source factories must remain
          available for compilation.
        </li>
        <li>No isolation boundary between trusted plugins and the host.</li>
        <li>
          Generic auth declarations need a compatible host adapter; credentials remain private to
          Bun.
        </li>
      </ul>
    </>
  ));
