import { t } from "elysia";
import { source } from "../automation/model";

export const discoverySchema = t.Object({
  query: t.String({ maxLength: 1000 }),
  sources: t.Optional(
    t.Array(t.Union([t.Literal("nyaa"), t.Literal("tsundere"), t.Literal("c411")]), {
      maxItems: 3,
    })
  ),
});

export const addReleaseSchema = t.Object({
  destinationId: t.String(),
  id: t.String({ maxLength: 4096 }),
  paused: t.Boolean(),
  sourceId: source,
});
