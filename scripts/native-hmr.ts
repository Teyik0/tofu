// biome-ignore-all lint/performance/noAwaitInLoops: Observe real native refresh and restart events sequentially.
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DashboardState, ServerInfo } from "../src/types";
import { fixture, json, waitFor } from "../tests/helpers";
import { nativeRequest } from "./native-request";

interface Observation {
  color: string;
  document: string;
  draft: string;
  label: string;
}
const root = join(import.meta.dir, "..");
const page = join(root, "src/pages/hmr-validation.tsx");
const stylesheet = join(root, "src/pages/hmr-validation.css");
for (const path of [page, stylesheet]) {
  if (await Bun.file(path).exists()) {
    throw new Error("The HMR validation route already exists");
  }
}
const context = await fixture(65_536, []);
const serverSource = join(root, "src/server.ts");
const restartMarker = "\n// Native HMR validation restart.\n";
const observations: Observation[] = [];
const collector = Bun.serve({
  async fetch(request) {
    observations.push((await request.json()) as Observation);
    return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
  },
  hostname: "127.0.0.1",
  port: 0,
});
const render = (label: string) => `import { defineRoute } from "@teyik0/furin";
import { useEffect, useState } from "react";
import "./hmr-validation.css";
function Validation() {
  const [draft, setDraft] = useState("");
  useEffect(() => { document.documentElement.dataset.hmrReady = "true"; }, []);
  return <main><p id="hmr-label">${label}</p><input id="hmr-draft" value={draft} onChange={(event) => setDraft(event.target.value)} /></main>;
}
export const route = defineRoute().config({ mode: "ssr", layout: undefined }).page(Validation);
`;
const workflow = (reportUrl: string) => {
  if (location.pathname !== "/hmr-validation") {
    location.href = "/hmr-validation";
    return;
  }
  const documentId = crypto.randomUUID();
  let previous = "";
  let initialized = false;
  setInterval(() => {
    const input = document.querySelector<HTMLInputElement>("#hmr-draft");
    const label = document.querySelector<HTMLElement>("#hmr-label");
    if (!(input && label) || document.documentElement.dataset.hmrReady !== "true") {
      return;
    }
    if (!initialized) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Keep my draft"
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      initialized = true;
    }
    const observation = JSON.stringify({
      color: getComputedStyle(label).color,
      document: documentId,
      draft: input.value,
      label: label.textContent,
    });
    if (observation !== previous) {
      previous = observation;
      fetch(reportUrl, { body: observation, method: "POST" }).catch(console.error);
    }
  }, 100);
};
const script = join(context.directory, "workflow.js");
let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let output: Promise<string[]> | undefined;
await mkdir(join(root, ".cache"), { recursive: true });
const live = Bun.file(join(root, ".cache/native-hmr-live.log")).writer();
const checks: string[] = [];
try {
  await Bun.write(page, render("Before refresh"));
  await Bun.write(stylesheet, "#hmr-label { color: rgb(10, 20, 30); }\n");
  await Bun.write(script, `(${workflow.toString()})(${JSON.stringify(collector.url.href)})`);
  child = Bun.spawn([process.execPath, "scripts/build.ts", "dev-desktop"], {
    cwd: root,
    env: {
      ...process.env,
      TOFU_DATA_DIR: join(context.directory, "native-state"),
      TOFU_DOWNLOAD_DIR: join(context.directory, "downloads"),
      TOFU_PROFILE: "dev",
      TOFU_RELEASE: "0",
      TOFU_SMOKE_SCRIPT: script,
    },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const stdout = child.stdout.tee();
  const stderr = child.stderr.tee();
  for (const stream of [stdout[1], stderr[1]]) {
    stream
      .pipeTo(
        new WritableStream({
          write(chunk) {
            live.write(chunk);
            live.flush();
          },
        })
      )
      .catch(console.error);
  }
  output = Promise.all([new Response(stdout[0]).text(), new Response(stderr[0]).text()]);
  const observe = async (predicate: (item: Observation) => boolean) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const found = observations.find(predicate);
      if (found) {
        return found;
      }
      if (child?.exitCode !== null) {
        throw new Error((await output)?.join("\n"));
      }
      await Bun.sleep(100);
    }
    throw new Error(`Native HMR observation timed out: ${JSON.stringify(observations)}`);
  };
  const first = await observe(
    (item) =>
      item.label === "Before refresh" &&
      item.draft === "Keep my draft" &&
      item.color === "rgb(10, 20, 30)"
  );
  const descriptor = join(context.directory, "native-state/server.json");
  const initial: ServerInfo = await Bun.file(descriptor).json();
  await Bun.write(page, render("After refresh"));
  const refreshed = await observe(
    (item) => item.label === "After refresh" && item.document === first.document
  );
  if (refreshed.draft !== first.draft) {
    throw new Error("React refresh discarded the draft");
  }
  await Bun.write(stylesheet, "#hmr-label { color: rgb(40, 50, 60); }\n");
  const styled = await observe(
    (item) => item.color === "rgb(40, 50, 60)" && item.document === first.document
  );
  const afterFrontend: ServerInfo = await Bun.file(descriptor).json();
  if (styled.draft !== first.draft || afterFrontend.pid !== initial.pid) {
    throw new Error("Frontend edits replaced the native host or draft");
  }
  checks.push("React and CSS HMR preserve the controlled draft, document and native PID");
  const added = await nativeRequest(
    initial,
    "/api/torrents",
    json({ paused: false, source: context.magnet })
  );
  if (!added.ok) {
    throw new Error(await added.text());
  }
  const { id } = (await added.json()) as { id: string };
  const readState = async (server: ServerInfo) =>
    (await (await nativeRequest(server, "/api/state", undefined)).json()) as DashboardState;
  await waitFor(
    () => readState(initial),
    (state) => state.torrents.some((torrent) => torrent.id === id && torrent.status === "seeding")
  );
  await nativeRequest(initial, `/api/torrents/${id}/pause`, { method: "POST" });
  await appendFile(serverSource, restartMarker);
  await observe((item) => item.document !== first.document);
  const restarted: ServerInfo = await Bun.file(descriptor).json();
  if (restarted.pid === initial.pid) {
    throw new Error("Backend changes did not replace the host");
  }
  try {
    process.kill(initial.pid, 0);
    throw new Error("Old native host remains alive");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
  const restored = await readState(restarted);
  if (!restored.torrents.some((torrent) => torrent.id === id && torrent.status === "paused")) {
    throw new Error("Restart lost the paused torrent");
  }
  const bytes = await (
    await nativeRequest(restarted, `/api/torrents/${id}/files/0/content`, undefined)
  ).arrayBuffer();
  if (Bun.SHA256.hash(bytes, "hex") !== Bun.SHA256.hash(context.bytes, "hex")) {
    throw new Error("Restart changed downloaded bytes");
  }
  if ((await fetch(`${restarted.url}/api/state`)).status !== 403) {
    throw new Error("Dev requests bypass the private session");
  }
  checks.push(
    "Backend restart reaps the old host and restores a paused real transfer with exact SHA-256"
  );
  await Bun.write(
    join(root, ".cache/native-hmr.json"),
    JSON.stringify({ checks, passed: true }, null, 2)
  );
  console.log(checks.join("\n"));
} catch (error) {
  await Bun.write(
    join(root, ".cache/native-hmr.json"),
    JSON.stringify({ checks, error: String(error), passed: false }, null, 2)
  );
  throw error;
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
  }
  await child?.exited;
  if (output) {
    await Bun.write(join(root, ".cache/native-hmr.log"), (await output).join("\n"));
  }
  live.end();
  const currentServer = await Bun.file(serverSource).text();
  if (currentServer.includes(restartMarker)) {
    await Bun.write(serverSource, currentServer.replace(restartMarker, ""));
  }
  await Promise.all([rm(page, { force: true }), rm(stylesheet, { force: true })]);
  collector.stop(true);
  await context.close();
}
