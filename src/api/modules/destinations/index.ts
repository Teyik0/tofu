import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import {
  createDestinationSchema,
  destinationPresentationSchema,
  updateDestinationSchema,
} from "./model";

export const destinationsPlugin = new Elysia({ name: "tofu-destinations-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .post(
    "/destinations",
    {
      body: createDestinationSchema,
    },
    ({ application, body }) => application.engine.saveDestination(null, body)
  )
  .put(
    "/destinations/:id",
    {
      body: updateDestinationSchema,
    },
    ({ application, params, body }) => application.engine.saveDestination(params.id, body)
  )
  .patch(
    "/destinations/:id",
    {
      body: destinationPresentationSchema,
    },
    ({ application, params, body }) =>
      application.engine.updateDestinationPresentation(params.id, body)
  )
  .delete("/destinations/:id", async ({ application, params }) => {
    const result = await application.engine.removeDestination(params.id);
    application.automation.reassignDestination(result.removed);
    return result;
  });
