import { t } from "elysia";
import { draft, listStatus, organization } from "../automation/model";

export const mediaParamsSchema = t.Object({ mediaId: t.Numeric({ minimum: 1, multipleOf: 1 }) });

export const episodeCompletionSchema = t.Object({ completed: t.Boolean() });

export const episodeParamsSchema = t.Object({
  episode: t.Numeric({ maximum: 10_000, minimum: 1, multipleOf: 1 }),
  mediaId: t.Numeric({ minimum: 1, multipleOf: 1 }),
});

export const aniListPreferencesSchema = t.Object({
  visibleStatuses: t.Array(listStatus, { maxItems: 6, uniqueItems: true }),
});

export const threadPreviewSchema = t.Object({
  basePath: t.String({ maxLength: 4096, minLength: 1 }),
  statuses: t.Array(listStatus, {
    maxItems: 6,
    minItems: 1,
    uniqueItems: true,
  }),
});

export const enabledSchema = t.Object({ enabled: t.Boolean() });

export const selectionSchema = t.Object({
  enabled: t.Boolean(),
  mediaIds: t.Array(t.Integer({ minimum: 1 }), {
    maxItems: 500,
    minItems: 1,
    uniqueItems: true,
  }),
});

export const aniListConfigurationSchema = t.Object({
  clientId: t.Optional(t.String({ maxLength: 50 })),
  clientSecret: t.Optional(t.String({ maxLength: 4096 })),
  redirectUri: t.Optional(t.String({ maxLength: 500 })),
  userName: t.String({ maxLength: 100 }),
});

export const authorizationCallbackSchema = t.Object({ url: t.String({ maxLength: 8192 }) });

export const subscriptionSchema = t.Object({
  enabled: t.Boolean(),
  intervalMinutes: t.Integer({ maximum: 1440, minimum: 5 }),
  organization: t.Optional(organization),
  statuses: t.Array(listStatus, {
    maxItems: 6,
    minItems: 1,
    uniqueItems: true,
  }),
  template: draft,
});
