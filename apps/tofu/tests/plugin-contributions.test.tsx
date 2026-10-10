import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadActionContext } from "@tofu/plugins/client";
import { createSettingsStore } from "@tofu/plugins/server";
import { SidebarProvider } from "@tofu/ui/sidebar";
import { renderToStaticMarkup } from "react-dom/server";
import { Type } from "typebox";
import {
  PluginContributionsProvider,
  PluginSidebarPages,
  PluginThreadActions,
  RegisteredPluginSettings,
  settingsFormPatch,
} from "../src/components/plugin-contributions";
import type { ExtensionState } from "../src/plugin-client";

test("the host sidebar shows only created pages belonging to enabled plugins", () => {
  const plugins: NonNullable<ExtensionState>["plugins"] = [
    {
      auth: null,
      enabled: true,
      error: null,
      id: "sample",
      name: "Sample",
      pages: [
        {
          available: true,
          created: true,
          id: "saved",
          path: "/extensions/sample/saved",
          pinnable: true,
          pinned: false,
          title: "Saved page",
        },
        {
          available: true,
          created: false,
          id: "new",
          path: "/extensions/sample/new",
          pinnable: true,
          pinned: false,
          title: "Uncreated page",
        },
        {
          available: true,
          created: true,
          id: "pinned",
          path: "/extensions/sample/pinned",
          pinnable: true,
          pinned: true,
          title: "Pinned page",
        },
      ],
      schema: null,
      settings: null,
    },
    {
      auth: null,
      enabled: false,
      error: null,
      id: "disabled",
      name: "Disabled",
      pages: [
        {
          available: false,
          created: true,
          id: "page",
          path: "/extensions/disabled/page",
          pinnable: true,
          pinned: false,
          title: "Disabled page",
        },
      ],
      schema: null,
      settings: null,
    },
  ];
  const html = renderToStaticMarkup(
    <PluginContributionsProvider
      initialState={{ plugins }}
      path="/extensions/sample/saved"
      registry={[]}
    >
      <SidebarProvider>
        <PluginSidebarPages pinned={false} />
      </SidebarProvider>
    </PluginContributionsProvider>
  );
  expect(html).toContain("Saved page");
  expect(html).toContain('aria-current="page"');
  expect(html).not.toContain("Uncreated page");
  expect(html).not.toContain("Disabled page");
  expect(html).not.toContain("Pinned page");
});

test("the thread action slot exposes enabled contributions without disabled plugin actions", () => {
  const state: NonNullable<ExtensionState> = {
    plugins: [
      {
        auth: null,
        enabled: true,
        error: null,
        id: "sample",
        name: "Sample",
        pages: [],
        schema: null,
        settings: null,
      },
      {
        auth: null,
        enabled: false,
        error: null,
        id: "disabled",
        name: "Disabled",
        pages: [],
        schema: null,
        settings: null,
      },
    ],
  };
  // Action visibility is independent of the current torrent list or host internals.
  const html = renderToStaticMarkup(
    <PluginContributionsProvider
      initialState={state}
      path="/library/all"
      registry={[
        {
          id: "sample",
          ui: { threadActions: [{ id: "run", label: "Find releases", run: () => undefined }] },
        },
        {
          id: "disabled",
          ui: { threadActions: [{ id: "run", label: "Disabled action", run: () => undefined }] },
        },
      ]}
    >
      <PluginThreadActions context={threadContext} />
    </PluginContributionsProvider>
  );
  expect(html).toContain("Find releases");
  expect(html).not.toContain("Disabled action");
});

const settings = {
  downloadLimit: 0,
  downloadPath: "/tmp/tofu",
  runInBackground: true,
  theme: "system",
  uploadLimit: 0,
} as const;
const thread = {
  downloadPath: "/tmp/tofu",
  icon: "folder",
  id: "default",
  name: "Downloads",
  pinned: false,
} as const;
const threadContext: ThreadActionContext = {
  dashboard: {
    destinations: [thread],
    detail: null,
    history: [],
    session: {
      active: 0,
      dhtNodes: 0,
      downloadSpeed: 0,
      engine: "WebTorrent",
      freeSpace: null,
      mode: "server",
      peers: 0,
      port: 0,
      received: 0,
      startedAt: 0,
      uploaded: 0,
      uploadSpeed: 0,
    },
    settings,
    torrents: [],
  },
  settings,
  thread,
  torrents: [],
};

test("the host renders schema defaults and safe account status alongside page controls", () => {
  const state: NonNullable<ExtensionState> = {
    plugins: [
      {
        auth: { connected: false, label: "Provider key", type: "api-key" },
        enabled: true,
        error: null,
        id: "sample",
        name: "Sample",
        pages: [
          {
            available: true,
            created: false,
            id: "library",
            path: "/extensions/sample/library",
            pinnable: true,
            pinned: false,
            title: "Sample library",
          },
        ],
        schema: Type.Object({
          active: Type.Boolean(),
          limit: Type.Integer(),
          title: Type.String(),
        }),
        settings: { active: true, limit: 12, title: "My library" },
      },
    ],
  };
  const html = renderToStaticMarkup(
    <PluginContributionsProvider initialState={state} path="/plugins" registry={[]}>
      <RegisteredPluginSettings threads={[thread]} />
    </PluginContributionsProvider>
  );
  expect(html).toContain("My library");
  expect(html).toContain('type="number"');
  expect(html).toContain('type="password"');
  expect(html).toContain("Create page");
  expect(html).toContain("Global settings");
});

test("saving another setting leaves unset optional fields absent", () => {
  const schema = Type.Object({
    active: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number()),
    metadata: Type.Optional(Type.Object({ label: Type.String() })),
    note: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
    title: Type.String(),
  });
  const form = new FormData();
  form.set("title", "Updated library");
  form.set("limit", "");
  form.set("metadata", "");
  form.set("tags", "  ");
  form.set("note", "");
  expect(settingsFormPatch(schema, { title: "Original library" }, form)).toEqual({
    title: "Updated library",
  });
});

test("settings form preserves false defaults and accepts explicitly entered optional values", () => {
  const schema = Type.Object({
    active: Type.Optional(Type.Boolean()),
    enabled: Type.Boolean(),
    limit: Type.Optional(Type.Number()),
    metadata: Type.Optional(Type.Object({})),
    note: Type.Optional(Type.String()),
    selected: Type.Optional(Type.Boolean()),
    tags: Type.Optional(Type.Array(Type.String())),
  });
  const form = new FormData();
  form.set("limit", "0");
  form.set("metadata", "{}");
  form.set("tags", "[]");
  form.set("note", "  ");
  form.set("selected", "on");
  expect(settingsFormPatch(schema, { active: false, enabled: true }, form)).toEqual({
    active: false,
    enabled: false,
    limit: 0,
    metadata: {},
    note: "  ",
    selected: true,
    tags: [],
  });
});

test("blank optional numbers retain stored values while required numbers reject blanks", async () => {
  const schema = Type.Object({
    optionalLimit: Type.Optional(Type.Number()),
    requiredLimit: Type.Number(),
  });
  const definition = { defaults: { optionalLimit: 12, requiredLimit: 3 }, schema };
  const directory = await mkdtemp(join(tmpdir(), "tofu-settings-form-"));
  try {
    const options = { definition, directory, pluginId: "form" };
    const store = await createSettingsStore(options);
    const form = new FormData();
    form.set("requiredLimit", "5");
    form.set("optionalLimit", "");
    await store.update(settingsFormPatch(schema, store.get(), form));
    const restored = await createSettingsStore(options);
    expect(restored.get()).toEqual({ optionalLimit: 12, requiredLimit: 5 });
    form.set("requiredLimit", "");
    expect(() => settingsFormPatch(schema, store.get(), form)).toThrow(
      "requiredLimit must be a number"
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
