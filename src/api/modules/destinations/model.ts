import { t } from "elysia";
import { destinationIconNames } from "../../../types";

export const createDestinationSchema = t.Object({
  downloadPath: t.String({ maxLength: 4096, minLength: 1 }),
  icon: t.Optional(t.Enum([...destinationIconNames])),
  name: t.String({ maxLength: 80, minLength: 1 }),
  pinned: t.Optional(t.Boolean()),
});

export const updateDestinationSchema = t.Object({
  downloadPath: t.String({ maxLength: 4096, minLength: 1 }),
  icon: t.Optional(t.Enum([...destinationIconNames])),
  moveFiles: t.Optional(t.Boolean()),
  name: t.String({ maxLength: 80, minLength: 1 }),
  pinned: t.Optional(t.Boolean()),
});

export const destinationPresentationSchema = t.Object({
  icon: t.Optional(t.Enum([...destinationIconNames])),
  pinned: t.Optional(t.Boolean()),
});
