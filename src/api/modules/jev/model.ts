import { t } from "elysia";

export const interpretationSchema = t.Object({
  destinationId: t.String(),
  query: t.String({ maxLength: 2000, minLength: 1 }),
});
