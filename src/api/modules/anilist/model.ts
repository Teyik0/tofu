import {
  array,
  boolean,
  check,
  forward,
  integer,
  is,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  object,
  optional,
  partialCheck,
  picklist,
  pipe,
  string,
} from "valibot";
import { integerInput, numericInput } from "../../lib/validation";
import { draft, listStatus, organization, preferences } from "../automation/model";
import { updateDestinationSchema } from "../destinations/model";

export const mediaParamsSchema = object({
  mediaId: pipe(numericInput, integer(), minValue(1)),
});

export const episodeCompletionSchema = object({ completed: boolean() });

export const episodeParamsSchema = object({
  episode: pipe(numericInput, integer(), minValue(1), maxValue(10_000)),
  mediaId: pipe(numericInput, integer(), minValue(1)),
});

export const aniListPreferencesSchema = object({
  visibleStatuses: pipe(
    array(listStatus),
    maxLength(6),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
});

export const threadPreviewSchema = object({
  basePath: pipe(string(), minLength(1), maxLength(4096)),
  statuses: pipe(
    array(listStatus),
    minLength(1),
    maxLength(6),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
});

export const enabledSchema = object({ enabled: boolean() });

export const selectionSchema = object({
  enabled: boolean(),
  mediaIds: pipe(
    array(pipe(integerInput, integer(), minValue(1))),
    minLength(1),
    maxLength(500),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
});

export const aniListConfigurationSchema = object({
  clientId: optional(pipe(string(), maxLength(50))),
  clientSecret: optional(pipe(string(), maxLength(4096))),
  redirectUri: optional(
    pipe(
      string(),
      maxLength(500),
      check((value) => URL.canParse(value), "Enter a valid callback URL")
    )
  ),
  userName: pipe(string(), maxLength(100)),
});

export const authorizationCallbackSchema = object({ url: pipe(string(), maxLength(8192)) });

export const subscriptionSchema = object({
  enabled: boolean(),
  intervalMinutes: pipe(integerInput, integer(), minValue(5), maxValue(1440)),
  organization: optional(organization),
  statuses: pipe(
    array(listStatus),
    minLength(1),
    maxLength(6),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
  template: draft,
});

export const threadProposalSchema = object({
  destinationId: nullable(string()),
  downloadPath: updateDestinationSchema.entries.downloadPath,
  mediaId: pipe(integerInput, integer(), minValue(1)),
  name: pipe(string(), minLength(1), maxLength(500)),
});

export const trackingFormSchema = pipe(
  object({
    basePath: string(),
    custom: nullable(preferences),
    mode: picklist(["per-anime", "shared"]),
    proposals: nullable(pipe(array(threadProposalSchema), maxLength(500))),
    statuses: subscriptionSchema.entries.statuses,
  }),
  forward(
    partialCheck(
      [["mode"], ["basePath"]],
      (input) =>
        input.mode !== "per-anime" || is(threadPreviewSchema.entries.basePath, input.basePath),
      "Enter a root folder of at most 4096 characters"
    ),
    ["basePath"]
  )
);
