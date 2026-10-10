import { t } from "elysia";

export const settingsSchema = t.Object({
  downloadLimit: t.Integer({ minimum: -1 }),
  downloadPath: t.String({ maxLength: 4096, minLength: 1 }),
  moveFiles: t.Optional(t.Boolean()),
  runInBackground: t.Optional(t.Boolean()),
  theme: t.Optional(t.Union([t.Literal("system"), t.Literal("light"), t.Literal("dark")])),
  uploadLimit: t.Integer({ minimum: -1 }),
});
