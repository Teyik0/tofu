import { Cause, Context, Effect, Fiber, Layer, Schedule } from "effect";
import { ElysiaStatus, problem } from "elysia";
import { createLogger } from "evlog";
import {
  mappedAnimeQueries,
  mappedAnimeRelease,
} from "../../../../../../package/plugins/src/anime-mapping";
import type {
  AutomationDecision,
  AutomationDraft,
  AutomationRule,
  AutomationState,
} from "../../../../../../package/plugins/src/automation-model";
import {
  compareReleases,
  contentKey,
} from "../../../../../../package/plugins/src/automation-rules";
import type {
  DiscoverySearch,
  FeedRelease,
} from "../../../../../../package/plugins/src/discovery-model";
import type { SourcePluginId } from "../../../../../../package/plugins/src/plugin-model";
import { publicRelease } from "../../../../../../package/plugins/src/releases";
import {
  collectSourceQueries,
  uniqueReleases,
} from "../../../../../../package/plugins/src/source-queries";
import { normalizeTitle } from "../../../../../../package/plugins/src/title";
import type { DatabaseTransaction } from "../../lib/db";
import type { DiscoveryService } from "../discovery/service";
import { Discovery } from "../discovery/service";
import type { PluginsService } from "../plugins/service";
import { Plugins } from "../plugins/service";
import { TorrentClient } from "../torrents/layer";
import type { EnginePort } from "../torrents/service";
import type { AutomationService, PreparedRule, RuleOwnership } from "./service";
import { Automation } from "./service";

export interface ReleaseAutomationOptions {
  automation: AutomationService;
  discovery: DiscoveryService;
  engine: EnginePort;
  now: () => number;
  plugins: PluginsService;
}
type MappingFailure = ReturnType<
  typeof problem<502, { readonly detail: "Episode mapping unavailable" }>
>;

// Built-in release integration. The automation core never invokes this service.
const make = Effect.gen(function* () {
  const automation = yield* Automation;
  const discovery = yield* Discovery;
  const engine = yield* TorrentClient;
  const plugins = yield* Plugins;
  const options: ReleaseAutomationOptions = {
    automation,
    discovery,
    engine,
    now: Date.now,
    plugins,
  };

  const serviceOptions = options;
  const scope = yield* Effect.scope;

  const serviceLifecycle: { closed: boolean; started: boolean } = {
    closed: false,
    started: false,
  };
  const serviceRuns = new Map<string, ReturnType<typeof serviceExecute>>();
  const serviceReplacements = new Map<string, Effect.Effect<void>>();
  const serviceAdditions = new Map<string, Effect.Effect<void>>();
  let serviceTimer: Fiber.Fiber<void> | null = null;
  function serviceSnapshot(): AutomationState {
    const state = serviceOptions.automation.snapshot();
    const currentPlugins = serviceOptions.plugins.snapshot();
    const enabledSources = new Set(
      currentPlugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id)
    );
    return {
      ...state,
      automations: state.automations.map((rule) => {
        let status: AutomationRule["status"] = "active";
        if (!rule.enabled) {
          status = "paused";
        } else if (!rule.sources.some((id) => enabledSources.has(id))) {
          status = "source-disabled";
        } else if (serviceRuns.has(rule.id)) {
          status = "running";
        } else if (rule.error) {
          status = "error";
        }
        return { ...rule, status };
      }),
      plugins: currentPlugins,
    };
  }
  function serviceCurrent(rule: AutomationRule) {
    const current = serviceOptions.automation.ruleSnapshot(rule.id);
    return (
      !serviceLifecycle.closed && current?.enabled === true && current.revision === rule.revision
    );
  }
  function serviceRule(id: string) {
    const rule = serviceOptions.automation.ruleSnapshot(id);
    if (!rule) {
      return problem(404, { detail: "Unknown automation" });
    }
    if (rule.executorId && rule.executorId !== "tofu.releases") {
      return problem(409, { detail: "This rule belongs to another executor" });
    }
    return rule;
  }
  const serviceAutomationDiscovery = Effect.fn("ReleaseAutomation.automationDiscovery")(function* (
    draft: AutomationDraft
  ) {
    const mapping =
      draft.anilistId === undefined
        ? null
        : yield* serviceOptions.discovery.animeMapping(draft.anilistId);
    if (draft.anilistId !== undefined && !mapping) {
      return problem(502, { detail: "Episode mapping unavailable" });
    }
    const anime =
      draft.anilistId === undefined
        ? null
        : {
            aliases: draft.aliases ?? [],
            episodes: draft.episodeCount ?? null,
            mediaId: draft.anilistId,
            title: draft.title,
          };
    const titles = [draft.title, ...(draft.aliases ?? [])];
    const baseQueries =
      draft.matchMode === "pattern"
        ? [""]
        : [...new Map(titles.map((title) => [normalizeTitle(title), title])).values()].slice(0, 2);
    const queries = mapping ? mappedAnimeQueries(mapping, baseQueries) : baseQueries;
    const result = yield* collectSourceQueries({
      accept: () => true,
      active: (source) => !serviceLifecycle.closed && serviceOptions.plugins.plugin(source).enabled,
      enough: (found) =>
        serviceHasAutomationMatch(
          draft,
          mapping && anime
            ? found
                .map((release) => mappedAnimeRelease(anime, mapping, release))
                .filter((release): release is FeedRelease => release !== null)
            : found
        ),
      queries: (source) => (source === "tsundere" ? queries.slice(0, 1) : queries),
      search: (query, source) => serviceOptions.discovery.search(query, [source]),
      sources: draft.sources,
    });
    const releases =
      mapping && anime
        ? result.releases
            .map((release) => mappedAnimeRelease(anime, mapping, release))
            .filter((release): release is FeedRelease => release !== null)
        : result.releases;
    return { ...result, releases: uniqueReleases(releases) };
  });
  const serviceHasAutomationMatch = Effect.fn("ReleaseAutomation.hasAutomationMatch")(function* (
    draft: AutomationDraft,
    releases: FeedRelease[]
  ) {
    for (const release of releases) {
      // stop evaluating once a primary match is accepted.
      const evaluation = yield* serviceOptions.automation.evaluate(draft, release);
      if (evaluation instanceof ElysiaStatus) {
        return false;
      }
      if (!evaluation.reason) {
        return true;
      }
    }
    return false;
  });
  const servicePrepareRule = Effect.fn("ReleaseAutomation.prepareRule")(function* (
    id: string | null,
    draft: AutomationDraft,
    ownership?: RuleOwnership
  ) {
    const sources = new Set(serviceOptions.plugins.sourceIds());
    if (draft.sources.some((source) => !sources.has(source))) {
      return problem(400, { detail: "Unknown release source" });
    }
    if (
      !serviceOptions.engine
        .snapshot(null, false)
        .destinations.some((destination) => destination.id === draft.destinationId)
    ) {
      return problem(400, { detail: "Unknown destination" });
    }
    let existing = id ? serviceOptions.automation.ruleSnapshot(id) : undefined;
    if (!existing && ownership) {
      existing = serviceOptions.automation
        .snapshot()
        .automations.find(
          (rule) => rule.ownerId === ownership.ownerId && rule.key === ownership.key
        );
    }
    // Validate before performing an optional baseline search.
    const owned = ownership ? { ...ownership, executorId: "tofu.releases" } : undefined;
    const validated = yield* serviceOptions.automation.prepareRule(id, draft, [], owned);
    if (validated instanceof ElysiaStatus || existing || draft.includeExisting) {
      return validated;
    }
    const baseline = yield* serviceAutomationDiscovery(draft);
    if (baseline instanceof ElysiaStatus) {
      return baseline;
    }
    return yield* serviceOptions.automation.prepareRule(
      id,
      draft,
      baseline.releases.map((release) => ({ contentKey: contentKey(release), release })),
      owned
    );
  });
  function serviceWriteRule(tx: DatabaseTransaction, prepared: PreparedRule) {
    if (
      !serviceOptions.engine
        .snapshot(null, false)
        .destinations.some((destination) => destination.id === prepared.rule.destinationId)
    ) {
      return problem(400, { detail: "Unknown destination" });
    }
    return serviceOptions.automation.writeRule(tx, prepared);
  }
  const serviceSave = Effect.fn("ReleaseAutomation.save")(function* (
    id: string | null,
    draft: AutomationDraft,
    ownership?: RuleOwnership
  ) {
    const prepared = yield* servicePrepareRule(id, draft, ownership);
    if (prepared instanceof ElysiaStatus) {
      return prepared;
    }
    const result = serviceOptions.automation.db.transaction((tx) => serviceWriteRule(tx, prepared));
    serviceOptions.automation.refreshState();
    return result;
  });
  const servicePreview = Effect.fn("ReleaseAutomation.preview")(function* (draft: AutomationDraft) {
    const result = yield* serviceAutomationDiscovery(draft);
    if (result instanceof ElysiaStatus) {
      return result;
    }
    const evaluated = yield* Effect.forEach(
      result.releases,
      (release) =>
        serviceOptions.automation
          .evaluate(draft, release)
          .pipe(Effect.map((evaluation) => ({ ...evaluation, release }))),
      { concurrency: "unbounded" }
    );
    const candidates = evaluated.filter((candidate) => !candidate.reason);
    return {
      ...result,
      candidates: candidates
        .sort((a, b) => compareReleases(draft, a.release, b.release))
        .map((candidate) => ({ ...candidate, release: publicRelease(candidate.release) })),
      releases: candidates.map((candidate) => publicRelease(candidate.release)),
    };
  });
  const serviceRun = Effect.fn("ReleaseAutomation.run")(function* (id: string) {
    const existing = serviceRuns.get(id);
    if (existing) {
      return yield* existing;
    }
    const rule = serviceRule(id);
    if (rule instanceof ElysiaStatus) {
      return rule;
    }
    const task = yield* Effect.cached(
      Effect.gen(function* () {
        const result = yield* serviceExecute(rule);
        if (result instanceof ElysiaStatus && serviceCurrent(rule)) {
          serviceOptions.automation.recordFailure(id, rule.revision);
        }
        return result;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (serviceRuns.get(id) === task) {
              serviceRuns.delete(id);
            }
          })
        )
      )
    );
    serviceRuns.set(id, task);
    return yield* task;
  });
  const serviceExecute = Effect.fn("ReleaseAutomation.execute")(function* (rule: AutomationRule) {
    if (!serviceCurrent(rule)) {
      return serviceSnapshot();
    }
    const enabledSources = new Set(
      serviceOptions.plugins
        .snapshot()
        .filter((plugin) => plugin.enabled)
        .map((plugin) => plugin.id)
    );
    const activeSources = rule.sources.filter((source) => enabledSources.has(source));
    if (!activeSources.length) {
      return serviceSnapshot();
    }
    yield* serviceCompleteReplacements(rule);
    const result = yield* serviceAutomationDiscovery(rule);
    if (result instanceof ElysiaStatus) {
      return result;
    }
    if (!serviceCurrent(rule)) {
      return serviceSnapshot();
    }
    const prepared = yield* serviceOptions.automation.prepareIngestion({
      activeSources,
      candidates: result.releases.map((release) => ({ contentKey: contentKey(release), release })),
      errors: result.errors.map((error) => error.message),
      revision: rule.revision,
      ruleId: rule.id,
      torrentIds: serviceOptions.engine.snapshot(null, false).torrents.map((torrent) => torrent.id),
    });
    if (prepared instanceof ElysiaStatus) {
      return prepared;
    }
    if (!serviceCurrent(rule)) {
      return serviceSnapshot();
    }
    const written = serviceOptions.automation.db.transaction((tx) =>
      serviceOptions.automation.writeIngestion(tx, prepared)
    );
    if (written instanceof ElysiaStatus) {
      return written;
    }
    serviceOptions.automation.refreshState();
    // "adding" is the durable action journal: a crash leaves the decision retryable.
    for (const decision of serviceOptions.automation.decisionRecords()) {
      if (decision.automationId === rule.id && decision.status === "adding") {
        // serialize additions after the decisions commit.
        yield* serviceAddDecision(decision, rule);
      }
    }
    return serviceSnapshot();
  });
  const serviceCompleteReplacements = Effect.fn("ReleaseAutomation.completeReplacements")(
    function* (rule: AutomationRule) {
      const existing = serviceReplacements.get(rule.id);
      if (existing) {
        return yield* existing;
      }
      const task = yield* Effect.cached(
        serviceFinishReplacements(rule).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (serviceReplacements.get(rule.id) === task) {
                serviceReplacements.delete(rule.id);
              }
            })
          )
        )
      );
      serviceReplacements.set(rule.id, task);
      yield* task;
    }
  );
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceFinishReplacements = Effect.fn("ReleaseAutomation.finishReplacements")(function* (
    rule: AutomationRule
  ) {
    for (const decision of serviceOptions.automation.decisionRecords()) {
      if (
        decision.automationId !== rule.id ||
        decision.status !== "added" ||
        !decision.supersedes ||
        !serviceCurrent(rule)
      ) {
        continue;
      }
      const { torrents } = serviceOptions.engine.snapshot(null, false);
      const current = torrents.find((torrent) => torrent.id === decision.torrentId);
      if (current?.progress !== 1 || current.error) {
        continue;
      }
      const oldId = decision.supersedes.torrentId;
      const shared = [...serviceOptions.automation.decisionRecords()].some(
        (other) =>
          other.id !== decision.id &&
          (other.torrentId === oldId || other.supersedes?.torrentId === oldId)
      );
      if (
        oldId !== decision.torrentId &&
        !shared &&
        torrents.some((torrent) => torrent.id === oldId)
      ) {
        // finish each persisted replacement before the next.
        const removed = yield* Effect.promise(() =>
          serviceOptions.engine.call("remove", [oldId, rule.deleteReplacedFiles === true])
        );
        if (removed instanceof ElysiaStatus) {
          decision.status = "error";
          decision.reason = removed.response.detail;
          continue;
        }
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
      if (!serviceLifecycle.closed) {
        serviceOptions.automation.writeDecisionResult({
          decision,
          reason: decision.reason ?? "",
          revision: rule.revision,
          status: decision.status,
          supersedes: decision.supersedes,
          torrentId: decision.torrentId,
        });
      }
    }
  });
  const serviceAddDecision = Effect.fn("ReleaseAutomation.addDecision")(function* (
    decision: AutomationDecision,
    rule: AutomationRule
  ) {
    const pending = serviceAdditions.get(decision.id);
    if (pending) {
      return yield* pending;
    }
    const task = yield* Effect.cached(
      serviceExecuteAddition(decision, rule).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (serviceAdditions.get(decision.id) === task) {
              serviceAdditions.delete(decision.id);
            }
          })
        )
      )
    );
    serviceAdditions.set(decision.id, task);
    yield* task;
  });
  const serviceExecuteAddition = Effect.fn("ReleaseAutomation.executeAddition")(function* (
    decision: AutomationDecision,
    rule: AutomationRule
  ) {
    if (
      !(
        serviceCurrent(rule) &&
        rule.sources.includes(decision.release.sourceId) &&
        serviceOptions.plugins.plugin(decision.release.sourceId).enabled
      )
    ) {
      return;
    }
    const existing = serviceOptions.engine
      .snapshot(null, false)
      .torrents.find((item) => item.id === decision.release.infoHash);
    const torrent =
      existing ??
      (yield* serviceOptions.discovery.addRelease(
        decision.release.sourceId,
        decision.release.id,
        rule.destinationId,
        rule.paused,
        () =>
          serviceCurrent(rule) &&
          serviceOptions.automation
            .decisionRecords()
            .some(
              (current) =>
                current.id === decision.id &&
                current.status === "adding" &&
                current.release.id === decision.release.id &&
                current.release.sourceId === decision.release.sourceId
            )
      ));
    if (torrent instanceof ElysiaStatus) {
      decision.status = "error";
      decision.reason = torrent.response.detail;
    } else {
      decision.torrentId = torrent.id;
      decision.status = "added";
      if (existing) {
        decision.reason = "Already in the library";
      } else {
        decision.reason = decision.supersedes
          ? "Better version added · old version kept until the download completes"
          : "Added to the thread folder";
      }
    }
    if (!serviceLifecycle.closed) {
      serviceOptions.automation.writeDecisionResult({
        decision,
        reason: decision.reason,
        revision: rule.revision,
        status: decision.status,
        torrentId: decision.torrentId,
      });
    }
  });
  const serviceApprove = Effect.fn("ReleaseAutomation.approve")(function* (id: string) {
    const approved = serviceOptions.automation.approve(id);
    if (approved instanceof ElysiaStatus) {
      return approved;
    }
    const decision = serviceOptions.automation.decisionRecords().find((item) => item.id === id);
    if (!decision) {
      return problem(404, { detail: "Unknown release" });
    }
    if (decision.status === "added" || decision.status === "ignored") {
      return serviceSnapshot();
    }
    const owner = serviceOptions.automation.ruleSnapshot(decision.automationId);
    if (owner?.executorId && owner.executorId !== "tofu.releases") {
      return serviceSnapshot();
    }
    const rule = serviceRule(decision.automationId);
    if (rule instanceof ElysiaStatus) {
      return rule;
    }
    yield* serviceAddDecision(decision, rule);
    return serviceSnapshot();
  });
  const serviceStart = Effect.fn("ReleaseAutomation.start")(function* () {
    if (serviceLifecycle.started || serviceLifecycle.closed) {
      return;
    }
    serviceLifecycle.started = true;
    yield* Effect.all(
      serviceOptions.automation
        .snapshot()
        .automations.filter(
          (rule) => rule.enabled && (!rule.executorId || rule.executorId === "tofu.releases")
        )
        .map((rule) => serviceRun(rule.id)),
      { concurrency: "unbounded" }
    );
    if (serviceLifecycle.closed) {
      return;
    }
    const poll = serviceTick().pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) {
            return;
          }
          const log = createLogger({
            component: "automation",
            error: Cause.squash(cause),
            operation: "poll",
          });
          log.setLevel("error");
          log.emit();
        })
      )
    );
    serviceTimer = yield* Effect.forkIn(
      poll.pipe(
        Effect.repeat(Schedule.spaced("15 seconds")),
        Effect.delay("15 seconds"),
        Effect.asVoid
      ),
      scope
    );
  });
  const serviceTick = Effect.fn("ReleaseAutomation.tick")(function* () {
    if (serviceLifecycle.closed) {
      return;
    }
    yield* Effect.all(
      serviceOptions.automation
        .snapshot()
        .automations.filter(
          (rule) =>
            rule.enabled &&
            (!rule.executorId || rule.executorId === "tofu.releases") &&
            !serviceRuns.has(rule.id)
        )
        .map((rule) => serviceCompleteReplacements(rule)),
      { concurrency: "unbounded" }
    );
    yield* Effect.all(
      serviceOptions.automation
        .snapshot()
        .automations.filter(
          (rule) =>
            rule.enabled &&
            (!rule.executorId || rule.executorId === "tofu.releases") &&
            (rule.nextRunAt === null ||
              rule.nextRunAt <= serviceOptions.now() ||
              serviceOptions.automation
                .decisionRecords()
                .some(
                  (decision) =>
                    decision.automationId === rule.id &&
                    decision.status === "waiting" &&
                    decision.deadline !== null &&
                    decision.deadline <= serviceOptions.now()
                ))
        )
        .map((rule) => serviceRun(rule.id)),
      { concurrency: "unbounded" }
    );
  });
  const serviceClose = Effect.fn("ReleaseAutomation.close")(function* () {
    if (serviceLifecycle.closed) {
      return;
    }
    serviceLifecycle.closed = true;
    if (serviceTimer) {
      yield* Fiber.interrupt(serviceTimer);
      serviceTimer = null;
    }
    yield* Effect.all([...serviceRuns.values()].map(Effect.exit), { concurrency: "unbounded" });
    yield* Effect.all([...serviceReplacements.values()].map(Effect.exit), {
      concurrency: "unbounded",
    });
    yield* Effect.all([...serviceAdditions.values()].map(Effect.exit), {
      concurrency: "unbounded",
    });
  });

  yield* Effect.addFinalizer(() => serviceClose());
  return {
    approve: serviceApprove,
    close: serviceClose,
    prepareRule: servicePrepareRule,
    preview: servicePreview,
    run: serviceRun,
    save: serviceSave,
    snapshot: serviceSnapshot,
    start: serviceStart,
    tick: serviceTick,
    writeRule: serviceWriteRule,
  };
});

export type ReleaseAutomationService = ReleaseAutomation["Service"];
export class ReleaseAutomation extends Context.Service<
  ReleaseAutomation,
  {
    readonly snapshot: () => AutomationState;
    readonly prepareRule: (
      id: string | null,
      draft: AutomationDraft,
      ownership?: RuleOwnership
    ) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | MappingFailure
      | ReturnType<typeof problem<400, { readonly detail: "Pattern too long" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Invalid pattern" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Enter a title and at least one source" }>
        >
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | { baseline: AutomationDecision[]; expectedRevision: number | null; rule: AutomationRule }
      | ReturnType<typeof problem<400, { readonly detail: "Unknown release source" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Unknown destination" }>>
    >;
    readonly writeRule: (
      tx: DatabaseTransaction,
      prepared: PreparedRule
    ) =>
      | AutomationRule
      | ReturnType<typeof problem<400, { readonly detail: "Unknown destination" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Automation changed; reload the rule" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "This integration already owns a rule with that key" }
          >
        >;
    readonly save: (
      id: string | null,
      draft: AutomationDraft,
      ownership?: RuleOwnership
    ) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | MappingFailure
      | AutomationRule
      | ReturnType<typeof problem<400, { readonly detail: "Pattern too long" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Invalid pattern" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Enter a title and at least one source" }>
        >
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Unknown release source" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Unknown destination" }>>
    >;
    readonly preview: (draft: AutomationDraft) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | MappingFailure
      | {
          candidates: (
            | { release: FeedRelease; probability: null; reason: string | null; uncertain: boolean }
            | {
                release: FeedRelease;
                probability: number;
                reason: string | null;
                uncertain: boolean;
              }
          )[];
          releases: FeedRelease[];
          errors: { sourceId: SourcePluginId; message: string }[];
          search?: DiscoverySearch;
        }
    >;
    readonly run: (
      id: string
    ) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | MappingFailure
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | AutomationState
    >;
    readonly approve: (
      id: string
    ) => Effect.Effect<
      | AutomationState
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | ReturnType<
          typeof problem<409, { readonly detail: "This rule belongs to another executor" }>
        >
      | ReturnType<typeof problem<404, { readonly detail: "Unknown release" }>>
    >;
    readonly start: () => Effect.Effect<void>;
    readonly tick: () => Effect.Effect<void>;
    readonly close: () => Effect.Effect<void>;
  }
>()("tofu/release-automation") {}
export const releaseAutomationLayer = Layer.effect(ReleaseAutomation, make);
