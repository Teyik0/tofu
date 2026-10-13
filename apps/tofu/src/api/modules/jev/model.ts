import { maxLength, minLength, object, pipe, string } from "valibot";

export const interpretationSchema = object({
  destinationId: string(),
  query: pipe(string(), minLength(1), maxLength(2000)),
});
