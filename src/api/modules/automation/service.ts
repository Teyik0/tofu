import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Result } from "effect";
import { ElysiaStatus, problem } from "elysia";
import { automationDecisions, automationPreferences, automationRules } from "../../../db/schema";
import {
  Database,
  type DatabaseConnection,
  type DatabaseTransaction,
} from "../../lib/database-layer";
import { refreshRecords } from "../../lib/persisted-cache";
import type { FeedRelease } from "../discovery/model";
import {
  interpretationQuestions,
  Jev,
  type JevService,
  matchQuestions,
  safeReleaseState,
} from "../jev/service";
import type { SourcePluginId } from "../plugins/model";
import { publicRelease } from "../plugins/releases";
import type {
  AutomationDecision,
  AutomationDraft,
  AutomationPreferences,
  AutomationRule,
} from "./model";
import {
  compareQuality,
  compareReleases,
  defaultAutomationPreferences,
  interpretLocally,
  localMatch,
  preferred,
} from "./rules";

export interface AutomationOptions {
  jev: JevService;
  now: () => number;
}

export interface RuleOwnership {
  executorId?: string;
  key: string;
  ownerId: string;
}

export interface AutomationCandidateInput {
  contentKey: string;
  release: FeedRelease;
}

export interface IngestionInput {
  activeSources: SourcePluginId[];
  candidates: AutomationCandidateInput[];
  errors: string[];
  revision: number;
  ruleId: string;
  torrentIds: string[];
}

// The core persists decisions; integrations own discovery, scheduling and execution.
const make = Effect.gen(function* () {
  const db = yield* Database;
  const jev = yield* Jev;
  const options: AutomationOptions = { jev, now: Date.now };
  const serviceDb = db;
  const serviceOptions = options;

  const serviceRules = new Map<string, AutomationRule>();
  const serviceDecisions = new Map<string, AutomationDecision>();
  let servicePreferences: AutomationPreferences = defaultAutomationPreferences;
  function serviceSnapshot() {
    let historyCount = 0;
    return structuredClone({
      automations: [...serviceRules.values()],
      decisions: [...serviceDecisions.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .filter((decision) => {
          if (decision.status !== "added" && decision.status !== "ignored") {
            return true;
          }
          historyCount += 1;
          return historyCount <= 300;
        })
        .map((decision) => ({
          ...decision,
          release: publicRelease(decision.release),
          supersedes: decision.supersedes
            ? { ...decision.supersedes, release: publicRelease(decision.supersedes.release) }
            : null,
        })),
      preferences: servicePreferences,
      updatedAt: serviceOptions.now(),
    });
  }
  function serviceDecisionRecords() {
    return structuredClone([...serviceDecisions.values()]);
  }
  function serviceRuleSnapshot(id: string) {
    const rule = serviceRules.get(id);
    if (!rule) {
      return;
    }
    return structuredClone(rule);
  }
  function serviceWritePreferences(
    currentDb: DatabaseConnection,
    preferences: AutomationPreferences
  ) {
    const value = JSON.stringify(preferences);
    currentDb
      .insert(automationPreferences)
      .values({ id: "automation", value })
      .onConflictDoUpdate({ set: { value }, target: automationPreferences.id })
      .run();
    return preferences;
  }
  function serviceRefreshState() {
    const preferences = serviceDb
      .select()
      .from(automationPreferences)
      .where(eq(automationPreferences.id, "automation"))
      .get();
    servicePreferences = preferences
      ? {
          ...defaultAutomationPreferences,
          ...(JSON.parse(preferences.value) as Partial<AutomationPreferences>),
        }
      : defaultAutomationPreferences;
    refreshRecords(serviceRules, serviceDb.select().from(automationRules).all());
    for (const rule of serviceRules.values()) {
      rule.revision ??= 0;
    }
    refreshRecords(serviceDecisions, serviceDb.select().from(automationDecisions).all());
  }
  const serviceInterpret = Effect.fn("Automation.interpret")(function* (
    query: string,
    destinationId: string
  ) {
    const draft = interpretLocally(query, destinationId, servicePreferences);
    const interpretation = interpretationQuestions(draft);
    const result = yield* serviceOptions.jev.evaluate({ query }, interpretation.questions);
    if (result instanceof ElysiaStatus) {
      return result;
    }
    if (!result) {
      return draft;
    }
    const read = <T>(id: string, values: T[], fallback: T) => {
      const answer = result.answers[id];
      return answer?.confidence !== undefined && answer.confidence >= 0.8
        ? (values[Number(answer.choice)] ?? fallback)
        : fallback;
    };
    const languages = read("languages", interpretation.languages, draft.languages);
    const resolutions = read("resolutions", interpretation.resolutions, draft.resolutions);
    return {
      ...draft,
      // An omitted format inherits preferences; only an explicit unrestricted request clears it.
      languages: languages.length ? languages : draft.languages,
      matchMode: "jev" as const,
      priority: read("priority", interpretation.priorities, draft.priority),
      resolutions: resolutions.length ? resolutions : draft.resolutions,
      sources: read("sources", interpretation.orders, draft.sources),
      title: read("title", interpretation.titles, draft.title),
    };
  });
  const serviceEvaluate = Effect.fn("Automation.evaluate")(function* (
    draft: AutomationDraft,
    release: FeedRelease
  ) {
    const reason = localMatch(draft, release);
    if (reason) {
      return { probability: null, reason, uncertain: false };
    }
    if (draft.matchMode !== "jev") {
      return { probability: null, reason: null, uncertain: false };
    }
    const answer = yield* serviceOptions.jev.evaluate(
      { query: draft.query, release: safeReleaseState(release) },
      matchQuestions()
    );
    if (answer instanceof ElysiaStatus) {
      return answer;
    }
    if (!answer) {
      const fallback = localMatch({ ...draft, matchMode: "exact" }, release);
      return { probability: null, reason: fallback, uncertain: false };
    }
    const probability = Math.min(
      answer?.answers.identity?.noul ?? 0.5,
      answer?.answers.requirements?.noul ?? 0.5
    );
    return {
      probability,
      reason: probability < 0.75 ? "Jev match confidence below 75%" : null,
      uncertain: probability < 0.95,
    };
  });
  function servicePersistRule(rule: AutomationRule, connection?: DatabaseConnection) {
    const currentDb = connection ?? serviceDb;
    const value = JSON.stringify(rule);
    currentDb
      .insert(automationRules)
      .values({ id: rule.id, value })
      .onConflictDoUpdate({ set: { value }, target: automationRules.id })
      .run();
    if (!connection) {
      serviceRules.set(rule.id, rule);
    }
  }
  function serviceEnableRule(id: string, enabled: boolean, connection?: DatabaseConnection) {
    const rule = serviceRules.get(id);
    if (rule) {
      servicePersistRule(
        { ...rule, enabled, nextRunAt: serviceOptions.now(), revision: rule.revision + 1 },
        connection
      );
    }
  }
  function serviceReassignDestination(tx: DatabaseConnection, id: string) {
    for (const rule of serviceRules.values()) {
      if (rule.destinationId === id) {
        servicePersistRule({ ...rule, destinationId: "default", revision: rule.revision + 1 }, tx);
      }
    }
  }
  function servicePersistDecision(decision: AutomationDecision, connection?: DatabaseConnection) {
    const value = JSON.stringify(decision);
    const currentDb = connection ?? serviceDb;
    currentDb
      .insert(automationDecisions)
      .values({ id: decision.id, value })
      .onConflictDoUpdate({ set: { value }, target: automationDecisions.id })
      .run();
    if (!connection) {
      serviceDecisions.set(decision.id, decision);
    }
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const servicePrepareRule = Effect.fn("Automation.prepareRule")(function* (
    id: string | null,
    draft: AutomationDraft,
    baselineCandidates: AutomationCandidateInput[] = [],
    ownership?: RuleOwnership
  ) {
    const invalid = serviceValidateDraft(draft);
    if (invalid) {
      return invalid;
    }
    let previous = id ? (serviceRules.get(id) ?? null) : null;
    if (id && !previous) {
      return problem(404, { detail: "Unknown automation" });
    }
    if (!previous && ownership) {
      previous =
        [...serviceRules.values()].find(
          (item) => item.ownerId === ownership.ownerId && item.key === ownership.key
        ) ?? null;
    }
    if (
      previous?.ownerId &&
      previous.ownerId !== "tofu.manual" &&
      ownership &&
      (previous.ownerId !== ownership.ownerId || (previous.key && previous.key !== ownership.key))
    ) {
      return problem(409, { detail: "This rule belongs to another integration" });
    }
    const rule: AutomationRule = {
      ...draft,
      createdAt: previous?.createdAt ?? serviceOptions.now(),
      deleteReplacedFiles: draft.deleteReplacedFiles === true,
      error: null,
      executorId:
        ownership?.executorId ?? previous?.executorId ?? ownership?.ownerId ?? "tofu.releases",
      id: previous?.id ?? crypto.randomUUID(),
      key: ownership?.key ?? previous?.key,
      lastRunAt: previous?.lastRunAt ?? null,
      nextRunAt: serviceOptions.now(),
      ownerId: ownership?.ownerId ?? previous?.ownerId ?? "tofu.manual",
      revision: (previous?.revision ?? 0) + 1,
      status: "active",
    };
    const baseline =
      previous || draft.includeExisting
        ? []
        : yield* servicePrepareBaseline(rule, baselineCandidates);
    if (baseline instanceof ElysiaStatus) {
      return baseline;
    }
    return { baseline, expectedRevision: previous?.revision ?? null, rule };
  });
  function serviceValidateDraft(draft: AutomationDraft) {
    if (draft.matchMode === "pattern") {
      if (draft.title.length > 256) {
        return problem(400, { detail: "Pattern too long" });
      }
      const pattern = Effect.runSync(
        Effect.result(Effect.try(() => new RegExp(draft.title, "iu")))
      );
      if (Result.isFailure(pattern)) {
        return problem(400, { detail: "Invalid pattern" });
      }
    }
    if (!(draft.title.trim() && draft.sources.length)) {
      return problem(400, { detail: "Enter a title and at least one source" });
    }
    return null;
  }
  const servicePrepareBaseline = Effect.fn("Automation.prepareBaseline")(function* (
    rule: AutomationRule,
    candidates: AutomationCandidateInput[]
  ) {
    const baseline: AutomationDecision[] = [];
    for (const { release, contentKey } of candidates) {
      // evaluate each baseline before opening the write transaction.
      const evaluation = yield* serviceEvaluate(rule, release);
      if (evaluation instanceof ElysiaStatus) {
        return evaluation;
      }
      if (!(evaluation.reason || evaluation.uncertain)) {
        baseline.push({
          automationId: rule.id,
          contentKey,
          createdAt: serviceOptions.now(),
          deadline: null,
          id: `${rule.id}:${contentKey}`,
          probability: null,
          reason: "Present before the rule was enabled",
          release,
          status: "ignored",
          torrentId: null,
        });
      }
    }
    return baseline;
  });
  function serviceWriteRule(tx: DatabaseTransaction, prepared: PreparedRule) {
    const stored = tx
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, prepared.rule.id))
      .get();
    const revision = stored
      ? ((JSON.parse(stored.value) as Partial<AutomationRule>).revision ?? 0)
      : null;
    if (revision !== prepared.expectedRevision) {
      return problem(409, { detail: "Automation changed; reload the rule" });
    }
    if (prepared.rule.ownerId && prepared.rule.key) {
      const conflict = tx
        .select()
        .from(automationRules)
        .all()
        .some((row) => {
          const rule = JSON.parse(row.value) as AutomationRule;
          return (
            rule.id !== prepared.rule.id &&
            rule.ownerId === prepared.rule.ownerId &&
            rule.key === prepared.rule.key
          );
        });
      if (conflict) {
        return problem(409, { detail: "This integration already owns a rule with that key" });
      }
    }
    for (const decision of prepared.baseline) {
      servicePersistDecision(decision, tx);
    }
    servicePersistRule(prepared.rule, tx);
    return prepared.rule;
  }
  function serviceDeleteRule(tx: DatabaseConnection, id: string) {
    if (!serviceRules.has(id)) {
      return problem(404, { detail: "Unknown automation" });
    }
    for (const row of tx.select().from(automationDecisions).all()) {
      const decision = JSON.parse(row.value) as AutomationDecision;
      if (
        decision.automationId === id &&
        decision.status !== "added" &&
        decision.status !== "ignored"
      ) {
        servicePersistDecision(
          { ...decision, reason: "Automation deleted", status: "ignored" },
          tx
        );
      }
    }
    tx.delete(automationRules).where(eq(automationRules.id, id)).run();
    return { ok: true };
  }
  const servicePrepareIngestion = Effect.fn("Automation.prepareIngestion")(function* (
    input: IngestionInput
  ) {
    const rule = serviceRules.get(input.ruleId);
    if (!rule) {
      return problem(404, { detail: "Unknown automation" });
    }
    if (!rule.enabled || rule.revision !== input.revision) {
      return problem(409, { detail: "Automation changed; discard collected releases" });
    }
    const candidates = yield* serviceCandidateGroups(rule, input);
    if (candidates instanceof ElysiaStatus) {
      return candidates;
    }
    const { groups, evaluations } = candidates;
    const decisions: AutomationDecision[] = [];
    for (const [key, releases] of groups) {
      const decision = serviceChoose(rule, key, releases, evaluations);
      if (decision) {
        decisions.push(decision);
      }
    }
    return { decisions, errors: input.errors, revision: input.revision, ruleId: rule.id };
  });
  function serviceWriteIngestion(tx: DatabaseTransaction, prepared: PreparedIngestion) {
    const ruleRow = tx
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, prepared.ruleId))
      .get();
    const rule = ruleRow ? ({ revision: 0, ...JSON.parse(ruleRow.value) } as AutomationRule) : null;
    if (!rule?.enabled || rule.revision !== prepared.revision) {
      return problem(409, { detail: "Automation changed; discard prepared decisions" });
    }
    for (const decision of prepared.decisions) {
      const row = tx
        .select()
        .from(automationDecisions)
        .where(eq(automationDecisions.id, decision.id))
        .get();
      const existing = row ? (JSON.parse(row.value) as AutomationDecision) : null;
      if (existing?.status === "ignored") {
        continue;
      }
      if (
        existing?.status === "added" &&
        (!decision.supersedes || existing.torrentId !== decision.supersedes.torrentId)
      ) {
        continue;
      }
      servicePersistDecision(decision, tx);
    }
    rule.lastRunAt = serviceOptions.now();
    rule.nextRunAt = rule.lastRunAt + rule.intervalMinutes * 60_000;
    rule.error = prepared.errors.length ? prepared.errors.join(" · ") : null;
    servicePersistRule(rule, tx);
    return { ruleId: rule.id };
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceCandidateGroups = Effect.fn("Automation.candidateGroups")(function* (
    rule: AutomationRule,
    input: IngestionInput
  ) {
    const candidates = new Map(
      input.candidates
        .filter(
          ({ release }) =>
            input.activeSources.includes(release.sourceId) &&
            rule.sources.includes(release.sourceId)
        )
        .map((candidate) => [`${candidate.release.sourceId}:${candidate.release.id}`, candidate])
    );
    for (const decision of serviceDecisions.values()) {
      if (
        decision.automationId === rule.id &&
        ["waiting", "adding", "error"].includes(decision.status) &&
        input.activeSources.includes(decision.release.sourceId) &&
        rule.sources.includes(decision.release.sourceId)
      ) {
        candidates.set(`${decision.release.sourceId}:${decision.release.id}`, {
          contentKey: decision.contentKey,
          release: decision.release,
        });
      }
    }
    const groups = new Map<string, FeedRelease[]>();
    const evaluations = new Map<string, Evaluation>();
    const handledHashes = new Set(
      [...serviceDecisions.values()]
        .filter((decision) => decision.status === "added")
        .map((decision) => decision.torrentId)
    );
    const torrentIds = new Set(input.torrentIds);
    for (const [key, { release, contentKey }] of candidates) {
      const previous = serviceDecisions.get(`${rule.id}:${contentKey}`);
      const current = previous?.status === "added" ? previous : previous?.supersedes;
      if (
        (previous?.status === "added" && previous.supersedes) ||
        previous?.status === "ignored" ||
        (current &&
          (!(current.torrentId && torrentIds.has(current.torrentId)) ||
            preferred(rule, current.release) ||
            compareQuality(rule, release, current.release) >= 0)) ||
        (release.infoHash !== null && handledHashes.has(release.infoHash))
      ) {
        continue;
      }
      // charge the quota before evaluating each candidate; stop on provider failure.
      const evaluation = yield* serviceEvaluate(rule, release);
      if (evaluation instanceof ElysiaStatus) {
        return evaluation;
      }
      if (evaluation.reason) {
        continue;
      }
      evaluations.set(key, evaluation);
      const group = groups.get(contentKey) ?? [];
      group.push(release);
      groups.set(contentKey, group);
    }
    return { evaluations, groups };
  });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  function serviceChoose(
    rule: AutomationRule,
    key: string,
    releases: FeedRelease[],
    evaluations: Map<string, Evaluation>
  ) {
    const id = `${rule.id}:${key}`;
    const previous = serviceDecisions.get(id);
    const [release] = releases.sort((a, b) => compareReleases(rule, a, b));
    if (
      !release ||
      (previous && previous.status === "ignored") ||
      serviceRules.get(rule.id)?.revision !== rule.revision
    ) {
      return null;
    }
    const evaluation = evaluations.get(`${release.sourceId}:${release.id}`);
    const deadline = previous?.deadline ?? serviceOptions.now() + rule.waitMinutes * 60_000;
    const approved =
      previous?.approved === true &&
      previous.release.id === release.id &&
      previous.release.sourceId === release.sourceId;
    let status: AutomationDecision["status"] = "adding";
    if (!approved && (!rule.automatic || evaluation?.uncertain)) {
      status = "review";
    } else if (!(approved || preferred(rule, release)) && serviceOptions.now() < deadline) {
      status = "waiting";
    }
    return {
      approved,
      automationId: rule.id,
      contentKey: key,
      createdAt: previous?.createdAt ?? serviceOptions.now(),
      deadline,
      id,
      probability: evaluation?.probability ?? null,
      reason: evaluation?.uncertain
        ? "Uncertain Jev match — review required"
        : "Title and formats accepted · ranked by priority",
      release,
      status,
      supersedes:
        previous?.status === "added" && previous.torrentId
          ? { release: previous.release, torrentId: previous.torrentId }
          : (previous?.supersedes ?? null),
      torrentId: null,
    } satisfies AutomationDecision;
  }
  function serviceApprove(id: string) {
    const decision = serviceDecisions.get(id);
    if (!decision) {
      return problem(404, { detail: "Unknown release" });
    }
    if (decision.status !== "added" && decision.status !== "ignored") {
      servicePersistDecision({
        ...decision,
        approved: true,
        reason: "Approved manually",
        status: "adding",
      });
    }
    return serviceSnapshot();
  }
  function serviceWriteDecisionResult(input: {
    decision: AutomationDecision;
    revision: number;
    status: AutomationDecision["status"];
    torrentId: string | null;
    reason: string;
    supersedes?: AutomationDecision["supersedes"];
  }) {
    const rule = serviceRules.get(input.decision.automationId);
    const current = serviceDecisions.get(input.decision.id);
    if (
      !rule?.enabled ||
      rule.revision !== input.revision ||
      !current ||
      current.status === "ignored" ||
      current.release.id !== input.decision.release.id ||
      current.release.sourceId !== input.decision.release.sourceId
    ) {
      return false;
    }
    servicePersistDecision({
      ...current,
      reason: input.reason,
      status: input.status,
      supersedes: input.supersedes === undefined ? current.supersedes : input.supersedes,
      torrentId: input.torrentId,
    });
    return true;
  }
  function serviceRecordFailure(id: string, revision: number) {
    const rule = serviceRules.get(id);
    if (rule?.revision === revision) {
      servicePersistRule({
        ...rule,
        error: "Check interrupted; retry scheduled",
        nextRunAt: serviceOptions.now() + 60_000,
      });
    }
  }
  function serviceIgnoreDecision(tx: DatabaseConnection, id: string) {
    const decision = serviceDecisions.get(id);
    if (!decision) {
      return problem(404, { detail: "Unknown release" });
    }
    servicePersistDecision({ ...decision, reason: "Ignored manually", status: "ignored" }, tx);
    return { ok: true };
  }
  const storedPreferences = serviceDb
    .select()
    .from(automationPreferences)
    .where(eq(automationPreferences.id, "automation"))
    .get();
  if (storedPreferences) {
    servicePreferences = {
      ...defaultAutomationPreferences,
      ...(JSON.parse(storedPreferences.value) as Partial<AutomationPreferences>),
    };
  }
  for (const row of serviceDb.select().from(automationRules).all()) {
    const rule = { revision: 0, ...JSON.parse(row.value) } as AutomationRule;
    serviceRules.set(rule.id, rule);
  }
  for (const row of serviceDb.select().from(automationDecisions).all()) {
    const decision = JSON.parse(row.value) as AutomationDecision;
    serviceDecisions.set(decision.id, decision);
  }

  return {
    approve: serviceApprove,
    db,
    decisionRecords: serviceDecisionRecords,
    deleteRule: serviceDeleteRule,
    enableRule: serviceEnableRule,
    evaluate: serviceEvaluate,
    ignoreDecision: serviceIgnoreDecision,
    interpret: serviceInterpret,
    prepareIngestion: servicePrepareIngestion,
    prepareRule: servicePrepareRule,
    reassignDestination: serviceReassignDestination,
    recordFailure: serviceRecordFailure,
    refreshState: serviceRefreshState,
    ruleSnapshot: serviceRuleSnapshot,
    snapshot: serviceSnapshot,
    writeDecisionResult: serviceWriteDecisionResult,
    writeIngestion: serviceWriteIngestion,
    writePreferences: serviceWritePreferences,
    writeRule: serviceWriteRule,
  };
});

export type AutomationService = Automation["Service"];
export class Automation extends Context.Service<
  Automation,
  {
    readonly snapshot: () => {
      automations: AutomationRule[];
      decisions: {
        release: FeedRelease;
        supersedes: { release: FeedRelease; torrentId: string } | null;
        approved?: boolean;
        automationId: string;
        contentKey: string;
        createdAt: number;
        deadline: number | null;
        id: string;
        probability: number | null;
        reason: string;
        status: "waiting" | "review" | "adding" | "added" | "ignored" | "error";
        torrentId: string | null;
      }[];
      preferences: {
        automatic: boolean;
        codecs: string[];
        deleteReplacedFiles: boolean;
        excludePacks: boolean;
        intervalMinutes: number;
        languages: ("VF" | "VOSTFR" | "MULTI")[];
        paused: boolean;
        priority: ("source" | "language" | "resolution" | "codec")[];
        resolutions: string[];
        sources: string[];
        waitMinutes: number;
      };
      updatedAt: number;
    };
    readonly decisionRecords: () => AutomationDecision[];
    readonly ruleSnapshot: (id: string) => AutomationRule | undefined;
    readonly writePreferences: (
      db: DatabaseConnection,
      preferences: AutomationPreferences
    ) => {
      automatic: boolean;
      codecs: string[];
      deleteReplacedFiles: boolean;
      excludePacks: boolean;
      intervalMinutes: number;
      languages: ("VF" | "VOSTFR" | "MULTI")[];
      paused: boolean;
      priority: ("source" | "language" | "resolution" | "codec")[];
      resolutions: string[];
      sources: string[];
      waitMinutes: number;
    };
    readonly refreshState: () => void;
    readonly interpret: (
      query: string,
      destinationId: string
    ) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | {
          afterEpisode?: number | undefined;
          aliases?: string[] | undefined;
          automatic: boolean;
          codecs: string[];
          deleteReplacedFiles?: boolean | undefined;
          destinationId: string;
          enabled: boolean;
          excludePacks: boolean;
          includeExisting: boolean;
          intervalMinutes: number;
          languages: ("VF" | "VOSTFR" | "MULTI")[];
          matchMode: "jev" | "exact" | "pattern";
          paused: boolean;
          priority: ("source" | "language" | "resolution" | "codec")[];
          query: string;
          resolutions: string[];
          season: number | null;
          sources: string[];
          title: string;
          waitMinutes: number;
        }
    >;
    readonly evaluate: (
      draft: AutomationDraft,
      release: FeedRelease
    ) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | { probability: null; reason: string | null; uncertain: boolean }
      | { probability: number; reason: string | null; uncertain: boolean }
    >;
    readonly enableRule: (id: string, enabled: boolean, connection?: DatabaseConnection) => void;
    readonly reassignDestination: (tx: DatabaseConnection, id: string) => void;
    readonly prepareRule: (
      id: string | null,
      draft: AutomationDraft,
      baselineCandidates?: AutomationCandidateInput[],
      ownership?: RuleOwnership
    ) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | ReturnType<typeof problem<400, { readonly detail: "Pattern too long" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Invalid pattern" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Enter a title and at least one source" }>
        >
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | { baseline: AutomationDecision[]; expectedRevision: number | null; rule: AutomationRule }
    >;
    readonly writeRule: (
      tx: DatabaseTransaction,
      prepared: PreparedRule
    ) =>
      | AutomationRule
      | ReturnType<typeof problem<409, { readonly detail: "Automation changed; reload the rule" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "This integration already owns a rule with that key" }
          >
        >;
    readonly deleteRule: (
      tx: DatabaseConnection,
      id: string
    ) =>
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | { ok: boolean };
    readonly prepareIngestion: (
      input: IngestionInput
    ) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | { decisions: AutomationDecision[]; errors: string[]; revision: number; ruleId: string }
    >;
    readonly writeIngestion: (
      tx: DatabaseTransaction,
      prepared: PreparedIngestion
    ) =>
      | ReturnType<
          typeof problem<409, { readonly detail: "Automation changed; discard prepared decisions" }>
        >
      | { ruleId: string };
    readonly approve: (id: string) =>
      | {
          automations: AutomationRule[];
          decisions: {
            release: FeedRelease;
            supersedes: { release: FeedRelease; torrentId: string } | null;
            approved?: boolean;
            automationId: string;
            contentKey: string;
            createdAt: number;
            deadline: number | null;
            id: string;
            probability: number | null;
            reason: string;
            status: "waiting" | "review" | "adding" | "added" | "ignored" | "error";
            torrentId: string | null;
          }[];
          preferences: {
            automatic: boolean;
            codecs: string[];
            deleteReplacedFiles: boolean;
            excludePacks: boolean;
            intervalMinutes: number;
            languages: ("VF" | "VOSTFR" | "MULTI")[];
            paused: boolean;
            priority: ("source" | "language" | "resolution" | "codec")[];
            resolutions: string[];
            sources: string[];
            waitMinutes: number;
          };
          updatedAt: number;
        }
      | ReturnType<typeof problem<404, { readonly detail: "Unknown release" }>>;
    readonly writeDecisionResult: (input: {
      decision: AutomationDecision;
      revision: number;
      status: AutomationDecision["status"];
      torrentId: string | null;
      reason: string;
      supersedes?: AutomationDecision["supersedes"];
    }) => boolean;
    readonly recordFailure: (id: string, revision: number) => void;
    readonly ignoreDecision: (
      tx: DatabaseConnection,
      id: string
    ) => ReturnType<typeof problem<404, { readonly detail: "Unknown release" }>> | { ok: boolean };
    readonly db: Database["Service"];
  }
>()("tofu/automation") {}
export const automationLayer = Layer.effect(Automation, make);

// Successful results, narrowed structurally because ElysiaStatus generics are invariant.
type Evaluation = Extract<
  Effect.Success<ReturnType<AutomationService["evaluate"]>>,
  { uncertain: boolean }
>;
export interface PreparedRule {
  baseline: AutomationDecision[];
  expectedRevision: number | null;
  rule: AutomationRule;
}
interface PreparedIngestion {
  decisions: AutomationDecision[];
  errors: string[];
  revision: number;
  ruleId: string;
}
