import { openDatabase, type TofuDatabase } from "../../src/api/lib/db";
import { ReleaseAutomationService } from "../../src/api/modules/automation/integration";
import { AutomationService } from "../../src/api/modules/automation/service";
import { DiscoveryService } from "../../src/api/modules/discovery/service";
import { JevService } from "../../src/api/modules/jev/service";
import { type PluginEndpoints, PluginsService } from "../../src/api/modules/plugins/service";
import type { EnginePort } from "../../src/types";

interface TestServicesOptions {
  dataDir: string;
  endpoints: PluginEndpoints;
  engine: () => EnginePort;
  now: () => number;
}

export async function openTestServices(options: TestServicesOptions, connection?: TofuDatabase) {
  const resources = new AsyncDisposableStack();
  try {
    const db = connection ?? (await openDatabase(options.dataDir));
    if (!connection) {
      resources.defer(() => db.$client.close(true));
    }
    const engine = options.engine();
    const plugins = new PluginsService(db, { endpoints: options.endpoints, now: options.now });
    resources.defer(() => plugins.close());
    const jev = new JevService(db, { endpoint: options.endpoints.jev, now: options.now, plugins });
    resources.defer(async () => {
      plugins.close();
      await jev.close();
    });
    const discovery = new DiscoveryService(db, {
      endpoints: options.endpoints,
      engine,
      jev,
      plugins,
    });
    resources.defer(() => discovery.close());
    const automation = new AutomationService(db, { jev, now: options.now });
    const releaseAutomation = new ReleaseAutomationService({
      automation,
      discovery,
      engine,
      now: options.now,
      plugins,
    });
    resources.defer(async () => {
      plugins.close();
      await releaseAutomation.close();
    });
    return {
      automation,
      close: () => resources.disposeAsync(),
      db,
      discovery,
      jev,
      options,
      plugins,
      releaseAutomation,
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}
