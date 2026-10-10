import { t } from "elysia";

export const dashboardQuerySchema = t.Object({
  detail: t.Optional(t.String()),
  selected: t.Optional(t.String()),
});
