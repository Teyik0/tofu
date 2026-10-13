import { HTTPError } from "elysia";
import type {
  AutomationDecision,
  AutomationDraft,
  AutomationRule,
  AutomationState,
  DiscoveryResult,
  EnginePort,
  FeedRelease,
} from "../../../types";
import { recordLog } from "../../lib/diagnostics";
import { normalizeTitle } from "../../lib/title";
import type { DiscoveryService } from "../discovery/service";
import { collectSourceQueries, uniqueReleases } from "../discovery/sources";
import { publicRelease } from "../plugins/releases";
import type { PluginsService } from "../plugins/service";
import { compareReleases, contentKey } from "./rules";
import type { AutomationService, RuleOwnership } from "./service";

export interface ReleaseAutomationOptions {
  automation: AutomationService;
  discovery: DiscoveryService;
  engine: EnginePort;
  now: () => number;
  plugins: PluginsService;
}

// Built-in release integration. The automation core never invokes this service.
export class ReleaseAutomationService {
  private readonly options: ReleaseAutomationOptions;
  private readonly lifecycle: { closed: boolean; started: boolean } = {
    closed: false,
    started: false,
  };
  private readonly runs = new Map<string, Promise<AutomationState>>();
  private readonly replacements = new Map<string, Promise<void>>();
  private readonly additions = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(options: ReleaseAutomationOptions) {
    this.options = options;
  }
  snapshot(): AutomationState {
    const state = this.options.automation.snapshot();
    const plugins = this.options.plugins.snapshot();
    const enabledSources = new Set(
      plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id)
    );
    return {
      ...state,
      automations: state.automations.map((rule) => {
        let status: AutomationRule["status"] = "active";
        if (!rule.enabled) {
          status = "paused";
        } else if (!rule.sources.some((id) => enabledSources.has(id))) {
          status = "source-disabled";
        } else if (this.runs.has(rule.id)) {
          status = "running";
        } else if (rule.error) {
          status = "error";
        }
        return { ...rule, status };
      }),
      plugins,
    };
  }
  private current(rule: AutomationRule) {
    const current = this.options.automation.ruleSnapshot(rule.id);
    return (
      !this.lifecycle.closed && current?.enabled === true && current.revision === rule.revision
    );
  }
  private rule(id: string) {
    const rule = this.options.automation.ruleSnapshot(id);
    if (!rule) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown automation");
    }
    if (rule.executorId && rule.executorId !== "tofu.releases") {
      throw new (HTTPError.id("CONFLICT", 409))("This rule belongs to another executor");
    }
    return rule;
  }
  private async automationDiscovery(draft: AutomationDraft): Promise<DiscoveryResult> {
    let titles = [draft.title, ...(draft.aliases ?? [])];
    if (
      draft.matchMode === "jev" &&
      this.options.plugins.plugin("jev").enabled &&
      !draft.aliases?.length &&
      draft.sources.some(
        (sourceId) => sourceId !== "tsundere" && this.options.plugins.plugin(sourceId).enabled
      )
    ) {
      titles = await this.options.discovery.titleAliases(draft.title);
    }
    const queries =
      draft.matchMode === "pattern"
        ? [""]
        : [...new Map(titles.map((title) => [normalizeTitle(title), title])).values()].slice(0, 2);
    const result = await collectSourceQueries({
      accept: () => true,
      active: (source) => !this.lifecycle.closed && this.options.plugins.plugin(source).enabled,
      enough: (releases) => this.hasAutomationMatch(draft, releases),
      queries: (source) => (source === "tsundere" ? queries.slice(0, 1) : queries),
      search: (query, source) => this.options.discovery.search(query, [source]),
      sources: draft.sources,
    });
    return { ...result, releases: uniqueReleases(result.releases) };
  }

  private async hasAutomationMatch(draft: AutomationDraft, releases: FeedRelease[]) {
    for (const release of releases) {
      // biome-ignore lint/performance/noAwaitInLoops: stop evaluating once a primary match is accepted.
      if (!(await this.options.automation.evaluate(draft, release)).reason) {
        return true;
      }
    }
    return false;
  }

  async prepareRule(id: string | null, draft: AutomationDraft, ownership?: RuleOwnership) {
    const sources = new Set(this.options.plugins.sourceIds());
    if (draft.sources.some((source) => !sources.has(source))) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Unknown release source");
    }
    if (
      !this.options.engine
        .snapshot(null, false)
        .destinations.some((destination) => destination.id === draft.destinationId)
    ) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Unknown destination");
    }
    let existing = id ? this.options.automation.ruleSnapshot(id) : undefined;
    if (!existing && ownership) {
      existing = this.options.automation
        .snapshot()
        .automations.find(
          (rule) => rule.ownerId === ownership.ownerId && rule.key === ownership.key
        );
    }
    // Validate before performing an optional baseline search.
    const owned = ownership ? { ...ownership, executorId: "tofu.releases" } : undefined;
    const validated = await this.options.automation.prepareRule(id, draft, [], owned);
    if (existing || draft.includeExisting) {
      return validated;
    }
    const baseline = await this.automationDiscovery(draft);
    return this.options.automation.prepareRule(
      id,
      draft,
      baseline.releases.map((release) => ({ contentKey: contentKey(release), release })),
      owned
    );
  }
  async save(id: string | null, draft: AutomationDraft, ownership?: RuleOwnership) {
    const prepared = await this.prepareRule(id, draft, ownership);
    const result = this.options.automation.db.transaction((tx) =>
      this.options.automation.writeRule(tx, prepared)
    );
    this.options.automation.refreshState();
    return result;
  }
  async preview(draft: AutomationDraft) {
    const result = await this.automationDiscovery(draft);
    const evaluated = await Promise.all(
      result.releases.map(async (release) => ({
        release,
        ...(await this.options.automation.evaluate(draft, release)),
      }))
    );
    const candidates = evaluated.filter(
      (candidate) =>
        !candidate.reason && (candidate.probability === null || candidate.probability >= 0.75)
    );
    return {
      ...result,
      candidates: candidates
        .sort((a, b) => compareReleases(draft, a.release, b.release))
        .map((candidate) => ({ ...candidate, release: publicRelease(candidate.release) })),
      releases: candidates.map((candidate) => publicRelease(candidate.release)),
    };
  }
  async run(id: string): Promise<AutomationState> {
    const existing = this.runs.get(id);
    if (existing) {
      return existing;
    }
    const rule = this.rule(id);
    const task = this.execute(rule).catch(() => {
      if (this.current(rule)) {
        this.options.automation.recordFailure(id, rule.revision);
      }
      return this.snapshot();
    });
    this.runs.set(id, task);
    try {
      return await task;
    } finally {
      this.runs.delete(id);
    }
  }

  private async execute(rule: AutomationRule) {
    if (!this.current(rule)) {
      return this.snapshot();
    }
    const enabledSources = new Set(
      this.options.plugins
        .snapshot()
        .filter((plugin) => plugin.enabled)
        .map((plugin) => plugin.id)
    );
    const activeSources = rule.sources.filter((source) => enabledSources.has(source));
    if (!activeSources.length) {
      return this.snapshot();
    }
    await this.completeReplacements(rule);
    const result = await this.automationDiscovery(rule);
    if (!this.current(rule)) {
      return this.snapshot();
    }
    const prepared = await this.options.automation.prepareIngestion({
      activeSources,
      candidates: result.releases.map((release) => ({ contentKey: contentKey(release), release })),
      errors: result.errors.map((error) => error.message),
      revision: rule.revision,
      ruleId: rule.id,
      torrentIds: this.options.engine.snapshot(null, false).torrents.map((torrent) => torrent.id),
    });
    if (!this.current(rule)) {
      return this.snapshot();
    }
    this.options.automation.db.transaction((tx) =>
      this.options.automation.writeIngestion(tx, prepared)
    );
    this.options.automation.refreshState();
    // "adding" is the durable action journal: a crash leaves the decision retryable.
    for (const decision of this.options.automation.decisionRecords()) {
      if (decision.automationId === rule.id && decision.status === "adding") {
        // biome-ignore lint/performance/noAwaitInLoops: serialize additions after the decisions commit.
        await this.addDecision(decision, rule);
      }
    }
    return this.snapshot();
  }
  private async completeReplacements(rule: AutomationRule) {
    const existing = this.replacements.get(rule.id);
    if (existing) {
      return existing;
    }
    const task = this.finishReplacements(rule);
    this.replacements.set(rule.id, task);
    try {
      await task;
    } finally {
      this.replacements.delete(rule.id);
    }
  }
  private async finishReplacements(rule: AutomationRule) {
    for (const decision of this.options.automation.decisionRecords()) {
      if (
        decision.automationId !== rule.id ||
        decision.status !== "added" ||
        !decision.supersedes ||
        !this.current(rule)
      ) {
        continue;
      }
      const { torrents } = this.options.engine.snapshot(null, false);
      const current = torrents.find((torrent) => torrent.id === decision.torrentId);
      if (current?.progress !== 1 || current.error) {
        continue;
      }
      const oldId = decision.supersedes.torrentId;
      const shared = [...this.options.automation.decisionRecords()].some(
        (other) =>
          other.id !== decision.id &&
          (other.torrentId === oldId || other.supersedes?.torrentId === oldId)
      );
      try {
        if (
          oldId !== decision.torrentId &&
          !shared &&
          torrents.some((torrent) => torrent.id === oldId)
        ) {
          // biome-ignore lint/performance/noAwaitInLoops: finish each persisted replacement before the next.
          await this.options.engine.remove(oldId, rule.deleteReplacedFiles === true);
        }
        decision.supersedes = null;
        if (shared) {
          decision.reason = "Better version downloaded · old version used by another rule";
        } else {
          decision.reason =
            rule.deleteReplacedFiles === true
              ? "Better version downloaded · old files deleted"
              : "Better version downloaded · old files kept";
        }
      } catch {
        decision.reason = "Better version downloaded · retry removing the old version";
      }
      if (!this.lifecycle.closed) {
        this.options.automation.writeDecisionResult({
          decision,
          reason: decision.reason ?? "",
          revision: rule.revision,
          status: decision.status,
          supersedes: decision.supersedes,
          torrentId: decision.torrentId,
        });
      }
    }
  }

  private async addDecision(decision: AutomationDecision, rule: AutomationRule) {
    const pending = this.additions.get(decision.id);
    if (pending) {
      return pending;
    }
    const task = this.executeAddition(decision, rule);
    this.additions.set(decision.id, task);
    try {
      await task;
    } finally {
      this.additions.delete(decision.id);
    }
  }
  private async executeAddition(decision: AutomationDecision, rule: AutomationRule) {
    if (
      !(
        this.current(rule) &&
        rule.sources.includes(decision.release.sourceId) &&
        this.options.plugins.plugin(decision.release.sourceId).enabled
      )
    ) {
      return;
    }
    try {
      const existing = this.options.engine
        .snapshot(null, false)
        .torrents.find((item) => item.id === decision.release.infoHash);
      const torrent =
        existing ??
        (await this.options.discovery.addRelease(
          decision.release.sourceId,
          decision.release.id,
          rule.destinationId,
          rule.paused,
          () =>
            this.current(rule) &&
            this.options.automation
              .decisionRecords()
              .some(
                (current) =>
                  current.id === decision.id &&
                  current.status === "adding" &&
                  current.release.id === decision.release.id &&
                  current.release.sourceId === decision.release.sourceId
              )
        ));
      decision.torrentId = torrent.id;
      decision.status = "added";
      if (existing) {
        decision.reason = "Already in the library";
      } else {
        decision.reason = decision.supersedes
          ? "Better version added · old version kept until the download completes"
          : "Added to the thread folder";
      }
    } catch {
      if (decision.status === "ignored") {
        return;
      }
      decision.status = "error";
      decision.reason = "Unable to add the torrent; retrying on the next check";
    }
    if (!this.lifecycle.closed) {
      this.options.automation.writeDecisionResult({
        decision,
        reason: decision.reason,
        revision: rule.revision,
        status: decision.status,
        torrentId: decision.torrentId,
      });
    }
  }
  async approve(id: string) {
    this.options.automation.approve(id);
    const decision = this.options.automation.decisionRecords().find((item) => item.id === id);
    if (!decision) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown release");
    }
    if (decision.status === "added" || decision.status === "ignored") {
      return this.snapshot();
    }
    const owner = this.options.automation.ruleSnapshot(decision.automationId);
    if (owner?.executorId && owner.executorId !== "tofu.releases") {
      return this.snapshot();
    }
    await this.addDecision(decision, this.rule(decision.automationId));
    return this.snapshot();
  }
  async start() {
    if (this.lifecycle.started || this.lifecycle.closed) {
      return;
    }
    this.lifecycle.started = true;
    try {
      await Promise.all(
        this.options.automation
          .snapshot()
          .automations.filter(
            (rule) => rule.enabled && (!rule.executorId || rule.executorId === "tofu.releases")
          )
          .map((rule) => this.run(rule.id))
      );
    } finally {
      if (!this.lifecycle.closed) {
        this.timer = setInterval(() => {
          void this.tick().catch((error: unknown) => {
            recordLog({ component: "automation", error, level: "error", operation: "poll" });
          });
        }, 15_000);
        this.timer.unref();
      }
    }
  }
  async tick() {
    if (this.lifecycle.closed) {
      return;
    }
    await Promise.all(
      this.options.automation
        .snapshot()
        .automations.filter(
          (rule) =>
            rule.enabled &&
            (!rule.executorId || rule.executorId === "tofu.releases") &&
            !this.runs.has(rule.id)
        )
        .map((rule) => this.completeReplacements(rule))
    );
    await Promise.all(
      this.options.automation
        .snapshot()
        .automations.filter(
          (rule) =>
            rule.enabled &&
            (!rule.executorId || rule.executorId === "tofu.releases") &&
            (rule.nextRunAt === null ||
              rule.nextRunAt <= this.options.now() ||
              this.options.automation
                .decisionRecords()
                .some(
                  (decision) =>
                    decision.automationId === rule.id &&
                    decision.status === "waiting" &&
                    decision.deadline !== null &&
                    decision.deadline <= this.options.now()
                ))
        )
        .map((rule) => this.run(rule.id))
    );
  }
  async close() {
    if (this.lifecycle.closed) {
      return;
    }
    this.lifecycle.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    await Promise.allSettled(this.runs.values());
    await Promise.allSettled(this.replacements.values());
    await Promise.allSettled(this.additions.values());
  }
}
