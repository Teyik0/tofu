import { eq } from "drizzle-orm";
import { HTTPError } from "elysia";
import { automationDecisions, automationPreferences, automationRules } from "../../../db/schema";
import type {
  AutomationDecision,
  AutomationDraft,
  AutomationPreferences,
  AutomationRule,
  FeedRelease,
  SourcePluginId,
} from "../../../types";
import type { DatabaseConnection, DatabaseTransaction, TofuDatabase } from "../../lib/db";
import { refreshRecords } from "../../lib/persisted-cache";
import {
  interpretationQuestions,
  type JevService,
  matchQuestions,
  safeReleaseState,
} from "../jev/service";
import { publicRelease } from "../plugins/releases";
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
export class AutomationService {
  readonly db: TofuDatabase;
  private readonly rules = new Map<string, AutomationRule>();
  private readonly decisions = new Map<string, AutomationDecision>();
  private preferences: AutomationPreferences = defaultAutomationPreferences;
  private readonly options: AutomationOptions;
  constructor(db: TofuDatabase, options: AutomationOptions) {
    this.options = options;
    this.db = db;
    const storedPreferences = this.db
      .select()
      .from(automationPreferences)
      .where(eq(automationPreferences.id, "automation"))
      .get();
    if (storedPreferences) {
      this.preferences = {
        ...defaultAutomationPreferences,
        ...(JSON.parse(storedPreferences.value) as Partial<AutomationPreferences>),
      };
    }
    for (const row of this.db.select().from(automationRules).all()) {
      const rule = { revision: 0, ...JSON.parse(row.value) } as AutomationRule;
      this.rules.set(rule.id, rule);
    }
    for (const row of this.db.select().from(automationDecisions).all()) {
      const decision = JSON.parse(row.value) as AutomationDecision;
      this.decisions.set(decision.id, decision);
    }
  }

  snapshot() {
    let historyCount = 0;
    return structuredClone({
      automations: [...this.rules.values()],
      decisions: [...this.decisions.values()]
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
      preferences: this.preferences,
      updatedAt: this.options.now(),
    });
  }
  decisionRecords() {
    return structuredClone([...this.decisions.values()]);
  }
  ruleSnapshot(id: string) {
    const rule = this.rules.get(id);
    if (!rule) {
      return;
    }
    return structuredClone(rule);
  }
  writePreferences(db: DatabaseConnection, preferences: AutomationPreferences) {
    const value = JSON.stringify(preferences);
    db.insert(automationPreferences)
      .values({ id: "automation", value })
      .onConflictDoUpdate({ set: { value }, target: automationPreferences.id })
      .run();
    return preferences;
  }
  refreshState() {
    const preferences = this.db
      .select()
      .from(automationPreferences)
      .where(eq(automationPreferences.id, "automation"))
      .get();
    this.preferences = preferences
      ? {
          ...defaultAutomationPreferences,
          ...(JSON.parse(preferences.value) as Partial<AutomationPreferences>),
        }
      : defaultAutomationPreferences;
    refreshRecords(this.rules, this.db.select().from(automationRules).all());
    for (const rule of this.rules.values()) {
      rule.revision ??= 0;
    }
    refreshRecords(this.decisions, this.db.select().from(automationDecisions).all());
  }
  async interpret(query: string, destinationId: string): Promise<AutomationDraft> {
    const draft = interpretLocally(query, destinationId, this.preferences);
    const interpretation = interpretationQuestions(draft);
    const result = await this.options.jev.evaluate({ query }, interpretation.questions);
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
  }

  async evaluate(draft: AutomationDraft, release: FeedRelease) {
    const reason = localMatch(draft, release);
    if (reason) {
      return { probability: null, reason, uncertain: false };
    }
    if (draft.matchMode !== "jev") {
      return { probability: null, reason: null, uncertain: false };
    }
    const answer = await this.options.jev.evaluate(
      { query: draft.query, release: safeReleaseState(release) },
      matchQuestions()
    );
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
  }

  private persistRule(rule: AutomationRule, connection?: DatabaseConnection) {
    const db = connection ?? this.db;
    const value = JSON.stringify(rule);
    db.insert(automationRules)
      .values({ id: rule.id, value })
      .onConflictDoUpdate({ set: { value }, target: automationRules.id })
      .run();
    if (!connection) {
      this.rules.set(rule.id, rule);
    }
  }
  enableRule(id: string, enabled: boolean, connection?: DatabaseConnection) {
    const rule = this.rules.get(id);
    if (rule) {
      this.persistRule(
        { ...rule, enabled, nextRunAt: this.options.now(), revision: rule.revision + 1 },
        connection
      );
    }
  }
  reassignDestination(tx: DatabaseConnection, id: string) {
    for (const rule of this.rules.values()) {
      if (rule.destinationId === id) {
        this.persistRule({ ...rule, destinationId: "default", revision: rule.revision + 1 }, tx);
      }
    }
  }
  private persistDecision(decision: AutomationDecision, connection?: DatabaseConnection) {
    const value = JSON.stringify(decision);
    const db = connection ?? this.db;
    db.insert(automationDecisions)
      .values({ id: decision.id, value })
      .onConflictDoUpdate({ set: { value }, target: automationDecisions.id })
      .run();
    if (!connection) {
      this.decisions.set(decision.id, decision);
    }
  }
  private rule(id: string) {
    const rule = this.rules.get(id);
    if (!rule) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown automation");
    }
    return rule;
  }

  async prepareRule(
    id: string | null,
    draft: AutomationDraft,
    baselineCandidates: AutomationCandidateInput[] = [],
    ownership?: RuleOwnership
  ) {
    this.validateDraft(draft);
    let previous = id ? this.rule(id) : null;
    if (!previous && ownership) {
      previous =
        [...this.rules.values()].find(
          (item) => item.ownerId === ownership.ownerId && item.key === ownership.key
        ) ?? null;
    }
    if (
      previous?.ownerId &&
      previous.ownerId !== "tofu.manual" &&
      ownership &&
      (previous.ownerId !== ownership.ownerId || (previous.key && previous.key !== ownership.key))
    ) {
      throw new (HTTPError.id("CONFLICT", 409))("This rule belongs to another integration");
    }
    const rule: AutomationRule = {
      ...draft,
      createdAt: previous?.createdAt ?? this.options.now(),
      deleteReplacedFiles: draft.deleteReplacedFiles === true,
      error: null,
      executorId:
        ownership?.executorId ?? previous?.executorId ?? ownership?.ownerId ?? "tofu.releases",
      id: previous?.id ?? crypto.randomUUID(),
      key: ownership?.key ?? previous?.key,
      lastRunAt: previous?.lastRunAt ?? null,
      nextRunAt: this.options.now(),
      ownerId: ownership?.ownerId ?? previous?.ownerId ?? "tofu.manual",
      revision: (previous?.revision ?? 0) + 1,
      status: "active",
    };
    const baseline =
      previous || draft.includeExisting ? [] : await this.prepareBaseline(rule, baselineCandidates);
    return { baseline, expectedRevision: previous?.revision ?? null, rule };
  }
  private validateDraft(draft: AutomationDraft) {
    if (draft.matchMode === "pattern") {
      if (draft.title.length > 256) {
        throw new (HTTPError.id("BAD_REQUEST", 400))("Pattern too long");
      }
      try {
        new RegExp(draft.title, "iu").test("");
      } catch (cause) {
        throw new (HTTPError.id("BAD_REQUEST", 400))("Invalid pattern", { cause });
      }
    }
    if (!(draft.title.trim() && draft.sources.length)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Enter a title and at least one source");
    }
  }
  private async prepareBaseline(rule: AutomationRule, candidates: AutomationCandidateInput[]) {
    const baseline: AutomationDecision[] = [];
    for (const { release, contentKey } of candidates) {
      // biome-ignore lint/performance/noAwaitInLoops: evaluate each baseline before opening the write transaction.
      const evaluation = await this.evaluate(rule, release);
      if (!(evaluation.reason || evaluation.uncertain)) {
        baseline.push({
          automationId: rule.id,
          contentKey,
          createdAt: this.options.now(),
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
  }
  writeRule(
    tx: DatabaseTransaction,
    prepared: Awaited<ReturnType<AutomationService["prepareRule"]>>
  ) {
    const stored = tx
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, prepared.rule.id))
      .get();
    const revision = stored
      ? ((JSON.parse(stored.value) as Partial<AutomationRule>).revision ?? 0)
      : null;
    if (revision !== prepared.expectedRevision) {
      throw new (HTTPError.id("CONFLICT", 409))("Automation changed; reload the rule");
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
        throw new (HTTPError.id("CONFLICT", 409))(
          "This integration already owns a rule with that key"
        );
      }
    }
    for (const decision of prepared.baseline) {
      this.persistDecision(decision, tx);
    }
    this.persistRule(prepared.rule, tx);
    return prepared.rule;
  }
  deleteRule(tx: DatabaseConnection, id: string) {
    this.rule(id);
    for (const row of tx.select().from(automationDecisions).all()) {
      const decision = JSON.parse(row.value) as AutomationDecision;
      if (
        decision.automationId === id &&
        decision.status !== "added" &&
        decision.status !== "ignored"
      ) {
        this.persistDecision({ ...decision, reason: "Automation deleted", status: "ignored" }, tx);
      }
    }
    tx.delete(automationRules).where(eq(automationRules.id, id)).run();
    return { ok: true };
  }

  async prepareIngestion(input: IngestionInput) {
    const rule = this.rule(input.ruleId);
    if (!rule.enabled || rule.revision !== input.revision) {
      throw new (HTTPError.id("CONFLICT", 409))("Automation changed; discard collected releases");
    }
    const { groups, evaluations } = await this.candidateGroups(rule, input);
    const decisions: AutomationDecision[] = [];
    for (const [key, releases] of groups) {
      const decision = this.choose(rule, key, releases, evaluations);
      if (decision) {
        decisions.push(decision);
      }
    }
    return { decisions, errors: input.errors, revision: input.revision, ruleId: rule.id };
  }
  writeIngestion(
    tx: DatabaseTransaction,
    prepared: Awaited<ReturnType<AutomationService["prepareIngestion"]>>
  ) {
    const ruleRow = tx
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, prepared.ruleId))
      .get();
    const rule = ruleRow ? ({ revision: 0, ...JSON.parse(ruleRow.value) } as AutomationRule) : null;
    if (!rule?.enabled || rule.revision !== prepared.revision) {
      throw new (HTTPError.id("CONFLICT", 409))("Automation changed; discard prepared decisions");
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
      this.persistDecision(decision, tx);
    }
    rule.lastRunAt = this.options.now();
    rule.nextRunAt = rule.lastRunAt + rule.intervalMinutes * 60_000;
    rule.error = prepared.errors.length ? prepared.errors.join(" · ") : null;
    this.persistRule(rule, tx);
    return { ruleId: rule.id };
  }
  private async candidateGroups(rule: AutomationRule, input: IngestionInput) {
    const candidates = new Map(
      input.candidates
        .filter(
          ({ release }) =>
            input.activeSources.includes(release.sourceId) &&
            rule.sources.includes(release.sourceId)
        )
        .map((candidate) => [`${candidate.release.sourceId}:${candidate.release.id}`, candidate])
    );
    for (const decision of this.decisions.values()) {
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
    const evaluations = new Map<string, Awaited<ReturnType<AutomationService["evaluate"]>>>();
    const handledHashes = new Set(
      [...this.decisions.values()]
        .filter((decision) => decision.status === "added")
        .map((decision) => decision.torrentId)
    );
    const torrentIds = new Set(input.torrentIds);
    for (const [key, { release, contentKey }] of candidates) {
      const previous = this.decisions.get(`${rule.id}:${contentKey}`);
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
      // biome-ignore lint/performance/noAwaitInLoops: charge the quota before evaluating each candidate; stop on provider failure.
      const evaluation = await this.evaluate(rule, release);
      if (evaluation.reason) {
        continue;
      }
      evaluations.set(key, evaluation);
      const group = groups.get(contentKey) ?? [];
      group.push(release);
      groups.set(contentKey, group);
    }
    return { evaluations, groups };
  }
  private choose(
    rule: AutomationRule,
    key: string,
    releases: FeedRelease[],
    evaluations: Map<string, Awaited<ReturnType<AutomationService["evaluate"]>>>
  ) {
    const id = `${rule.id}:${key}`;
    const previous = this.decisions.get(id);
    const [release] = releases.sort((a, b) => compareReleases(rule, a, b));
    if (
      !release ||
      (previous && previous.status === "ignored") ||
      this.rules.get(rule.id)?.revision !== rule.revision
    ) {
      return null;
    }
    const evaluation = evaluations.get(`${release.sourceId}:${release.id}`);
    const deadline = previous?.deadline ?? this.options.now() + rule.waitMinutes * 60_000;
    const approved =
      previous?.approved === true &&
      previous.release.id === release.id &&
      previous.release.sourceId === release.sourceId;
    let status: AutomationDecision["status"] = "adding";
    if (!approved && (!rule.automatic || evaluation?.uncertain)) {
      status = "review";
    } else if (!(approved || preferred(rule, release)) && this.options.now() < deadline) {
      status = "waiting";
    }
    return {
      approved,
      automationId: rule.id,
      contentKey: key,
      createdAt: previous?.createdAt ?? this.options.now(),
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

  approve(id: string) {
    const decision = this.decisions.get(id);
    if (!decision) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown release");
    }
    if (decision.status !== "added" && decision.status !== "ignored") {
      this.persistDecision({
        ...decision,
        approved: true,
        reason: "Approved manually",
        status: "adding",
      });
    }
    return this.snapshot();
  }
  writeDecisionResult(input: {
    decision: AutomationDecision;
    revision: number;
    status: AutomationDecision["status"];
    torrentId: string | null;
    reason: string;
    supersedes?: AutomationDecision["supersedes"];
  }) {
    const rule = this.rules.get(input.decision.automationId);
    const current = this.decisions.get(input.decision.id);
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
    this.persistDecision({
      ...current,
      reason: input.reason,
      status: input.status,
      supersedes: input.supersedes === undefined ? current.supersedes : input.supersedes,
      torrentId: input.torrentId,
    });
    return true;
  }
  recordFailure(id: string, revision: number) {
    const rule = this.rules.get(id);
    if (rule?.revision === revision) {
      this.persistRule({
        ...rule,
        error: "Check interrupted; retry scheduled",
        nextRunAt: this.options.now() + 60_000,
      });
    }
  }
  ignoreDecision(tx: DatabaseConnection, id: string) {
    const decision = this.decisions.get(id);
    if (!decision) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown release");
    }
    this.persistDecision({ ...decision, reason: "Ignored manually", status: "ignored" }, tx);
    return { ok: true };
  }
}
