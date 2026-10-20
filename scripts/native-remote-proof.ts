// Packaged macOS proof. No real account, trust store or tailnet configuration is changed.
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../src/api";
import { desktopLauncher, hostDesktopTarget } from "../src/platform";

const directory = await mkdtemp(join(tmpdir(), "tofu-native-remote-"));
const processes: ReturnType<typeof Bun.spawn>[] = [];
const reports: {
  id: string;
  role: string;
  hostNative: boolean;
  cookiesHidden: boolean;
  nativeBridge: boolean;
  previousStorage: string | null;
}[] = [];
const collector = Bun.serve({
  async fetch(request) {
    if (request.method === "POST") {
      reports.push(await request.json());
    }
    return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
  },
  hostname: "127.0.0.1",
  port: 0,
});
try {
  const hosts = await Promise.all(
    [0, 1].map(async (index) => {
      const dataDir = join(directory, `host-${index}`);
      const child = Bun.spawn([process.execPath, "src/server.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          TOFU_DATA_DIR: dataDir,
          TOFU_DOWNLOAD_DIR: join(dataDir, "downloads"),
          TOFU_MODE: "server",
          TOFU_PORT: "0",
          TOFU_PROFILE: "dev",
          TOFU_TAILSCALE_CLI: join(directory, "no-tailscale"),
        },
        stderr: "inherit",
        stdout: "ignore",
      });
      processes.push(child);
      let origin = "";
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (child.exitCode !== null) {
          throw new Error("Fixture host exited");
        }
        const file = Bun.file(join(dataDir, "server.json"));
        // biome-ignore lint/performance/noAwaitInLoops: Each iteration depends on the previous lifecycle or readiness result.
        if (await file.exists()) {
          origin = (await file.json()).url;
          break;
        }
        await Bun.sleep(100);
      }
      if (!origin) {
        throw new Error("Fixture host did not start");
      }
      const client = treaty<Api>(origin).api;
      const invitation = await client.access.invitations.post({
        canDeleteFiles: false,
        expiresInMinutes: 10,
        label: "Native proof",
        role: "playback",
      });
      if (invitation.error) {
        throw invitation.error;
      }
      const sharing = await client.connections.put({
        enabled: true,
        proxyOrigin: "https://fixture.invalid",
        transport: "proxy",
      });
      if (sharing.error) {
        throw sharing.error;
      }
      return {
        address: `${origin}/pair#i=${invitation.data.secret}`,
        label: `Native client ${index}`,
        temporary: true,
      };
    })
  );
  const nativeDir = join(directory, "native-client");
  await mkdir(join(nativeDir, "native"), { recursive: true });
  await Bun.write(
    join(nativeDir, "native/servers.json"),
    JSON.stringify({ servers: [], startLocal: false, version: 1 })
  );
  const discoveryCLI = join(directory, "dns-sd");
  await Bun.write(
    discoveryCLI,
    `#!/usr/bin/env bun
console.log(process.argv[2] === "-B" ? "10:00:00.000 Add 2 4 local. _tofu._tcp. Native proof" : "Native proof can be reached at proof-host.local.:443 (interface 4)");
`,
    { mode: 0o755 }
  );
  await chmod(discoveryCLI, 0o755);
  const managerScript = join(directory, "manager.js");
  await Bun.write(
    managerScript,
    `const hosts=${JSON.stringify(hosts)}; let sent=0; let finished=false; const render=window.renderManager; let last; setTimeout(()=>command('proof',{id:JSON.stringify(last||{error:'manager did not render'})}),25000); window.renderManager=state=>{last=state;render(state);if(state.message?.includes('cannot protect')){command('proof',{id:JSON.stringify(state)});return;}if(sent===0&&state.discovered?.length){sent=1;command('pair',hosts[0]);}const connected=(state.servers||[]).filter(item=>item.status==='Connected').length;if(connected===1&&sent===1){sent=2;command('pair',hosts[1]);}if(connected===2&&!finished){finished=true;setTimeout(()=>command('proof',{id:'two paired servers'}),3000);}};command('discover');`
  );
  const remoteScript = join(directory, "remote.js");
  await Bun.write(
    remoteScript,
    `(async()=>{const response=await fetch('/api/session');const session=await response.json();const previousStorage=localStorage.getItem('tofu-native-proof');localStorage.setItem('tofu-native-proof',session.server.id);await fetch(${JSON.stringify(`http://127.0.0.1:${collector.port}`)},{method:'POST',mode:'no-cors',body:JSON.stringify({id:session.server.id,role:session.caller.role,hostNative:session.capabilities.hostNative,cookiesHidden:!document.cookie.includes('tofu-'),nativeBridge:typeof window.__electrobunHostBridge!=='undefined'||typeof window.__electrobunInternalBridge!=='undefined',previousStorage})});})();`
  );
  const report = join(directory, "result.json");
  const launcher = desktopLauncher(join(import.meta.dir, ".."), hostDesktopTarget(), "dev");
  const app = Bun.spawn([launcher], {
    env: {
      ...process.env,
      TOFU_DATA_DIR: nativeDir,
      TOFU_DISCOVERY_CLI: discoveryCLI,
      TOFU_MODE: "desktop",
      TOFU_NATIVE_MANAGER_TEST_REPORT: report,
      TOFU_NATIVE_MANAGER_TEST_SCRIPT: managerScript,
      TOFU_NATIVE_REMOTE_TEST_SCRIPT: remoteScript,
    },
    stderr: "pipe",
    stdout: "ignore",
  });
  processes.push(app);
  const timeout = setTimeout(() => app.kill(), 45_000);
  try {
    const exit = await app.exited;
    if (exit !== 0 || !(await Bun.file(report).exists())) {
      throw new Error(`Native proof failed: ${await new Response(app.stderr).text()}`);
    }
    const result = (await Bun.file(report).json()) as {
      backend: boolean;
      databaseCreated: boolean;
      input: { id: string };
      runtime: string;
      views: { partition: string | null; sandbox: boolean; url: string | null }[];
    };
    const cookieBlocked =
      reports.length === 0 &&
      result.input.id.includes("cannot protect") &&
      result.views.every((view) => !view.partition);
    if (cookieBlocked) {
      const state = JSON.parse(result.input.id);
      if (result.backend || result.databaseCreated || state.discovered?.length !== 1) {
        throw new Error("Client-only manager or discovery proof failed");
      }
      const evidence = {
        detail: "The pinned SDK drops HttpOnly; Tofu refused remote navigation",
        gate: "blocked-native-cookie",
        result,
      };
      await Bun.write(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ directory, ...evidence }, null, 2));
      process.exitCode = 0;
    } else {
      if (
        result.backend ||
        result.databaseCreated ||
        reports.length !== 2 ||
        reports.some(
          (item) =>
            item.role !== "playback" ||
            item.hostNative ||
            !item.cookiesHidden ||
            item.nativeBridge ||
            item.previousStorage !== null
        ) ||
        new Set(reports.map((item) => item.id)).size !== 2
      ) {
        throw new Error(JSON.stringify({ reports, result }));
      }
      const evidence = { ...result, reports };
      await Bun.write(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
      console.log(`Native remote proof passed: ${join(directory, "evidence.json")}`);
    }
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await collector.stop(true);
  for (const child of processes) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
  await Promise.allSettled(processes.map((child) => child.exited));
  // Preserve evidence, clear credentials and application state from this isolated run.
  for (const folder of ["host-0", "host-1", "native-client"]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each iteration depends on the previous lifecycle or readiness result.
    await rm(join(directory, folder), { force: true, recursive: true });
  }
}
