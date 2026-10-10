import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { runtime } from "../../lib/runtime";
import { services } from "../../lib/services";
import {
  createDestinationSchema,
  destinationPresentationSchema,
  updateDestinationSchema,
} from "./model";

export const destinations = new Elysia({ name: "tofu-destinations-api" })
  .use(furinSync(sync))
  .guard({ sync: false })
  .post(
    "/destinations",
    {
      body: createDestinationSchema,
    },
    ({ body }) => services.engine.saveDestination(null, body)
  )
  .put(
    "/destinations/:id",
    {
      body: updateDestinationSchema,
    },
    ({ params, body }) => services.engine.saveDestination(params.id, body)
  )
  .patch(
    "/destinations/:id",
    {
      body: destinationPresentationSchema,
    },
    ({ params, body }) => services.engine.updateDestinationPresentation(params.id, body)
  )
  .delete("/destinations/:id", async ({ params }) => {
    const result = await services.engine.removeDestination(params.id);
    runtime.automation?.reassignDestination(result.removed);
    return result;
  });
