import { chmod } from "node:fs/promises";
import { join } from "node:path";

/** Simulates only the inherited-pipe boundary of the native tsnet component. */
export async function embeddedTailscaleFixture(directory: string, autoApprove = false) {
  const configuration = join(directory, "embedded-status.json");
  const binary = join(directory, "tofu-tsnet");
  await Bun.write(configuration, JSON.stringify({ httpsEnabled: false }));
  await Bun.write(
    binary,
    `#!/usr/bin/env bun
let buffer = "";
let serving = false;
let approvalPolls = 0;
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    let { httpsEnabled } = await Bun.file(${JSON.stringify(configuration)}).json();
    if (${autoApprove} && approvalPolls > 0 && command.method === "status") {
      approvalPolls += 1;
      if (approvalPolls >= 4) {
        httpsEnabled = true;
        await Bun.write(${JSON.stringify(configuration)}, JSON.stringify({ httpsEnabled }));
      }
    }
    if (command.method === "authorize-https") approvalPolls = 1;
    if (command.method === "serve" && httpsEnabled) serving = true;
    if (command.method === "stop") serving = false;
    console.log(JSON.stringify({ id: command.id, httpsEnabled, approvalUrl: command.method === "authorize-https" ? "https://console.tailscale.com/admin/dns" : undefined, origin: "https://tofu.tail-test.ts.net", state: command.method === "serve" && !httpsEnabled ? "https-disabled" : serving ? "ready" : "Running" }));
    newline = buffer.indexOf("\\n");
  }
}
`
  );
  await chmod(binary, 0o755);
  return { binary, configuration };
}
