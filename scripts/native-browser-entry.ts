import { catalogWorkflow } from "../tests/anilist/native/catalog";
import { libraryWorkflow } from "../tests/anilist/native/library";
import { globalSearchWorkflow } from "./native-global-search";
import { nativeWorkflow } from "./native-workflow-main";
import { pluginsWorkflow } from "./native-workflow-plugins";

const workflows = {
  anilist: libraryWorkflow,
  "anilist-catalog": catalogWorkflow,
  "global-search": globalSearchWorkflow,
  main: nativeWorkflow,
  plugins: pluginsWorkflow,
};
type WorkflowConfig = Parameters<typeof nativeWorkflow>[0] & {
  searchReleases: import("../src/types").FeedRelease[];
};
const { name, config } = (
  globalThis as typeof globalThis & {
    tofuNativeWorkflow: { name: keyof typeof workflows; config: WorkflowConfig };
  }
).tofuNativeWorkflow;
// Assert final native UI states without depending on animation clocks in an unfocused WebView.
(
  globalThis as typeof globalThis & { BASE_UI_ANIMATIONS_DISABLED: boolean }
).BASE_UI_ANIMATIONS_DISABLED = true;
const motion = document.createElement("style");
motion.id = "tofu-native-motion";
motion.textContent =
  "*, *::before, *::after { animation: none !important; transition: none !important; }";
document.head.append(motion);
async function runWorkflow() {
  const opened = await fetch("/api/desktop/open", { method: "POST" });
  if (!opened.ok) {
    throw new Error("Unable to activate the native test window");
  }
  await workflows[name](config);
}
void runWorkflow().catch((cause) =>
  fetch(config.reportUrl, {
    body: JSON.stringify({ error: String(cause), passed: false }),
    method: "POST",
  })
);
