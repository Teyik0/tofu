import "@teyik0/furin/server-only";
import { Context } from "effect";
import { Elysia } from "elysia";
import { databasePlugin, services } from "../../lib/services-runtime";
import { accessPlugin } from "../access/plugin";
import { Libraries } from "./service";

export const linkedLibrariesServicePlugin = new Elysia({ name: "tofu-linked-libraries-service" })
  .use(databasePlugin)
  .use(accessPlugin)
  .decorate("linkedLibraries", Context.get(services, Libraries));
