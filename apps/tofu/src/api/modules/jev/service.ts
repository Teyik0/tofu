import { type JevQuestions, type JevResult, parseJevResponse } from "@tofu/plugins/jev-questions";

// biome-ignore lint/performance/noBarrelFile: Question contracts are available to both the core and plugins.
export * from "@tofu/plugins/jev-questions";

import { eq } from "drizzle-orm";
import { HTTPError } from "elysia";
import { automationJudgements } from "../../../db/schema";
import type { TofuDatabase } from "../../lib/db";
import type { PluginsService } from "../plugins/service";

export class JevService {
  private readonly db: TofuDatabase;
  private readonly lifecycle: { closed: boolean } = { closed: false };
  private readonly evaluations = new Map<string, Promise<JevResult | null>>();
  private readonly requests = new Set<AbortController>();
  private readonly options: { plugins: PluginsService; now: () => number; endpoint: string };
  constructor(
    db: TofuDatabase,
    options: { plugins: PluginsService; now: () => number; endpoint: string }
  ) {
    this.db = db;
    this.options = options;
  }
  async evaluate(state: object, questions: JevQuestions) {
    if (this.lifecycle.closed) {
      throw new (HTTPError.id("CONFLICT", 409))("Jev service stopped");
    }
    const plugin = this.options.plugins.plugin("jev");
    if (!(plugin?.enabled && plugin.apiKey)) {
      return null;
    }
    const key = Bun.SHA256.hash(JSON.stringify({ model: "jev-latest", questions, state }), "hex");
    const cached = this.db
      .select()
      .from(automationJudgements)
      .where(eq(automationJudgements.id, key))
      .get();
    if (cached && cached.createdAt > this.options.now() - 86_400_000) {
      return JSON.parse(cached.value) as JevResult;
    }
    const pending = this.evaluations.get(key);
    if (pending) {
      return pending;
    }
    const task = this.requestEvaluation(state, questions).then((result) => {
      if (!result || this.lifecycle.closed) {
        return null;
      }
      const judgement = { createdAt: this.options.now(), value: JSON.stringify(result) };
      this.db
        .insert(automationJudgements)
        .values({ id: key, ...judgement })
        .onConflictDoUpdate({ set: judgement, target: automationJudgements.id })
        .run();
      return result;
    });
    this.evaluations.set(key, task);
    try {
      return await task;
    } finally {
      this.evaluations.delete(key);
    }
  }

  private requestEvaluation(state: object, questions: JevQuestions) {
    const plugin = this.options.plugins.plugin("jev");
    if (!(plugin?.enabled && plugin.apiKey)) {
      return Promise.resolve(null);
    }
    this.options.plugins.reserveDailyCall("jev");
    return this.options.plugins.request("jev", 15_000, null, async (controller) => {
      this.requests.add(controller);
      try {
        if (this.lifecycle.closed) {
          controller.abort();
        }
        controller.signal.throwIfAborted();
        const response = await fetch(this.options.endpoint, {
          body: JSON.stringify({ model: "jev-latest", questions, state }),
          headers: { authorization: `Bearer ${plugin.apiKey}`, "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new (HTTPError.id("SERVICE_UNAVAILABLE", 503))(
            `Jev unavailable (HTTP ${response.status})`
          );
        }
        const result = parseJevResponse(await response.json(), questions);
        if (!this.options.plugins.plugin("jev").enabled) {
          throw new (HTTPError.id("CONFLICT", 409))("Jev plugin disabled");
        }
        this.options.plugins.recordSuccess("jev");
        return result;
      } catch (cause) {
        if (plugin.enabled) {
          this.options.plugins.recordFailure("jev", "Jev evaluation unavailable");
        }
        throw cause instanceof HTTPError
          ? cause
          : new (HTTPError.id("SERVICE_UNAVAILABLE", 503))("Unable to connect to Jev");
      } finally {
        this.requests.delete(controller);
      }
    });
  }
  async close() {
    this.lifecycle.closed = true;
    for (const controller of this.requests) {
      controller.abort();
    }
    await Promise.allSettled(this.evaluations.values());
  }
}
