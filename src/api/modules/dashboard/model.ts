import { object, optional, string } from "valibot";

export const dashboardQuerySchema = object({
  detail: optional(string()),
  selected: optional(string()),
});
