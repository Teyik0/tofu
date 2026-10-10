import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultAutomationPreferences, interpretLocally } from "../src/api/feeds/rules";
import { AutomationInbox } from "../src/components/automation-inbox";
import type { AutomationDecision, AutomationState } from "../src/types";

test("inbox download actions require an enabled rule and release source", () => {
  const state: AutomationState = {
    automations: [
      {
        ...interpretLocally("Example", "default", defaultAutomationPreferences),
        createdAt: 0,
        error: null,
        id: "rule",
        lastRunAt: null,
        nextRunAt: null,
        status: "active",
      },
    ],
    decisions: [
      {
        automationId: "rule",
        contentKey: "episode-1",
        createdAt: 0,
        deadline: null,
        id: "decision",
        probability: null,
        reason: "Confirmation required",
        release: {
          codec: null,
          downloadUrl: "magnet:?xt=urn:btih:example",
          episode: 1,
          id: "release",
          infoHash: null,
          language: null,
          pack: false,
          pageUrl: null,
          publishedAt: null,
          resolution: null,
          season: null,
          seeders: null,
          size: null,
          sourceId: "nyaa",
          title: "Example - 01",
          workTitle: "Example",
        },
        status: "review",
        torrentId: null,
      },
    ],
    plugins: [
      {
        callsToday: 0,
        checkedAt: null,
        dailyLimit: 0,
        description: "Anime releases",
        enabled: true,
        error: null,
        hasApiKey: false,
        id: "nyaa",
        name: "Nyaa",
      },
    ],
    preferences: defaultAutomationPreferences,
    updatedAt: 0,
  };
  const [rule] = state.automations;
  const [decision] = state.decisions;
  const [plugin] = state.plugins;
  if (!(rule && decision && plugin)) {
    throw new Error("Missing inbox fixture");
  }
  for (const status of ["review", "waiting", "error"] satisfies AutomationDecision["status"][]) {
    decision.status = status;
    for (const [ruleEnabled, sourceEnabled] of [
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      rule.enabled = ruleEnabled;
      plugin.enabled = sourceEnabled;
      const html = renderToStaticMarkup(
        createElement(AutomationInbox, {
          approve: () => undefined,
          busy: false,
          destinations: [],
          ignore: () => undefined,
          openRules: () => undefined,
          state,
        })
      );
      const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g);
      expect(buttons?.[0]?.includes('disabled=""')).toBe(!(ruleEnabled && sourceEnabled));
      expect(buttons?.[1]?.includes('disabled=""')).toBe(false);
    }
  }
});
