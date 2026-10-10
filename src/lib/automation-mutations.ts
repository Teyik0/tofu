import type {
  AutomationDraft,
  AutomationPreferences,
  AutomationRule,
  AutomationState,
} from "../types";
import { readData } from "./api-data";
import type { api } from "./client";

function ruleStatus(draft: AutomationDraft, state: AutomationState): AutomationRule["status"] {
  if (!draft.enabled) {
    return "paused";
  }
  return state.plugins.some(
    (plugin) => plugin.enabled && draft.sources.some((id) => id === plugin.id)
  )
    ? "active"
    : "source-disabled";
}

export function createAutomationMutations(client: typeof api) {
  return {
    createRule: (draft: AutomationDraft) => {
      const id = `pending:${crypto.randomUUID()}`;
      const createdAt = Date.now();
      return client.automations.post(draft, {
        optimistic(cache) {
          cache.update(client.automation.get, (state) => {
            if (!("automations" in state)) {
              return state;
            }
            const rule: AutomationRule = {
              ...draft,
              createdAt,
              deleteReplacedFiles: draft.deleteReplacedFiles === true,
              error: null,
              id,
              lastRunAt: null,
              nextRunAt: null,
              status: ruleStatus(draft, state),
            };
            return { ...state, automations: [...state.automations, rule] };
          });
        },
      });
    },
    deleteRule: (id: string) =>
      client.automations({ id }).delete(undefined, {
        optimistic(cache) {
          cache.update(client.automation.get, (state) =>
            "automations" in state
              ? { ...state, automations: state.automations.filter((rule) => rule.id !== id) }
              : state
          );
        },
      }),
    ignoreDecision: (id: string) =>
      client["automation-decisions"]({ id }).ignore.post(undefined, {
        optimistic(cache) {
          cache.update(client.automation.get, (state) =>
            "decisions" in state
              ? {
                  ...state,
                  decisions: state.decisions.map((decision) =>
                    decision.id === id
                      ? { ...decision, reason: "Ignored manually", status: "ignored" as const }
                      : decision
                  ),
                }
              : state
          );
        },
      }),
    savePreferences: async (preferences: AutomationPreferences) => {
      const result = await client.automation.preferences.put(preferences, {
        optimistic(cache) {
          cache.update(client.automation.get, (state) =>
            "preferences" in state ? { ...state, preferences } : state
          );
        },
      });
      if (result.error === null) {
        readData(await client.automation.get());
      }
      return result;
    },
    updateRule: (id: string, draft: AutomationDraft) =>
      client.automations({ id }).put(draft, {
        optimistic(cache) {
          cache.update(client.automation.get, (state) =>
            "automations" in state
              ? {
                  ...state,
                  automations: state.automations.map((rule) =>
                    rule.id === id
                      ? {
                          ...rule,
                          ...draft,
                          deleteReplacedFiles: draft.deleteReplacedFiles === true,
                          error: null,
                          status: ruleStatus(draft, state),
                        }
                      : rule
                  ),
                }
              : state
          );
        },
      }),
  };
}
