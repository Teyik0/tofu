import { t } from "elysia";

export const pluginConfigurationSchema = t.Object({
  apiKey: t.Optional(t.String({ maxLength: 4096 })),
  dailyLimit: t.Optional(t.Integer({ maximum: 100_000, minimum: 1 })),
  enabled: t.Boolean(),
});
